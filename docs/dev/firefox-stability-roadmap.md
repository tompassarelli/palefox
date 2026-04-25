# Firefox stability roadmap

The plan-of-record for executing
[firefox-upstream-stability.md](firefox-upstream-stability.md). Tracks the
big arc: from "raw `gBrowser` calls scattered across the codebase" to
"palefox is a runtime built on stable Firefox primitives via a typed
adapter layer + a semantic platform layer with a reconciler."

Updated as milestones land. Each milestone has explicit scope, what it
unlocks, and what it deliberately defers. **Don't grow this doc to
track work-in-progress** — that's `tasks/` territory. This is for
multi-PR arcs and architectural commitments.

---

## Status legend

- ✅ shipped
- 🟢 in flight
- ⚪ committed, not started
- ⚫ deferred — listed for visibility, not currently scheduled

---

## M0 — Strategy + canary + pattern   ✅

Shipped in `b1d639e` (2026-04-26).

- Strategy doc: `docs/dev/firefox-upstream-stability.md` with thesis,
  doctrine (5 statements), breakage taxonomy (Class A–F), anti-goals.
- Two-layer architecture documented (Firefox adapter + Palefox semantic).
- Canary: `tools/firefox-canary.ts` with 17-entry manifest.
  `bun run firefox:canary` works.
- Pin: `tools/firefox-pin.json` bootstrapped (Firefox 151.0a1 @ aad5a8c).
- First adapter: `src/firefox/tabs.ts` demonstrates the pattern.
- CLAUDE.md: operating rules (new chrome calls go through adapters,
  run canary before each release, add to manifest when touching new
  APIs, anti-goals enforced).

**Unlocks:** every following milestone.

---

## M1 — Bucket-A adapter coverage   ⚪

Round out `src/firefox/*` with adapters for the rest of the rock-stable
primitives. New code can stop importing chrome globals directly.

Scope:

- `src/firefox/prefs.ts` — `Services.prefs` (typed get/set/observe).
  Most-touched call right now (`Services.prefs.getBoolPref` × 18).
- `src/firefox/observers.ts` — `Services.obs.{add,remove}Observer`.
- `src/firefox/files.ts` — `IOUtils` + `PathUtils` + profile-path helpers.
- `src/firefox/dom.ts` — `createXULElement` factories with typed return.
- `src/firefox/window.ts` — `gBrowser.selectedBrowser`, `.focus()`,
  delayed startup, `gBrowserInit.delayedStartupFinished`.

Each adapter:
- Inline JSDoc with stability tier and source citation.
- `createLogger("firefox:<area>")` instrumentation gated on `pfx.debug`.
- Manifest entry in `tools/firefox-canary.ts` if not already there.

**Defers:** migration of existing callsites (M2), Bucket-B/C wrapping
(M5).

**Unlocks:** new feature code can be written without a single
`gBrowser`/`Services` reference.

---

## M2 — Migrate existing callsites to adapters   ⚪

Strangler-fig. Every module that's touched for any reason routes its
Firefox calls through `src/firefox/*` adapters before the PR lands.
No big-bang rewrite.

Scope priority (by current `gBrowser`/`Services` density):

1. `src/drawer/index.ts` — natural pair with M3 (factory extraction)
   and the only `@ts-nocheck` file. ~50+ direct chrome-global calls.
2. `src/tabs/vim.ts` — biggest beneficiary (becomes Tier 1 unit-testable
   once mocked).
3. `src/tabs/rows.ts`, `events.ts`, `menu.ts`, `index.ts` — incremental.

Tracking: a one-line counter in this file, updated as PRs land.

**Today's count:** ~47 distinct chrome-API entry points hit across all
of `src/`, dominated by `gBrowser.tabs` (×32), `gBrowser.selectedTab`
(×22), `Services.prefs.*` (×35 across get/set/observe).

**Defers:** Tier 1 mocked unit tests for the migrated modules (M6).

**Unlocks:** M6 (testability), graceful drift response.

---

