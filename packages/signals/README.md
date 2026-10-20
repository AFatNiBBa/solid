# `newest()`: read your own writes before the flush

`@seanalunni/signals` is a fork of `@solidjs/signals` that adds a single function, `newest()`. Everything else behaves exactly like Solid 2.0. This page explains the problem it solves, which comes from a change in how Solid 2.0 handles updates, and how to use it.

For everything else (the API, the concepts, the examples), see the [original `@solidjs/signals` README](https://github.com/solidjs/solid/blob/next/packages/signals/README.md).

## The problem

### In Solid 2.0, a write is not visible right away

In Solid 1.x, a setter took effect immediately:

```js
// Solid 1.x
setCount(1);
count(); // 1
```

In Solid 2.0, writes are **batched until the next microtask**. Until then, every read returns the old value:

```js
// Solid 2.0
setCount(1);
count();   // 0, still the old value
double();  // 0, memos too
// ...at the next microtask (or when you call flush()) everything updates
count();   // 1
```

Applying the queued writes is called the **flush**. It happens automatically at the next microtask, or right away if you call `flush()`: the two are the same operation. The DOM and effects update during the flush, and so do plain reads.

Below, a **tick** means all the writes made between one flush and the next, whether that flush is the automatic one at the microtask or a `flush()` you call yourself. A manual `flush()` ends the current tick: writes made after it belong to the next one.

### Why Solid 2.0 works this way

Solid 2.0 wants what you read to always match what is on screen. Async data is the reason. In 2.0 any memo can be async, and when a change needs data that hasn't arrived yet, Solid **holds** the whole change instead of showing half of it:

```jsx
const [id, setId] = createSignal(1);
const user = createMemo(() => fetchUser(id())); // async

<h1>User {id()}</h1>
<p>{user().name}</p>
```

After `setId(2)`, showing "User 2" immediately would put the name of user 1 under it until the fetch answers. Instead, Solid keeps the whole screen on user 1 and switches everything together when `fetchUser(2)` lands. While the change is held, `id()` keeps returning `1`, even after the flush, because that is what the screen shows. Two existing functions let you look past the hold:

- `latest(id)` returns `2`: the value that is coming.
- `isPending(id)` returns `true`: the screen is waiting for it.

Some details aren't obvious from the outside:

- **What makes a change held:** a hold only happens when the screen would need async data that hasn't arrived. A render effect (the DOM, typically) must read it outside a `<Loading>` boundary. Async data that only another memo or a `createEffect` reads causes no hold.
- **Writes in the same tick are held together:** a hold covers every write made since the last flush, not only the related ones. If you write `id` and an unrelated `title` in the same event handler, `title` waits for `fetchUser` too. Writes made in different ticks are independent, so calling `flush()` between the two writes is enough to keep `title` out of the hold.
- **How long it lasts:** a hold lasts until the async data arrives, which can be seconds. It does not end with the microtask.
- **Actions:** an `action` holds its writes until its body has finished, and also takes the other writes of the tick it starts in.

### What was missing

Imperative code (event handlers, form logic, integrations with other libraries) often needs to read back what it just wrote, or a value derived from it:

```js
function addItem(item) {
  setItems(list => [...list, item]);
  if (total() > limit) { /* total() is still the OLD total */ }
}
```

In 2.0 your options were:

- **`flush()`:** it applies everything. Every memo affected by any pending write is recomputed, the DOM is updated and effects run, even if you only needed one value. And if the change is held, plain reads still return the old value afterwards.
- **`latest(x)`:** it looks past holds, but it does not see writes that haven't been flushed yet. Right after `setItems(...)`, `latest(total)` still returns the old total.
- **Solid 1.x's `batch`:** inside a batch, the DOM and effects waited until the end, but reading a signal or a memo gave you the new value, recomputing only what you read. Solid 2.0 removed `batch`, and nothing replaced that behavior.

## The solution: `newest()`

`newest(fn)` runs `fn` and returns its result, computed from the **most recent** value of everything it reads:

```js
import { newest } from "@solidjs/signals";

function addItem(item) {
  setItems(list => [...list, item]);
  if (newest(total) > limit) { /* the NEW total */ }
}
```

It works like a read inside 1.x `batch`:

- **Written signals:** they return their new value right away, before the flush.
- **Memos:** a memo affected by those writes is recomputed **on the spot**. Only that memo is recomputed, together with the memos it depends on; unrelated memos, components and the DOM are not touched.
- **Effects:** nothing runs. Effects and the DOM still update only at the flush.
- **The flush:** it doesn't redo the work. A memo that `newest()` already brought up to date is not recomputed again at the flush.

```js
const [a, setA] = createSignal(0);
const b = createMemo(() => a() + 1);

setA(1);
newest(a);  // 1
newest(b);  // 2, recomputes b only
a();        // 0, plain reads are unchanged
b();        // 1
// at the flush: effects run, b is not recomputed a second time
```

`newest` accepts any function, like `latest`, so you can read several values in one call:

```js
const { name, total } = newest(() => ({ name: user.name, total: total() }));
```

### `newest` also looks past holds

If the screen is holding a change, `newest` returns the written value anyway, like `latest` does:

```js
setId(2);
flush();      // the screen holds the change while fetchUser(2) is in flight
id();         // 1, what the screen shows
latest(id);   // 2
newest(id);   // 2
```

One way to remember it: **`newest(x)` returns the same value that a functional setter would receive as `prev`**. In `setX(prev => ...)`, `prev` always includes your own writes, held or not.

### `newest`, `latest` and plain reads

| | plain read `x()` | `latest(x)` | `newest(x)` |
|---|---|---|---|
| a write not flushed yet | old value | old value | **new value** |
| a memo affected by such a write | old value | old value | **recomputed now** |
| a change held by the screen (after the flush) | old value | new value | new value |
| an optimistic write (`createOptimistic`) | from the flush | from the flush | **right away** |
| an async memo whose new answer is in flight | last value | last value | last value |

### Stores

`newest` works with stores the same way:

```js
setStore(s => {
  s.list.push(item);
  delete s.draft;
});

store.list.length;                    // old length, until the flush
newest(() => store.list.length);      // new length
newest(() => "draft" in store);       // false
newest(() => Object.keys(store));     // without "draft"
```

### Why a separate function, and not plain reads

The obvious alternative was to change plain reads themselves, so that `count()` returns the new value right after `setCount(...)`, as in 1.x `batch`. That doesn't work well with holds, and `newest` exists because of that:

- **A plain read must match what you will read after the flush.** If `count()` returned the new value before the flush, and the flush then held the change, `count()` would go back to the old value until the async data arrived: new, then old, then new again.
- **Knowing whether the flush will hold a change is expensive.** A hold depends on what is *downstream* of the value: whether something that depends on it is async, and whether the screen reads it. To answer correctly, a read before the flush would have to recompute everything that depends on the value, async memos included (starting their fetches), and see what the screen would wait for. Since writes of the same tick are held together, it would also have to do this for the unrelated writes of the tick.
- **That is exactly the work you avoid by not calling `flush()`.** A read would no longer cost "this value and what it depends on", but potentially a large part of the app.

`newest` sidesteps the problem by not caring about holds: it always returns the written value. It only has to look *upstream* (what the value depends on), which is cheap. And the meaning of plain reads, `latest` and `isPending` stays the same as in Solid 2.0.

## Things to know

- **`newest` is for code, not for the screen.** For what you render, keep using plain reads. They are what keeps the screen consistent: they never show a write that the screen is still holding. `newest` deliberately ignores that guarantee.
- **Async memos return their last value.** If a write makes an async memo fetch again, `newest(thatMemo)` returns the value it had before, because the new one hasn't arrived. This is the same as `latest`. So in a single `newest()` call, sync values can already be new while async ones are still old.
- **Reading can start work earlier.** If the memo that `newest` recomputes starts a fetch, the fetch starts when you read, not at the next flush. The request is the same one the flush would have made, made a moment earlier.
- **Inside memos and effects** `newest` behaves like `latest`: it is tracked, so the computation re-runs when the values change.
- **`flush()` is still the way to update the DOM.** If you need to measure an element or move focus right after a write, call `flush()` as usual. `newest` doesn't touch the DOM.
- **Nothing else changes.** Plain reads, `latest`, `isPending`, holds, `<Loading>` and actions behave exactly as in Solid 2.0.

## Using it in an app

`solid-js` re-exports a fixed list of functions from `@solidjs/signals`, and `newest` isn't in it. So you import it from the signals package directly:

```js
import { newest } from "@solidjs/signals";
```

`solid-js` and your import must use **the same copy** of the signals package. Two copies would mean two separate reactive systems, and `newest` would not see your signals. Make your package manager resolve `@solidjs/signals` to this fork everywhere, `solid-js`'s own dependency included, with an override in your app's `package.json`:

```json
{
  "overrides": {
    "@solidjs/signals": "npm:@seanalunni/signals@2.0.0-rc.15.newest.1"
  }
}
```

With pnpm the field is `pnpm.overrides`, and with Yarn it is `resolutions`. The version must match the `solid-js` release you use: each fork release is based on the `@solidjs/signals` release of the same version.

The override is why the import above still says `@solidjs/signals`: that name now resolves to the fork, for your code and for `solid-js` alike.

**Don't add `@seanalunni/signals` as a dependency and import from it.** With npm and Yarn, the package manager would then install the fork twice: once as `node_modules/@solidjs/signals` (the override, used by `solid-js`) and once as `node_modules/@seanalunni/signals` (used by your import). Your bundler sees two different paths and loads two separate instances of the same code, each with its own internal state: its own flush queue, its own current owner, its own read flags. Then:

- your signals are created through `solid-js` (`createSignal`, `createMemo`, …), so they live in the first copy;
- `newest` comes from the second copy, which opens its read window in its own state;
- when `newest` reads one of your signals, the code that runs is the first copy's, which knows nothing about that window.

The result is that `newest(a)` behaves like a plain read and returns the old value, with no error to warn you.

pnpm installs each package only once and links to it, so there the two names can end up pointing to the same folder and the copy stays one. Whether that happens depends on the package manager and on your bundler's settings, though, so don't rely on it: always import from `@solidjs/signals` and let the override point it to the fork.
