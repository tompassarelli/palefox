# Firefox upstream stability strategy

> **Roadmap & milestone tracking lives in
> [firefox-stability-roadmap.md](firefox-stability-roadmap.md).** This doc
> is the architectural strategy. The roadmap doc is the plan-of-record
> with current milestone status.

## Thesis

Palefox does not assume Firefox internals are stable. Every Firefox internal
palefox depends on is **explicit, source-linked, version-pinned, and
re-verified against upstream change**. When upstream moves, our job is to
detect *which specific* files we cite have changed — not to re-audit Firefox.

## Doctrine

Five rules that decide every architecture question downstream:

1. **Palefox does not program directly against Firefox internals except in
   the Firefox adapter layer (`src/firefox/*`).** Feature code imports
   typed primitives from there; raw `gBrowser` / `Services` / `gURLBar` calls
   only exist inside the adapter.
2. **Palefox defines its own semantic API over a small set of stable
   Firefox primitives.** When the API expresses *what palefox means*
   (`Palefox.tabs.move(id, intent)`), not *what Firefox can do*
   (`gBrowser.moveTabTo(tab, idx)`), the contract becomes ours.
3. **Firefox events are invalidation signals, not perfect descriptions of
   state.** A `TabOpen` doesn't mean "render exactly one row now"; it
   means "the tab set may have changed — reconcile palefox's model
   against `gBrowser.tabs`." This handles ordering quirks, late state,
   and missed events without fragile event-order code.
4. **Firefox session state is an interoperability source, not the sole
   source of truth.** Palefox owns its own snapshot format
   (already in `history.ts`); SessionStore is consulted, not depended on.
5. **All high-risk Firefox dependencies are source-linked, typed, tested,
   and tracked by the upstream canary.** Untracked dependencies leak —
   the manifest is the gate, not a wishlist.

Palefox is chrome-privileged code living next to Firefox's private
implementation. We are not a WebExtension; we are not behind a stable API
contract. The danger is not just "an API disappears." The danger is
**semantic drift**: an event fires later, a lazy tab returns different
state, a DOM node is renamed, a popover lifecycle changes, `SessionStore`
keeps the same method but returns subtly different data. Types catch
*signature* breakage. Tier 3 tests catch *behavioral* breakage. The
**canary** catches *upstream-source* changes before either layer does, and
narrows the search radius from "did Firefox change?" to "these three
specific files changed; re-read them."

## Anti-goals

What this strategy explicitly does **not** build, and why:

- **Modeling all of XPCOM in TypeScript.** The footprint we touch is ~47
  entry points. Modeling Firefox's whole interface tree is a months-long
  trap that produces mostly fake confidence. Type only what we touch.
- **A test matrix across stable / ESR / Beta / Nightly with separate
  harnesses.** One Tier 3 runner exists and works. Building three more is
  a quarter of effort for marginal gain. Defer until a real
  channel-specific bug forces it.
- **ESR / "enterprise stable" track.** Palefox's audience is hackers
  installing via fx-autoconfig. Targeting ESR means accepting Firefox
  versions 6–18 months stale, which kills our ability to use new
  primitives (Popover API, JSWindowActor, etc.). Stable + best-effort
  Beta is the right scope.
- **Hotswap dev workflow + per-channel disposable profiles + matrix
  runner.** fx-autoconfig already has install paths; we'd be reinventing.
- **`:palefox doctor` runtime command and full compatibility-range JSON in
  release notes.** Enterprise theater for a project at our scale. A line
  saying "verified against Firefox X" in the release notes is enough.
- **Calendar-based upstream verification cadence.** The canary runs *on
  demand* — before a release, when something feels off, when CLAUDE.md
  says it should. Not weekly busywork.

## Compatibility surface

The compatibility surface is everything palefox touches that lives in
Firefox source. It splits into three layers:

1. **Chrome globals** — `gBrowser`, `Services`, `gURLBar`, `ChromeUtils`,
   `SessionStore`, `IOUtils`, `PathUtils`, etc. The 47-entry footprint
   surveyed in this doc.
2. **DOM contract** — XUL element IDs (`#sidebar-main`,
   `#navigator-toolbox`, `#urlbar`, `#nav-bar`, …) and factories
   (`createXULElement("hbox" | "vbox" | "label" | "menupopup" | …)`).
   Stable but renames have happened (sidebar-revamp era).
