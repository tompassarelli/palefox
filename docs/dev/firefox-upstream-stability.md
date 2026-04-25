# Firefox upstream stability strategy

## Thesis

Palefox does not assume Firefox internals are stable. Every Firefox internal
palefox depends on is **explicit, source-linked, version-pinned, and
re-verified against upstream change**. When upstream moves, our job is to
detect *which specific* files we cite have changed — not to re-audit Firefox.

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

## Adapter layer (`src/firefox/`)

The blast shield. New rule: **all chrome-API calls go through
`src/firefox/<adapter>.ts`.** Most palefox code imports from there:

```ts
import { pinTab, unpinTab, getSelectedTab } from "@/firefox/tabs";
```

NOT:

```ts
gBrowser.pinTab(gBrowser.selectedTab); // raw access — only inside src/firefox/
```

When Firefox shifts a method's semantics, we patch the one adapter file,
not 14 callsites scattered across the codebase. The adapter layer also:

- Localizes `// @ts-expect-error` and `as any` casts to the adapter
  module — they don't leak into feature code.
- Gives the canary's `palefoxOwner` field a real value to point at.
- Means feature modules can be unit-tested with mocked adapters (Tier 1
  becomes more useful for vim.ts and friends).

This is **aspirational** today. The migration is the larger conversation.
What we do now: establish `src/firefox/` with one example adapter to set
the pattern, document the rule in CLAUDE.md, and require new code to
follow it. Migration of existing callsites happens incrementally as
modules get touched.

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
