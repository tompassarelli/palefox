# CLAUDE.md — palefox project guide

This file is loaded into Claude's context for every conversation in this repo.
Keep it short, current, and oriented toward "what would help me NOT make the
same mistake twice."

---

## What palefox is

A chrome-privileged userscript bundle that runs inside Firefox via
[fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig). It rewrites the
sidebar to host a tree-tab panel with vim keybindings, plus drawer-level chrome
restructuring (compact mode, urlbar relocation, etc.).

Scripts run in the browser's privileged scope — they touch `gBrowser`,
`Services`, `ChromeUtils`, raw XUL elements, etc. They do NOT run in a normal
web page sandbox.

## Repo layout

```
src/tabs/        palefox-tabs.uc.js — sidebar tree-tab panel
  index.ts         orchestrator (wires factories, owns init)
  vim.ts           keymap, ex-mode, picker, search, blacklist
  rows.ts          row DOM creation / sync / visibility (factory)
  drag.ts          drag-and-drop (factory)
  layout.ts        panel positioning (factory)
  menu.ts          context menu (factory)
  events.ts        TabOpen/Close/Move/Select wiring
  history.ts      SQLite temporal substrate (events, sessions, retention)
  snapshot.ts      tree → envelope helpers + makeSaver
  content-focus.ts cross-process editable-element detection bridge
  helpers.ts       pure tree walks (treeData, levelOf, subtreeRows, …)
  state.ts         shared mutable singletons + WeakMaps
  types.ts         Tab, TreeData, Group, Row, SavedNode
  constants.ts     INDENT, CHORD_TIMEOUT, etc.
  log.ts           createLogger() — pfx.debug-gated
  *.test.ts        Tier 1 unit tests (bun test)

src/drawer/      palefox-drawer.uc.js — chrome restructuring
  index.ts         @ts-nocheck'd legacy orchestrator (layout, button/menu, banner)
  compact.ts       compact-mode state machine (factory)
  urlbar.ts        floating urlbar + Ctrl+J/K suggestion nav (factory)

src/types/chrome.d.ts   ambient chrome globals + DOM augmentation
src/hello/              smoke-test stub

chrome/
  JS/*.uc.js              BUILT — do NOT hand-edit
  palefox.css             core theme + aggregator (@imports sub-files)
  palefox-<name>.css      per-area sheets
  userChrome.css          Firefox entry point (only imports palefox.css + user.css)
  user.css                user-owned, not overwritten

docs/dev/                cross-session context — see docs/dev/README.md
docs/                    user-facing site + docs

build.config.ts / build.ts   entry list + bun build wrapper
tests/integration/<area>.ts  Tier 3 Marionette suites
tools/test-driver/           Marionette runner, profile setup
```

`chrome/JS/*.uc.js` are generated; edit `src/` and `bun run build`.

**[docs/dev/](docs/dev/README.md) is the source of truth for cross-session
context.** Plans, architectural rationale, post-mortems, and dissertations
live there — read the relevant file end-to-end before starting related
work. Don't try to recover this from chat history.

## Workflow

```bash
bun run dev         # build + watch (Bun's --watch on the build script)
bun run build       # one-shot production build
bun run typecheck   # tsc --noEmit (do this before committing big edits)
bun test            # pure-function unit tests (Tier 1 — see docs/dev/testing.md)
```

`bun run dev` is the default loop. After edits, the `.uc.js` is rebuilt; reload
Firefox to test. **Type errors do NOT fail the build** (`bun build` doesn't
typecheck) — run `bun run typecheck` separately. Editor tsserver also runs.

### Testing strategy

Palefox's test infrastructure is built in tiers. **Read
[`docs/dev/testing.md`](docs/dev/testing.md) end-to-end before doing
test-related work** — it's the source of truth for the plan, the sprint
checklist, and the guiding principles. Quick orientation:

- **Tier 1** (live): `bun test src/` — pure-function unit tests (persist, helpers)
- **Tier 2** (live): happy-dom-backed mocks of chrome globals — compact state machine
- **Tier 3** (live): real Firefox via Marionette — `bun run test:integration`
- **Tier 4** (live): the autonomous AI iteration loop — see below

### AI iteration loop (Tier 3 + 4)

When you change `src/drawer/`, `src/tabs/`, or anything that affects runtime
behavior, **run the integration tests yourself** instead of asking the user
to reload Firefox.

