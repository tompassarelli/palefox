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

## Status check (2026-04-26)

After the M1 + M3 + M7.1 push and the M4 + M5.1 platform-layer push:

- **All Bucket-A (Tier 0) Firefox primitives have a typed adapter** in
  `src/firefox/*`.
- **Zero `@ts-nocheck` files** in `src/`.
- **`src/drawer/index.ts`** is a 65-line orchestrator wiring six factories.
- **Picker** is its own factory (`src/tabs/picker.ts`).
- **Scheduler + tabs reconciler shipped** under `src/platform/`. Dirty-flag
  protocol + microtask coalescing + `flush()` consistency boundary all
  verified live in Firefox.
- **Semantic layer M5.1 shipped:** `Palefox.windows.current().tabs.*` is
  available on `window.Palefox` with full read + mutate API. 6 Tier 3
  tests verify end-to-end.
- **Multi-instance foundation:** doctrine commits to per-record
  `instanceId` in persisted state, per-profile DBs aggregated at read
  time, scope-parameterized APIs. Implementation lands with M6.

What's left:
- M2 — strangler-fig migration of existing callsites into adapters /
  semantic layer (largest remaining work).
- M4.2 / M4.3 — move event-handler logic INTO the tabs reconciler;
  recast compact mode as a sidebar reconciler.
- M5.3 — persisted APIs (`Palefox.history.*`, `.sessions.*`, `.checkpoints.*`).
- M5.4 / M12 — events bus, cross-window aggregator.
- M6 — snapshot format with `instanceId`.
- M7.2 / M7.3 — `vim.ts` ex-mode and global-keys split.
- M11 — cross-instance history.

---

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

## M1 — Bucket-A adapter coverage   ✅

Shipped in `87f4292`. Five adapter files cover the rock-stable
primitives:

- `src/firefox/prefs.ts` — typed get/set/observe wrappers around
  `Services.prefs`. All swallow exceptions and return defaults.
- `src/firefox/observers.ts` — `Services.obs` with disposer-returning
  `on()` helper.
- `src/firefox/files.ts` — `IOUtils` + `PathUtils` + `profileDir()` /
  `profilePath(...parts)` helpers.
- `src/firefox/dom.ts` — typed `createXULElement` factories. `XULTag`
  union prevents typos.
- `src/firefox/window.ts` — well-known chrome IDs centralized,
  `systemPrincipal()` cached, `importESM<T>()` wrapper.

Each is small, dependency-free, drop-in. Existing call sites NOT
migrated — that's M2's strangler-fig work.

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

## M3 — Extract `src/drawer/index.ts` into typed factories   ✅

Shipped. `src/drawer/index.ts` shrunk from 521 lines (`@ts-nocheck`
legacy) to 65 lines (thin orchestrator, fully typed). Four factory
extractions:

- `src/drawer/layout.ts` — `expand()` / `collapse()` + urlbar width
  sync + sidebar-width pref persistence (the three were too coupled
  to split — width-sync observers live inside `expand()` lifecycle).
- `src/drawer/drag-overlay.ts` — `#pfx-drag-overlay` with pref-driven
  enable/disable.
- `src/drawer/banner.ts` — HTTP not-secure warning.
- `src/drawer/sidebar-button.ts` — `#pfx-sidebar-button` + custom
  context menu.

Each factory exposes `destroy()`. `index.ts` aggregates teardown via
`window.unload`. **Zero `@ts-nocheck` files in the repo.**

Verified: 60/60 integration tests pass, including all compact-mode
banks that exercise layout + sidebar-button + compact wiring together.

---

## M4 — Reconciler pattern (skeleton)   🟢

Phase 1 shipped. Scheduler + first domain reconciler + verification
tests are live. The architecture is in place; existing event handlers
in `src/tabs/events.ts` continue to mutate `treeOf` directly until
M2 migrates the rebuild logic into the tabs reconciler.

Shipped:

- `src/platform/scheduler.ts` — central scheduler with the
  dirty-flag protocol, microtask coalescing, declared-order
  reconciler runs (prefs → windows → tabs → snapshots → sidebar →
  command), `flush()` for consistency-sensitive callers, `diag()`
  for debugging.