## M3 — Extract `src/drawer/index.ts` into typed factories   ⚪

Was originally task #57. Now a milestone because it's the single
biggest "remove `@ts-nocheck`" payoff and pairs naturally with M2's
adapter migration.

Scope: Five factory extractions (pattern matches `src/drawer/compact.ts`
and `urlbar.ts`):

- `src/drawer/layout.ts` — `expand()` / `collapse()` (toolbox into/out
  of sidebar-main, urlbar reparenting).
- `src/drawer/width-sync.ts` — urlbar `--urlbar-width` ResizeObserver +
  MutationObserver.
- `src/drawer/drag-overlay.ts` — `#pfx-drag-overlay`
  (`-moz-window-dragging` on empty sidebar space).
- `src/drawer/sidebar-button.ts` — `#pfx-sidebar-button` +
  `#pfx-sidebar-button-menu`.
- `src/drawer/banner.ts` — HTTP not-secure warning banner.

Outcome: `src/drawer/index.ts` becomes a thin orchestrator (like
`src/tabs/index.ts`), `@ts-nocheck` comes off, and chrome-global
calls in those modules go through adapters from M1.

**Defers:** the same extraction for `src/tabs/vim.ts` (M7).

**Unlocks:** zero `@ts-nocheck` files in the repo.

---

## M4 — Reconciler pattern   ⚪

Generalize the `rows.scheduleTreeResync` pattern across the platform
layer. Events become invalidation signals, not state-truth.

Scope:

- `src/platform/palefox/reconciler.ts` — generic invalidation queue.
  Coalesces multiple "dirty" reasons into one reconcile pass per tick.
- Refactor `rows.scheduleTreeResync` to use the reconciler.
- Compact-mode state machine — recast as "events mark sidebar dirty,
  reconciler re-derives `pfx-has-hover` from cursor + breakout +
  floating + ignoreNextHover." This is the architectural answer to
  the v0.40.0 horizontal-mode race; race windows go away because
  state is always re-read, never patched.

**Defers:** full migration of every state mutation to reconciler-style
(M5+).

**Unlocks:** Class C/D breakage class becomes much harder to
reintroduce. Tier 3 tests can assert "after these events, model
matches truth" instead of "events fired in this exact order."

---

## M5 — Palefox semantic layer (`src/platform/palefox/*`)   ⚪

Build the capability API. Feature code stops talking to
`src/firefox/*` and starts talking to `Palefox.*`.

Scope (probably multiple PRs — these are sub-milestones):

- **M5.1** `Palefox.tabs.*` — list, get, select, pin/unpin, move (with
  intent), close, duplicate, reload. Backed by `src/firefox/tabs.ts`.
- **M5.2** `Palefox.windows.*` — current, list, snapshot, reconcile.
  Cross-window state question (window-scoped vs global) gets answered
  here.
- **M5.3** `Palefox.events.on(...)` — normalized event names
  (`tab:created` / `tab:selected` / `window:reconciled` / …). Replaces
  raw `TabOpen` listeners.
- **M5.4** `Palefox.prefs.*`, `Palefox.files.*` — thin domain wrappers
  over M1 adapters.

Once M5 lands, the rule in CLAUDE.md tightens: feature code imports
from `src/platform/palefox/*` first; falls back to `src/firefox/*`
only if the capability genuinely doesn't exist yet (and that's a hint
to add it to the semantic layer).

**Defers:** snapshot/session API as Palefox-owned format (M6).

**Unlocks:** feature modules unit-testable in isolation (mock the
semantic layer); breakage radius becomes "one adapter file" instead
of "every callsite that hardcoded `gBrowser`."

---

## M6 — Palefox-owned snapshot format   ⚪

Promote the `history.ts` event log to a fully Palefox-owned snapshot
contract. SessionStore becomes an interoperability source, not the
sole source of truth.

Scope:

- `src/platform/palefox/snapshots.ts` — `Palefox.sessions.{capture,
  restore, restoreWindow}`. Snapshots include palefox version,
  Firefox version (from canary pin), tree shape, tab metadata, sidebar
  state, group state.