```bash
bun run test:integration              # build + headless Firefox + all tests
bun run test:integration -- --grep X  # filter by test-name substring
bun run test:integration -- --verbose # pipe Firefox stderr to terminal
```

Output is one JSON event per line on stdout (`test:start`, `test:pass`,
`test:fail` with `error`/`stack`, final `summary`). Test files live at
`tests/integration/<area>.ts` and default-export an array of
`{ name, run(mn) }` — `run` gets a chrome-context Marionette client.

Loop: edit code → write/extend test → `bun run test:integration` → read
JSON → iterate. Same loop for regressions, just lead with the run.

Fall back to "ask user to reload" only for non-headless surfaces:
visible-window CSS, real-cursor hover with synthesized inputs, native
input methods. `#sidebar-button` is an example (doesn't exist headless).
For everything else, the runner is faster and more reproducible.

The sprint checklist in [docs/dev/testing.md](docs/dev/testing.md) is the
single tracking source — update it as work lands, don't fork tracking into
chat or commit messages.

### Firefox upstream stability

Palefox treats Firefox internals as an unstable ABI. Every chrome-API
dependency we have is enumerated in
[docs/dev/firefox-upstream-stability.md](docs/dev/firefox-upstream-stability.md)
(architecture + doctrine) and tracked in
[docs/dev/firefox-stability-roadmap.md](docs/dev/firefox-stability-roadmap.md)
(the milestone TODO file). Operating rules:

- **New chrome-API calls go through `src/firefox/<adapter>.ts`** —
  feature code imports typed primitives, never touches `gBrowser` /
  `Services` / `gURLBar` directly. `src/firefox/tabs.ts` is the
  reference example. Existing call sites are migrated opportunistically
  when their containing module is touched; no big-bang rewrites.
- **Run `bun run firefox:canary` before each release** and after any
  upstream pull. It diffs the Firefox source files we cite against the
  pinned revision (`tools/firefox-pin.json`) and tells you exactly
  which Tier 3 tests to re-run.
- **When you touch a new chrome API, add it to the manifest** in
  `tools/firefox-canary.ts`. Stability bucket + source path + symbols +
  tests + failure mode. Each entry pays for itself the first time
  Firefox upstream moves it.
- **Anti-goals** — don't model XPCOM in TypeScript, don't build a
  per-channel test matrix, don't target Firefox ESR. See the strategy
  doc for why.

### Cross-process / new-Firefox-API work — TDD is mandatory

When the change involves the e10s boundary, IPC primitives (frame scripts,
JSWindowActor, message manager), or any Firefox internal you haven't used
in this repo before, the order is:

1. **Read the IDL / Firefox source first.** `~/code/firefox/` is on disk.
   Look up the actual interface (`*.webidl`, `*.idl`, `*.sys.mjs`) and the
   eslint env file (`tools/lint/eslint/eslint-plugin-mozilla/lib/environments/`)
   to know what globals exist in your target scope. Don't guess from "it's
   chrome-like" or "it's content-like" — those scopes have specific,
   enumerated globals that aren't a superset of either.
2. **Write the Tier 3 test that asserts the contract.** Pin the exact
   observable behavior — message arrives, attribute flips, function returns
   true — before the implementation that makes it pass exists.
3. **Implement. `bun run test:integration` until green.**
4. **Only then ship to the user.**

If the test substrate doesn't exist for the surface yet, the first PR is
the substrate. Skipping these steps is what produced the v0.40.0
content-focus regression — see [docs/dev/postmortem-content-focus.md](docs/dev/postmortem-content-focus.md)
for the full failure trace. Heuristic-first ("content has focus, bail")
beats reading the IDL by ~5 lines of code and costs ~90 minutes of user
frustration when the heuristic is wrong.

### Dev feedback loop (when integration tests don't apply)

Reloading Firefox is the user's expensive step, not yours. When you can't
exercise the bug from the integration runner, the loop is: code change →
add `pfx.debug` logging on every branch your change touches (CSS-only
fixes too: log `getComputedStyle()` for the affected elements) → user
reloads, performs the action, signals tested → **you read the log
yourself** and course-correct.

Infra:

- **`createLogger("scope")`** in `src/tabs/log.ts` — no-op when
  `pfx.debug` is false; otherwise writes timestamped lines to
  `<profile>/palefox-debug.log` AND console. Wrap in a `dbg(event, data)`
  helper for fixed payloads — see `src/drawer/compact.ts`.
- **Profile path on this machine:** `~/.mozilla/firefox/tom/` (confirm via
  `profiles.ini` if uncertain). Read `palefox-debug.log` directly.
- **`docs/dev/chrome-reference/dump-chrome-dom.js`** — paste into Browser
  Console to dump chrome DOM (id / class / hidden / computed-style) to
  `~/chrome-dom.txt`. Use when stacking-context or hidden-ancestor is in
  play.

Ask the user to inspect only if wiring the logging yourself is blocked
(unreachable shadow root, state you can't trigger from JS).

**Coverage expectation:** every load-bearing path gets `pfx.debug`-gated
logging. Cheap when off, indispensable when on. Add it as part of the
change, not a follow-up.

## Conventions

### File structure

We have three kinds of TS module. Each has its own natural shape — don't
force the wrong shape on the wrong kind of module.

**1. Factory modules (the common case for >150-line files).** A module that
exposes a curated API backed by private state. This is the shape for
`drag.ts`, `rows.ts`, `layout.ts`, `menu.ts`, `events.ts`, `vim.ts`,
`persist.ts`, `drawer/compact.ts`. **Required layout:**

```typescript
// File-level header — what this module is, public exports, gotchas.

import statements
declare const … any chrome globals used

// =============================================================================
// INTERFACE
// =============================================================================

export type … // public types
export type FooDeps = { … };
export type FooAPI = { … };

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function makeFoo(deps: FooDeps): FooAPI {
  // private state
  let internal = …;
  // private functions
  function helper() { … }
  // public functions
  function publicOne(…) { … }
  return { publicOne, … };
}
```

The INTERFACE/IMPLEMENTATION split is *load-bearing* for factory modules —
readers should be able to grok the surface area in 10 seconds without
scrolling through 800 lines of internals.

**2. Utility / pure-function modules** (`helpers.ts`). Every export IS the
interface; there's no curated API to separate from internals. Skip the
INTERFACE/IMPLEMENTATION markers. Use thematic subsections (e.g. helpers.ts
has `// === SessionStore ===`, `// === Tab tree metadata ===`, `// === Row
walks ===`) so readers can scan related exports together.

**3. Orchestrator / entry-point modules** (`tabs/index.ts`,
`drawer/index.ts`). Wires factories together and runs init. No INTERFACE
markers — the file isn't consumed by other modules. The header comment
should list **what stays here vs. what's been extracted** so future-you
remembers which knobs live where.

**4. Tiny modules** (`log.ts`, `types.ts`, `constants.ts`, `state.ts`).
Under ~100 lines, no INTERFACE markers needed.

If you grow a utility/orchestrator module to the point where it has clear
private state + a public API to others, that's the signal to refactor it
into a factory.

### State sharing — `src/tabs/state.ts`

WeakMaps + Sets + Arrays exported as named consts (`treeOf`, `rowOf`,
`movingTabs`, `selection`, `savedTabQueue`, `closedTabs`). Pass-by-reference, so
imports see writes.

A `state` object holds singletons:
```typescript
state.panel              HTMLElement (cast non-null after init)
state.spacer             HTMLElement
state.pinnedContainer    HTMLElement
state.contextTab         Tab | null
state.cursor             Row | null
state.nextTabId          number
```

Grow `state.ts` ONLY when a typed module needs to share writes. Module-internal
mutables (drag's `dragSource`, vim's `chord`, etc.) stay inside the module.

### Cross-module wiring — factory pattern

When a module needs functions from another module that's not yet extracted (or
needs callbacks), use a factory:

```typescript
export function makeDrag(deps: DragDeps): DragAPI { … }

// in legacy index.ts:
const drag = makeDrag({ clearSelection, scheduleSave, … });
drag.setupDrag(row);
```

For circular factories (drag↔rows, where each needs the other's API), use a
`let` declaration with a thunk:

```typescript
let rows: RowsAPI;
const drag = makeDrag({
  scheduleTreeResync: () => rows.scheduleTreeResync(),  // thunk resolves later
  …
});
rows = makeRows({ setupDrag: drag.setupDrag, … });
```

### CSS

- Don't put CSS in JS strings. Put it in `chrome/palefox-tabs.css` (or a new
  `palefox-foo.css`) and `@import` it from `palefox.css`.
- `userChrome.css` should NEVER need editing for new sub-files — `palefox.css`
  is the aggregator.
- We use Firefox's native CSS custom properties (`--toolbar-bgcolor`, etc.)
  as the theme baseline. Don't introduce a parallel theme system.
- We're NOT using Tailwind / atomic CSS. Most of palefox CSS targets Firefox's
  own elements (`#sidebar-main`, `#urlbar`, `#nav-bar`) where we can't add
  classes — atomic CSS doesn't apply. For our own elements (`.pfx-tab-row`,
  etc.) the component count is small enough that semantic class names beat
  atomic ones.