- `src/platform/tabs-reconciler.ts` — wraps `gBrowser.tabContainer`
  events (`TabOpen`/`TabClose`/`TabMove`/`TabSelect`/`TabAttrModified`/
  `TabPinned`/`TabUnpinned`) into `markDirty("tabs", reason)`.
  Reconciler currently logs reasons; rebuild logic stays in
  `src/tabs/events.ts` until M2 migrates.

What's deferred to follow-on milestones:

- **M4.2** — move `treeOf` rebuild logic from `events.ts` into
  the tabs reconciler. Today the events file mutates the tree
  directly; the reconciler will own the rebuild from `gBrowser.tabs`.
- **M4.3** — recast compact-mode state machine as a sidebar
  reconciler that re-derives `pfx-has-hover` from cursor +
  breakout-extend + floating + ignoreNextHover on every dirty
  signal. Architectural answer to the v0.40.0 horizontal race.

**Unlocks (already):** the M5 semantic API has somewhere sane to
send dirty-state updates. New code can `markDirty(...)` instead of
mutating model directly. Tier 3 tests can drive flush() and assert
end-state.

---

## M5 — Palefox semantic layer   🟢 (M5.1 + M5.2 done)

Build the capability API. Feature code stops talking to
`src/firefox/*` directly and starts talking to `Palefox.*`.

### M5.1 — `Palefox.windows.current().tabs.*`   ✅

Shipped. Window-scoped tabs API per the architectural decision:
live state is window-scoped, NOT a naked global.

- `src/platform/window-tabs.ts` — `WindowTabsAPI`: `list()`,
  `selected()`, `get(ref)`, `pin(ref)`, `unpin(ref)`, `togglePinned(ref)`,
  `close(ref)`, `duplicate(ref)`, `reload(ref)`, `select(ref)`,
  `open(url)`. Accepts `TabRef = number | Tab` (palefox id OR Firefox
  Tab element).
- `src/platform/window.ts` — `PalefoxWindow` facade groups the
  window-local APIs. Per-window stable `windowId` for cross-window
  attribution.
- `src/platform/index.ts` — `Palefox` namespace export. Exposed on
  `window.Palefox` (ergonomic) and `window.pfxTest.Palefox` (tests).

All mutations are sync; reconciler runs on next microtask;
`Palefox.flush()` is the consistency-sensitive escape hatch.
6/6 Tier 3 tests verify end-to-end (`platform-tabs.ts`).

### M5.2 — Multi-instance scope foundation   🟢 (foundation done)

Per the cross-instance search requirement: every persisted record
will carry `instanceId`. Foundation in place via the strategy doc
doctrine #7. Implementation lands with M6 (snapshot format).

### M5.3 — Persisted APIs   ⚪

`Palefox.history.searchTabs(q, { scope: "current" | "all" })`,
`Palefox.sessions.list({ scope })`, `Palefox.checkpoints.*`. Defaults
to `scope: "current"`. Per-profile + aggregate-on-read for `scope: "all"`
(see M11).

### M5.4 — Events bus   ⚪

`Palefox.windows.current().events.on("tab:created" | "tab:selected" |
"tab:closed" | "window:reconciled" | …)`. Replaces raw `TabOpen`
listeners. Cross-window broadcast via `Palefox.events.onAny(...)`
when a real consumer needs it.

### M5.5 — Cross-window aggregator   ⚪

`Palefox.tabs.findAcrossWindows(query)` — see M12.

### M5.6 — Tighten `chrome.d.ts`   ✅

Shipped. Rich ambient types for `gBrowser`, `Services`, `ChromeUtils`,
`IOUtils`, `PathUtils`, `gURLBar`, `SessionStore`, `TabContextMenu`,
`FirefoxViewHandler`, `PlacesCommandHook`. Adapters in `src/firefox/*`
and `src/platform/*` dropped their local `declare const` blocks — the
ambient is the single source of truth. Methods listed in the manifest
match the types here, so canary-flagged churn now has a typed surface
to update. Index-signatures (`[other: string]: unknown`) on the long
tail keep legacy code from breaking until M2 migrates it.