3. **Behavior contracts** — event firing order, lazy-tab state shapes,
   transition timing, popover layer semantics. Hardest to type; covered
   by Tier 3 behavior tests. Drift here is what bites us most.

## Breakage taxonomy

When something breaks, classify it. Vocabulary makes triage faster and
makes recurring patterns visible.

- **Class A — Symbol breakage.** Method/property disappeared or moved.
  *Defense:* the canary plus the typed-adapter layer.
- **Class B — Signature breakage.** Same name, different arguments or
  return shape. *Defense:* TypeScript types on the entries that have them;
  runtime assertions at adapter boundaries for the rest.
- **Class C — Behavioral breakage.** Same method, different semantics
  (e.g., lazy tabs return `about:blank` for `currentURI.spec` where they
  used to return the original URL). *Defense:* Tier 3 behavior tests +
  source-cited atlas entries that document the assumption.
- **Class D — Lifecycle breakage.** Events fire in a different order, or
  state isn't ready when an event fires. *Defense:* event-order tests,
  idempotent reconciliation, debounced state rebuilds.
- **Class E — DOM/CSS breakage.** Element renamed, class moved, shadow
  root reorganized. *Defense:* centralize selectors in `src/firefox/`
  adapters; Tier 3 + the chrome-DOM dump tool.
- **Class F — Persistence breakage.** SessionStore data shape changes;
  `setCustomTabValue` keys collide with new Firefox usage; `IOUtils`
  encoding semantics shift. *Defense:* explicit fixtures in the test
  suite; a separate fixture-restore Tier 3 test bank when this gets hot.

## Two-layer architecture

The strategy is bigger than "wrap chrome globals." Palefox is becoming a
small browser-chrome runtime built on top of Firefox primitives, with
two distinct platform layers:

```
src/firefox/        — Firefox adapter layer
                      typed wrappers around chrome globals
                      stays loyal to Firefox primitives
                      patches happen here when upstream shifts

src/platform/       — Palefox semantic layer
                      tab-model, window-model, snapshot-store, event-bus, reconciler
                      stays loyal to palefox's own contract
                      feature code talks to this, not to Firefox

src/<features>/     — Feature code: vim, sidebar, picker, urlbar, history
                      imports from src/platform/* (capabilities)
                      may import from src/firefox/* (only when capability missing)
                      never touches gBrowser / Services / gURLBar directly
```

Today only `src/firefox/` is bootstrapped; `src/platform/` is still on
the roadmap. The strategy doc commits to building it. Until it's live,
treat new feature work as "import what you need from `src/firefox/*`,
add the missing primitive there if it doesn't exist."

### The adapter layer (`src/firefox/`) — what's there today

Blast shield. **All chrome-API calls go through `src/firefox/<adapter>.ts`.**

```ts
import { pinTab, allTabs, selectedTab } from "@/firefox/tabs";
```

NOT:

```ts
gBrowser.pinTab(gBrowser.selectedTab); // raw access — only inside src/firefox/
```

The adapter is the right place for:

- Idempotency wrappers (`pinTab` no-ops if already pinned).
- Debouncing / retry-on-stale-tab-ref.
- Consistent observability — every adapter call logs through
  `createLogger("firefox:tabs")` etc., giving us one seam where every
  Firefox interaction is visible.
- Localizing `// @ts-expect-error` and `as any` casts so they don't
  leak into feature code.
- Tier 1 unit-testing: `vim.ts` is hard to unit-test today because
  every line touches `gBrowser`. Once it imports from
  `src/firefox/tabs`, we can mock the adapter and unit-test feature
  logic without spinning up Firefox.

Migration is incremental — strangler-fig. Each module that's touched
for any reason routes its Firefox calls through adapters; over time
the bulk migrates without a big-bang rewrite. The roadmap tracks the
backlog of un-migrated callsites.

### The semantic layer (`src/platform/palefox/*`) — the bigger move

Capabilities, not internals. Each Palefox surface gets a model:

```
src/platform/palefox/
  tabs.ts         Palefox.tabs.{list, get, select, pin, move, close, …}
  windows.ts      Palefox.windows.{current, list, snapshot, reconcile}
  events.ts       Palefox.events.on("tab:created" | "tab:selected" | "window:reconciled" | …)
  snapshots.ts    Palefox.sessions.{capture, restore, restoreWindow}
  reconciler.ts   schedule + run model-vs-firefox reconciliation
  diagnostics.ts  Palefox.diagnostics.{dumpModel, verifyFirefoxCompatibility}
```