### TypeScript settings & limits

- `noImplicitAny: false` and `noUncheckedIndexedAccess: false` are intentionally
  off. They produce too much noise for the legacy code without catching real
  bugs. The check that matters — TS2304 "Cannot find name" — IS on, and that's
  what catches `toggleCollapse-is-not-defined`-class bugs.
- `// @ts-nocheck` is allowed ONLY on the legacy port files (currently
  `src/drawer/index.ts`). New code MUST be fully typed.
- Chrome globals (`gBrowser`, `Services`, `Ci`, `Cc`, `Cu`, `ChromeUtils`,
  `IOUtils`, `PathUtils`, `SessionStore`, `TabContextMenu`,
  `PlacesCommandHook`) are typed as `any` in `src/types/chrome.d.ts`. Tighten
  in-place when a specific access pattern would benefit from real types.
- The DOM `Element` interface is augmented (in `chrome.d.ts`) with optional
  `_tab`, `_group`, `hidden`, `isContentEditable`. Honest for our XUL world.

## Things that have bitten us

- **Top-level return in modules.** TS treats files with imports as modules,
  modules can't have top-level `return`. The build's IIFE wrapping makes it
  legal at runtime — use `// @ts-expect-error TS1108` to suppress.
- **`fs.watch` recursive on Linux** is flaky. Use Bun's built-in
  `bun --watch <script>` instead of hand-rolling a watcher.