- Restore prefers palefox snapshot data, consults SessionStore as
  fallback for lazy-tab content recovery.
- Tier 3 fixture suite for restore behavior — addresses the Class F
  failure mode that's hardest to test today.

**Defers:** schema migration tooling for snapshot version bumps (only
needed when we hit it).

**Unlocks:** Class F regressions caught by test, not by user.

---

## M7 — `vim.ts` split   ⚪

`src/tabs/vim.ts` is ~2200 lines hosting keymap + ex-mode + picker +
search + global-keys. Split for the same reason `drawer/index.ts` is
split: smaller blast radius, clearer ownership.

Scope:

- `src/tabs/picker.ts` — fzf-style overlay (used by `:tabs`,
  `:history`, `:sessions`, `:restore`). Already a clear UI primitive.
- `src/tabs/exmode.ts` — ex-command dispatch table. Each command
  becomes a small handler.
- `src/tabs/global-keys.ts` — chrome-scope keymap (the `t`/`o`/`O`/`x`/
  backtick handlers + the content-focus bail). Naturally consumes
  `Palefox.*` once M5 lands.

**Defers:** unit-test coverage for each split module (parallel to
M2's adapter migration enabling mocks).

---

## M8 — Tier 1 unit tests for migrated modules   ⚪

Once feature code routes through `Palefox.*` (M5) or `src/firefox/*`
(M2), wire up bun:test mocks for the adapter layer and exercise feature
logic without Firefox.

Scope:

- Mock factories: `mockTabs()`, `mockPrefs()`, `mockEvents()`.
- Test bank: vim keymap dispatch, ex-mode parsing, picker filter,
  reconciler coalescing.

**Unlocks:** much faster feedback than Tier 3 for non-Firefox-specific
logic. Reduces the "spawn Firefox to verify a string-parser change"
penalty.

---

## M9 — Canary in CI   ⚪

Wire `bun run firefox:canary` into a GitHub Action that runs on PRs
and emits a comment if any tracked Firefox source path has changed
since the pin. Currently it's a manual pre-release step.

**Gating signal:** when we have ≥1 instance of "Firefox upstream change
caused a release-day surprise" since shipping the canary. Premature
to wire up before that.

---

## M10 — Diagnostics smoke-test   ⚫

`Palefox.diagnostics.verifyFirefoxCompatibility()` — at startup or
on demand, walks the manifest's symbols and asserts they exist in the
running Firefox. Logs a warning to `palefox-debug.log` if any are
missing or have unexpected shape.

Deferred (rather than committed) because the canary catches the same
class of issue earlier in the loop. This is a fallback for "user is
running a Firefox we didn't test against" — only useful once we have
users on diverse Firefoxes.

---

## Stretch / out of scope today

These exist for visibility — not currently scheduled, may never ship.

- **Symbol-level `.d.ts` for chrome globals** (`gBrowser`, `Services`)
  — probably unnecessary if adapters are doing their job. The adapter
  IS the contract.
- **Per-channel test matrix** (stable / Beta / Nightly) — committed
  anti-goal in the strategy doc unless a real channel-specific bug
  forces it.
- **`@palefox/firefox-abi` as a separately-published npm package** —
  premature. May be valuable as a community artifact for browser-
  hackers; revisit once palefox itself stabilizes and the adapter
  layer has organically grown to community-quality.
- **Semantic-layer command-bus / event-bus as named modules** —
  start with plain functions and `EventTarget`; extract a bus only
  if N feature modules consuming N events justifies it.

---

## Sub-tasks tracked in-tool

The `TaskCreate` task list captures conversation-scoped work that
maps onto these milestones:

- Task #56 → folded into M2 (migration) and M5 (semantic layer).
  Don't type chrome globals as a goal in itself; the adapter is
  the contract.
- Task #57 → M3 (drawer extraction).

When in doubt, this doc is the long-lived plan; the task list is
short-term execution memory.