The semantic API expresses palefox's domain:

```ts
// Bad — feature code knows about Firefox primitives:
gBrowser.pinTab(gBrowser.selectedTab);
updateSidebar();

// Good — capability-shaped:
await Palefox.tabs.pin(Palefox.tabs.selectedId());
// (sidebar reconciles via the event stream; vim doesn't have to call it)
```

Two rules govern the semantic layer:

1. **Capabilities are idempotent and intent-shaped.** `move(id, intent)`
   takes a destination + flags, not a raw integer index. The
   implementation translates intent into `gBrowser.moveTabTo` calls.
2. **Internal state is reconciled, not patched.** Receiving a `TabOpen`
   doesn't directly mutate the tree. It marks the tree dirty;
   the reconciler reads `gBrowser.tabs` and rebuilds. See *Reconciler*
   below.

### The reconciler

```
Firefox emits noisy primitive event.
  ↓
Adapter normalizes + bubbles a Palefox event.
  ↓
Palefox model marks itself dirty (with a reason tag).
  ↓
Reconciler is scheduled (microtask or rAF).
  ↓
Reconciler reads current Firefox primitive state.
  ↓
Reconciler diffs against Palefox model + applies the diff.
  ↓
UI rebuilds from Palefox model.
```

This is the architectural answer to Class C and Class D breakage. The
v0.40.0 floating-urlbar regression where the horizontal observer raced
the deactivate would have been impossible: the popover state would just
be re-derived from `breakout-extend + pfx-urlbar-floating` on every
reconcile pass, no race window.

The `rows.scheduleTreeResync` pattern in `src/tabs/rows.ts` is already
a partial reconciler for the tree. Generalizing it across the platform
layer is M4 on the roadmap.

### Tier 0–3 primitive classification (forward design rule)

When designing a new Palefox capability, classify the Firefox primitive
you're about to depend on:

| Tier | Primitive shape | Examples | Design rule |
|------|-----------------|----------|-------------|
| **0** | Stable platform primitives (decade+) | `Services.prefs`, `Services.obs`, `IOUtils`, `PathUtils`, `createXULElement` | Build freely on these. |
| **1** | Stable browser primitives (years) | basic `gBrowser` tab ops, `gBrowser.tabs`, `tab.linkedBrowser.currentURI`, `Tab*` DOM events | Build on these via adapters. |
| **2** | Semantically risky | `SessionStore` (lazy tabs), urlbar lifecycle, `breakout-extend` semantics, `messageManager.loadFrameScript` | Wrap behind heavily-tested adapters; pin a behavioral test for the assumption. |
| **3** | Volatile implementation | private DOM structure, internal class names, timing-dependent layout, undocumented globals | Avoid unless no alternative; centralize selectors; expect breakage. |

The tier is orthogonal to the manifest's `stability` field. Stability
is a diagnostic about how often Firefox moves it. Tier is a design rule
about whether to build on it. They correlate but don't have to match
for any single primitive.

### Three rings of ABI investment

Not every adapter deserves equal treatment. Three rings:

- **Ring 1 — Load-bearing.** Used by core palefox features and on the
  hot path (tab ops, urlbar focus, session state). Gets aggressive
  types, behavior tests, source citations, manifest entries, JSDoc.
- **Ring 2 — Known but non-load-bearing.** Touched by edge-case features.
  Gets rough types and a one-paragraph JSDoc; manifest entry only if
  in Tier 2 or 3.
- **Ring 3 — Reference-only.** Stuff we've researched but don't depend
  on. Lives as Markdown notes in `docs/dev/firefox-internals.md`,
  not as TypeScript. No maintenance obligation.

Ring 1 should never grow past ~30 entries. If it does, we're modeling
Firefox; that's the trap.

## The manifest

`tools/firefox-canary.ts` embeds the typed manifest. Each entry has:

