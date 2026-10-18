/**
 * FORK: `newest(fn)` reads `fn` as the writer sees it — ahead of the flush
 * and of any hold — like a read inside 1.x `batch`: the written signals serve
 * their new value and a memo they reach is brought current on the spot (that
 * memo and what it depends on only); nothing else recomputes and no effect
 * runs until the flush. Plain reads, `latest` and `isPending` are untouched
 * (A28 still holds for them).
 */
import { describe, expect, it } from "vitest";
import {
  action,
  createEffect,
  createMemo,
  createOptimistic,
  createRenderEffect,
  createRoot,
  createSignal,
  createStore,
  flush,
  isPending,
  latest,
  newest
} from "../src/index.js";

/** A signal whose write is held by an async memo a render effect observes. */
async function heldSetup(initial = 10) {
  let resolve!: (v: number) => void;
  const fetch = (n: number) =>
    new Promise<number>(r => {
      resolve = r;
    });
  const [count, setCount] = createSignal(initial);
  let double!: () => number;
  createRoot(() => {
    double = createMemo(() => count() * 2);
    const data = createMemo(() => fetch(count()));
    createRenderEffect(
      () => data(),
      () => {}
    );
  });
  flush();
  resolve(initial);
  await new Promise(r => setTimeout(r, 0));
  flush();
  return { count, setCount, double, settle: (v: number) => resolve(v) };
}

describe("newest", () => {
  it("serves an unflushed write; plain reads wait for the flush", () => {
    const [a, setA] = createSignal(0);
    flush();
    setA(1);
    expect(newest(a)).toBe(1);
    expect(a()).toBe(0);
    expect(latest(a)).toBe(0);
    flush();
    expect(a()).toBe(1);
    expect(newest(a)).toBe(1);
  });

  it("brings only the memo read (and its sources) current, runs no effect before the flush", () => {
    const runs = { b: 0, c: 0, unrelated: 0, effect: 0 };
    const [a, setA] = createSignal(0);
    const [x, setX] = createSignal(0);
    let b!: () => number, c!: () => number;
    createRoot(() => {
      b = createMemo(() => (runs.b++, a() + 1));
      c = createMemo(() => (runs.c++, b() * 10));
      createMemo(() => (runs.unrelated++, x()));
      createEffect(c, () => {
        runs.effect++;
      });
    });
    flush();
    expect(runs).toEqual({ b: 1, c: 1, unrelated: 1, effect: 1 });

    setA(1);
    setX(1);
    expect(newest(b)).toBe(2);
    expect(runs).toEqual({ b: 2, c: 1, unrelated: 1, effect: 1 });
    expect(newest(c)).toBe(20);
    expect(runs).toEqual({ b: 2, c: 2, unrelated: 1, effect: 1 });
    // Plain reads stay on the flushed value (#3009 purity).
    expect(b()).toBe(1);
    expect(c()).toBe(10);

    flush();
    // The flush commits what the pulls staged without recomputing it again.
    expect(runs).toEqual({ b: 2, c: 2, unrelated: 2, effect: 2 });
    expect(c()).toBe(20);
  });

  it("follows every write of the tick, as a functional setter's prev", () => {
    const [s, setS] = createSignal(10);
    const double = createRoot(() => createMemo(() => s() * 2));
    flush();
    setS(v => v + 1);
    expect(newest(s)).toBe(11);
    expect(newest(double)).toBe(22);
    setS(v => v + 1);
    expect(newest(s)).toBe(12);
    expect(newest(double)).toBe(24);
    flush();
    expect(s()).toBe(12);
    expect(double()).toBe(24);
  });

  it("works inside a tracked computation", () => {
    const [a, setA] = createSignal(1);
    const seen: number[] = [];
    createRoot(() => {
      createEffect(
        () => newest(a),
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    setA(2);
    flush();
    expect(seen).toEqual([1, 2]);
  });

  it("skips a hold: newest is the written value while plain reads keep the screen", async () => {
    const { count, setCount, double, settle } = await heldSetup(10);
    setCount(20);
    expect(newest(count)).toBe(20);
    expect(newest(double)).toBe(40);
    flush(); // held by the fetch
    expect(count()).toBe(10);
    expect(double()).toBe(20);
    expect(isPending(count)).toBe(true);
    expect(latest(count)).toBe(20);
    expect(newest(count)).toBe(20);
    expect(newest(double)).toBe(40);
    // A rewrite of the held node: newest serves it at once, latest at the flush.
    setCount(30);
    expect(newest(count)).toBe(30);
    expect(latest(count)).toBe(20);
    flush();
    settle(30);
    await new Promise(r => setTimeout(r, 0));
    flush();
    expect(count()).toBe(30);
    expect(newest(count)).toBe(30);
  });

  it("an independent write of the same tick reads new even if the tick is held", async () => {
    const { setCount } = await heldSetup(10);
    const [a, setA] = createSignal(0);
    const b = createRoot(() => createMemo(() => a() + 1));
    flush();
    setA(1);
    setCount(20);
    expect(newest(a)).toBe(1);
    expect(newest(b)).toBe(2);
  });

  it("serves an async memo's last value while its new answer is in flight", async () => {
    let resolve!: (v: number) => void;
    const [id, setId] = createSignal(1);
    const data = createRoot(() =>
      createMemo(() => {
        const v = id();
        return v === 1 ? v * 100 : new Promise<number>(r => (resolve = r));
      })
    );
    flush();
    expect(data()).toBe(100);
    setId(2);
    expect(newest(data)).toBe(100);
    flush();
    resolve(200);
    await new Promise(r => setTimeout(r, 0));
    flush();
    expect(newest(data)).toBe(200);
  });

  it("stores: values, length, keys and presence of an unflushed batch", () => {
    const [store, setStore] = createStore<{
      a: number;
      list: number[];
      o: Record<string, number>;
    }>({ a: 1, list: [1, 2], o: { x: 1 } });
    const total = createRoot(() => createMemo(() => store.a * 10));
    flush();
    setStore(s => {
      s.a = 2;
      s.list.push(3);
      s.o.y = 2;
      delete s.o.x;
    });
    expect(newest(() => store.a)).toBe(2);
    expect(newest(total)).toBe(20);
    expect(newest(() => store.list.length)).toBe(3);
    expect(newest(() => store.list.join())).toBe("1,2,3");
    expect(newest(() => Object.keys(store.o))).toEqual(["y"]);
    expect(newest(() => "x" in store.o)).toBe(false);
    // Plain reads wait for the flush.
    expect(store.a).toBe(1);
    expect(store.list.length).toBe(2);
    flush();
    expect(store.a).toBe(2);
    expect(store.list.length).toBe(3);
  });

  it("serves an optimistic write before the flush, as the optimistic updater sees it", async () => {
    let release!: () => void;
    const [name, setName] = createOptimistic("Alice");
    flush();
    const save = action(function* (next: string) {
      setName(next);
      expect(newest(name)).toBe(next);
      yield new Promise<void>(r => (release = r));
    });
    const done = save("Bob");
    expect(newest(name)).toBe("Bob");
    flush();
    expect(name()).toBe("Bob");
    release();
    await done;
    flush();
  });
});