**Unlocks (M5.1 already):** new code can write
`Palefox.windows.current().tabs.pin(id)` instead of touching
`gBrowser`. Mockable via the platform API for Tier 1 tests in M8.

---

## M6 — Palefox-owned snapshot format + multi-instance foundation   ⚪

Promote the `history.ts` event log to a fully Palefox-owned snapshot
contract. SessionStore becomes an interoperability source, not the
sole source of truth. **Bakes in the `instanceId` column from day one**
so cross-instance queries (M11) are a filter, not a migration.

Scope:

- `src/platform/palefox/snapshots.ts` — `Palefox.sessions.{capture,
  restore, restoreWindow}`. Snapshots include palefox version,
  Firefox version (from canary pin), `instanceId`, tree shape, tab
  metadata, sidebar state, group state.
- `instanceId` written to every row of every persisted table. Stable
  per-profile (derived from the profile path or randomly assigned and
  cached on first run).
- Restore prefers palefox snapshot data, consults SessionStore as
  fallback for lazy-tab content recovery.
- Tier 3 fixture suite for restore behavior — addresses the Class F
  failure mode that's hardest to test today.

**Defers:** schema migration tooling for snapshot version bumps (only
needed when we hit it). Cross-instance read (M11).

**Unlocks:** Class F regressions caught by test. The schema can serve
multi-instance queries without a migration.

## M11 — Cross-PROFILE history + sessions   ⚫ (probably never)

Originally added when "cross-instance" was misread as "cross Firefox
profile." It actually meant "cross chrome window" — solved by M12
below, no DB joins needed. Keeping this entry for visibility:

If cross-profile search ever becomes a real ask, the schema is ready
(`instance_id` column populated on every row since v2). Reader-side
work would be: profile-discovery via `~/.mozilla/firefox/profiles.ini`,
open sibling profile DBs read-only, fan out queries, merge results.
Per-profile + aggregate-on-read (NOT shared SQLite — avoids
shared-writer contention).

Until a real user asks for this, it stays unbuilt.

## M12 — Cross-window live tab aggregation   ✅

Shipped. `Palefox.tabs.all()` returns every tab in every chrome window
of this Firefox process, each tagged with `windowId`. Implementation:
iterates `Services.wm.getEnumerator("navigator:browser")`, reads
`window.Palefox` from each, merges per-window `tabs.list()` arrays.

API shape per the doctrine:
- `Palefox.windows.current().tabs.list()` — current window only
- `Palefox.tabs.all()` — all windows aggregated, distinct windowIds
- (no naked `Palefox.tabs.list()` — explicit scope only)

`windowId` switched to `crypto.randomUUID()` since module-local
counters collided across chrome window bundles (each starts at 1).

Verified by 2 Tier 3 tests: multi-window aggregation (open second
chrome window, verify tabs.all() count grows + ≥2 distinct windowIds),
single-window equivalence (`tabs.all().length === current().tabs.list().length`
+ all results carry the current window's id).

**Defers:** picker surface for `Palefox.tabs.all()` results — currently
the data is available but `:tabs` only queries the current window. Wire
the picker through next time the keymap is touched.

---

## M7 — `vim.ts` split   🟢 (M7.1 done)

### M7.1 — Extract picker   ✅

Shipped. `src/tabs/picker.ts` — `makePicker({ restoreFocus, modelineMsg })`
returns `{ show, isActive, dismiss, destroy }`. PickerItem and PickerAction
are exported types. ~370 lines came out of `vim.ts`. Click-outside +
document-level Esc dismiss added (was input-level only — bugs when
focus moved off the input).

### M7.2 — Extract ex-mode   ⚪

Pull the giant `case "group":` switch (and friends) into
`src/tabs/exmode.ts`. Each command becomes its own small handler.
Vim becomes the dispatcher.

### M7.3 — Extract global-keys   ⚪

Pull `setupGlobalKeys()` into `src/tabs/global-keys.ts`. Naturally
consumes `Palefox.*` once M5 lands; until then, imports from
`src/firefox/*`.

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