```ts
type ManifestEntry = {
  /** Stable identifier, used in canary output. */
  name: string;
  /** Stability bucket. Drives default risk and canary verbosity. */
  stability: "rock" | "stable" | "moving" | "experimental";
  /** Path inside ~/code/firefox that owns this primitive. */
  sourcePath: string;
  /** Specific symbols inside that file we depend on. */
  symbols: readonly string[];
  /** Where in palefox this is consumed. Lives in src/firefox/<adapter>.ts
   *  once migration lands; today points at the consuming feature file. */
  palefoxOwner: string;
  /** Tier 3 test files that exercise this dependency end-to-end. */
  tests: readonly string[];
  /** What we need from this primitive — short prose, kept current. */
  expects: string;
  /** Worst-case symptom if this drifts. */
  failureMode: string;
};
```

See [`tools/firefox-canary.ts`](../../tools/firefox-canary.ts) for the
populated manifest (~20 entries today; growing as we touch more).

## The canary

`bun run firefox:canary` does:

1. Read pinned Firefox SHA from `tools/firefox-pin.json`.
2. For each manifest entry: `git -C ~/code/firefox log <pinned>..HEAD -- <sourcePath>`.
3. Output entries grouped by stability bucket × changed/unchanged. For
   changed entries, list the commits that touched them and their first
   line of subject.
4. Suggest the Tier 3 test files to run for each affected adapter.

Output is brutally plain. Example:

```
Pinned: abc1234 (Firefox 126.0)
Current: def5678 (latest fetch)

EXPERIMENTAL — RE-VERIFY:
  TabContextMenu.moveTabsToSplitView
    browser/base/content/tabbrowser-tabs.js (3 commits)
      ddeeff0 Bug 1234567 — split view: change moveTabsToSplitView signature

MOVING — CHECK:
  gURLBar.view.selectBy
    browser/components/urlbar/UrlbarView.sys.mjs (1 commit)
      99aabbc Bug 1234999 — selectBy: clarify behavior at list boundary

ROCK + STABLE — unchanged: 14 entries (suppressed)

Affected tests to run:
  tests/integration/tabs-picker.ts
  tests/integration/global-keys.ts

Run: bun run test:integration -- --grep "tabs-picker|global-keys"
```

Pin update flow: after re-verifying, `bun run firefox:canary --pin HEAD`
records the new SHA + Firefox version into `tools/firefox-pin.json`.

## Pinning Firefox

`tools/firefox-pin.json`:

```json
{
  "firefoxRevision": "<sha>",
  "firefoxVersion": "<release version, e.g. 126.0>",
  "verifiedAt": "<YYYY-MM-DD>",
  "verifiedBy": "<who ran canary + tests>"
}
```

This is the single source of truth for "what Firefox we last validated
against." Update it after a successful canary + Tier 3 pass.

## Release-note compatibility line

Each release notes its tested-against Firefox in one line:

```
Verified against Firefox X.Y (revision abc1234).
```

That's it. No matrix JSON, no compatibility-range tables. If the user is
on a Firefox so different that things break, the runtime can warn (future
work) but right now the contract is "we test what we ship; if you're on
the same Firefox, it works."

## What lives where

```
docs/dev/firefox-upstream-stability.md   ← this doc
docs/dev/firefox-internals.md            existing narrative reference (kept)
docs/dev/postmortem-content-focus.md     existing breakage post-mortem
tools/firefox-canary.ts                  manifest + canary script
tools/firefox-pin.json                   pinned revision
src/firefox/                             typed adapter layer (new — start small)
```

## Open questions for follow-up conversation

These are the higher-lift items deliberately deferred:

1. **Adapter-layer migration.** Most palefox code today calls `gBrowser`
   directly. Migrating to `src/firefox/*` is a multi-PR cleanup. Order:
   adapter for the dirtiest call site first (probably `src/drawer/index.ts`
   while we're already touching it for the @ts-nocheck removal).
2. **Symbol-level signature types.** Once an API gets typed in
   `src/firefox/*.ts`, decide whether to also add a real `.d.ts` interface
   for the underlying chrome global, or leave it as `any` and rely on the
   adapter's narrow signature. My instinct: leave globals as `any`; the
   adapter is the contract, the global is implementation.
3. **Tier 3 fixtures for SessionStore behavior.** The Class F failures
   (persistence drift) are the hardest to test. Building a fixture-based
   restore harness is its own project.
4. **Canary in CI.** Today it's a manual step. Wiring it into a GitHub
   Action that comments on PRs that diverge from the pin is straightforward
   but not yet justified by failure rate.
5. **Runtime version-aware feature gating.** If we ever ship to users on
   meaningfully different Firefoxes, gate Class C / D / F features on
   detected version.
