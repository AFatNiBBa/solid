# Solid (fork of solidjs/solid)

Working copy of the SolidJS monorepo. The active line of work is **Solid 2.0** on the `next` branch (`2.0.0-rc.x`); `main` is still 1.9.x and has a completely different codebase.

## Layout (branch `next`)
pnpm + turbo monorepo, ~140k LOC:
- `packages/signals` (`@solidjs/signals`): the reactive engine (height-ordered heap, microtask batching, split effects, async via `NotReadyError`, transactions/holds, optimistic lanes, stores, boundaries). Internal rules are numbered and cited in code: F-n (`docs/RULES-FUNDAMENTALS.md`), A-n (`docs/SPEC-ASYNC-SEMANTICS.md`), D-n (`docs/RULES-DERIVED.md`); best current summary of the hold model is `docs/INTERNALS-ASYNC-STATE.md` §0
- `packages/solid` (`solid-js`): re-exports signals, adds components/flow control/context/lazy and hydration wrappers. `src/server/signals.ts` is a **separate pull-based reimplementation** for SSR, kept in parity by tests, not shared code
- `packages/web` (`@solidjs/web`): DOM runtime + hydration (`src/client.ts`), SSR/streaming (`src/server.ts`), serialization (seroval), server functions, frames (experimental server components)
- `packages/babel-plugin`: reference JSX compiler. `packages/compiler`: Rust/Oxc port held to parity with differential tests (`__tests__/parity/`)
- `packages/{h,html,universal,element,diagnostics}`: hyperscript, tagged templates, custom renderers, web components, diagnostics harness
- Every package builds in three tiers (`dev`, `observe`, `prod`) by replacing the `"_SOLID_DEV_"` / `"_SOLID_OBSERVE_"` literals

## Fork changes (goal: publish a modified `@solidjs/signals` to npm)
- Published as `@seanalunni/signals` (npm user `seanalunni`). Inside the monorepo every package still imports `@solidjs/signals`: `pnpm-workspace.yaml` overrides it with `workspace:@seanalunni/signals@*` (an alias to the local package). Apps use it the same way, with an `overrides` entry `"@solidjs/signals": "npm:@seanalunni/signals@<version>"`, so `solid-js` and the app share one copy. Tests that import the package by its own name read it from `package.json` (`tests/dist-artifacts.test.ts`)
- `newest(fn)` (`packages/signals/src/core/verdict.ts`, exported from the package entry): reads like inside 1.x `batch` — unflushed writes are visible and a memo they reach is recomputed on the spot (only it and its sources, `pullUnflushed` in core.ts), skipping holds too; no effect runs before the flush. It is the writer's view (a functional setter's `prev`, unflushed optimistic guesses included). Plain reads, `latest` and `isPending` keep the upstream semantics (A28/F-10). Tests: `tests/newest.test.ts`. User-facing explanation (for Solid users, not engine developers): `packages/signals/NEWEST.md`, keep it in sync. Fork code is marked with `FORK` comments
- Rejected alternative: making every plain read batch-like. Holds made it inconsistent: a read before the flush could show the write and the flush could then hold it (value flickering back), and predicting a hold needs computing everything downstream, async included. Upstream also groups holds per flush, not per dependency tree: writes of the same tick are held together

## Where to read first
- `documentation/solid-2.0/MIGRATION.md` and `packages/solid/CHEATSHEET.md`: the 2.0 API at a glance
- `documentation/solid-2.0/NN-*.md`: per-topic RFCs (reactivity, stores, async, actions, DOM, diagnostics, server functions, server components, SSR)
- `documentation/server-components/`, `documentation/plans/`, `documentation/proposals/`: design notes
- Some docs are stale (e.g. `packages/signals/docs/QUEUE_EXECUTION_CONTROL.md`, `INTERNALS-ASYNC-STATE.md` §1–4, file paths in `frame-streams-rfc.md`): trust the code when they disagree

## Commands (root)
- pnpm is not installed globally and Node 25 has no corepack: run it as `npx -y pnpm@11.1.1 ...` (the version pinned in `packageManager`). Nested `pnpm` calls inside scripts work because pnpm puts itself on the PATH of the scripts it runs
- `pnpm install` (pnpm only, enforced by `preinstall`; it also installs a `pre-commit` git hook via `simple-git-hooks`)
- `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm test:integration`
- Per package: `pnpm --filter <name> test`, or run the script from the package folder
- `packages/signals`: `build` (rollup → `dist/{dev*.js,prod,observe}`, then `tsc` → `dist/types`), `test` (vitest), `pnpm pack --dry-run` to check the tarball

## Windows quirks (CI runs on ubuntu with Node 24)
- `rimraf` 5 doesn't expand globs on Windows without `--glob`: added to `packages/signals` `build:clean` (other packages may need the same)
- Git for Windows ships `core.autocrlf=true` system-wide, but scripts and tests split on `\n`: `.gitattributes` has `* text=auto eol=lf` so every clone checks out LF (the one file committed with CRLF upstream is excluded with `-text`). Git reads `.gitattributes` from the index during checkout, so a change to it only applies to a working tree re-checked out after it is committed or staged
- The signals suite passes on Windows after these fixes (keep them in mind when writing new tests/scripts): `scripts/rules-index.mjs` normalizes paths to `/` (the generated RULES-INDEX.md and the module → namespace regexes depend on it), `tests/treeshake.test.ts` normalizes Rollup ids and roots with `toPosix`, `tests/dist-artifacts.test.ts` passes bundles to `node` via stdin instead of `-e` (command-line limit, `ENAMETOOLONG`)
- Mass-deleting tracked files makes VS Code's git extension grab `.git/index.lock`: git commands run right after may fail with "index.lock: File exists" and need a retry
- Outside signals, more tests and builds break only on Windows (not investigated further): `packages/solid` `published-declarations.spec.ts` (3 tests) and `cross-package-fields.spec.ts` (needs `packages/web/dist`); `packages/web` `build` fails in `types:copy-jsx`, which `spawnSync`s `prettier` without a shell (on Windows the binary is `prettier.cmd`). `packages/solid` tests also need `pnpm types` run first (turbo does it in CI)
- Rollup prints TypeScript errors from a test file (`tests/store/derived-presence-async-3726.test.ts`) during `build:js`: they don't fail the build

## How to work
- Check which branch you are on before changing anything: `main` and `next` share almost nothing
- Git is managed by the user: no commits, branch switches, merges or pushes unless asked
- This is a fork of a public upstream: anything outward-facing (PRs, issues, comments on solidjs/solid) needs explicit confirmation
- When unsure about behavior, look for the issue-numbered regression tests (`#NNNN` in test names and comments): they usually explain why the code is the way it is
- **Update this file** whenever you learn something non-obvious about the project that isn't already written here: conventions, deliberate choices, the user's explanations, traps. Keep it concise and in the same format