- **`Promise.all` over multiple bundles** — one rejection cancels the other
  prints. Run sequentially or wrap each in try/catch if you want individual
  reporting.
- **Mass-sed renames need word boundaries.** `panel` matches inside
  `pfx-tab-panel` (string literal) — use a negative-context regex that
  excludes `-`, `.`, alphanumerics from the boundary.
- **Object shorthand traps** during renames: `{ updateVisibility, … }` looks
  like a definition site to a sed pass but is actually a use site that needs
  the same rename.

## Things we deliberately did NOT do

- **Effect** (the FP/effect-runtime library) — bundle weight + ceremony for
  imperative DOM mutation isn't worth it. We use Effect-style discipline
  (pure tree-op functions, `readonly`, discriminated unions) without the
  framework.
- **Atomic CSS** — see "CSS" above.
- **Build tooling beyond Bun** — no esbuild, swc, vite. Bun's bundler covers
  IIFE format, watch mode, and TypeScript.
- **Asserts everywhere** — Design-by-Contract is overkill here. Use
  `if (!x) return;` for runtime checks. TypeScript narrowing handles the
  static side. Add an assert helper only if/when a specific boundary needs it.

## When extending palefox

Quick checklist (for the underlying rules see *Conventions*):

- **New `.uc.js` bundle:** entry in `build.config.ts` and the build picks it up.
- **New tab/drawer module:** factory file under `src/<area>/<name>.ts`,
  wired from the area's `index.ts`. Don't grow `index.ts` with feature
  code — peel into its own factory. `src/drawer/compact.ts` is the
  reference example.
- **New CSS:** `chrome/palefox-<name>.css` + `@import` from `palefox.css`.
  Don't touch `userChrome.css`.
- **New chrome-global type:** tighten `src/types/chrome.d.ts` only on the
  shapes you actually touch — atlas built from use, not a model of XPCOM.

## Bun-specific reminders

- Use `bun X` not `npm X` (install, run, build, test, x).
- `bun:test` for tests.
- `Bun.file` over `node:fs.readFile`/`writeFile`.
- Bun loads `.env` automatically; don't add `dotenv`.
