# Palefox testing strategy

This document is the source of truth for how palefox is tested. It exists for
two reasons:

1. **Coordination across sessions** — when work spans multiple AI-assisted
   sessions, the plan and checklist need to live somewhere durable, not in
   chat history.
2. **Onboarding the AI feedback loop** — once Tier 3 is built, future agents
   (or future me) drive Firefox via Marionette and iterate on real test
   results instead of asking the user to reload-and-report.

Read this end-to-end before starting any test-related work.

---

## Why testing palefox is unusual

Palefox is a **chrome-privileged userscript** loaded via fx-autoconfig. It
runs in Firefox's `browser.xhtml` scope and reaches for `gBrowser`,
`Services`, `ChromeUtils`, `IOUtils`, raw XUL elements, etc. It is **not** a
WebExtension and the WebExtension test ecosystem (`web-ext`, jest mocks,
etc.) does not apply.

The fx-autoconfig / chrome-script ecosystem at large (Zen, FF-ULTIMA, Tridactyl
unit tests, Vimium-FF) uses essentially zero integration testing — manual
reload-and-try is the norm. We're building harness infrastructure that
doesn't exist anywhere in this ecosystem.

The only Mozilla-supported way to evaluate code in Firefox's privileged scope
remotely is **Marionette** (`Context.Chrome` mode). It's confirmed alive in
modern Firefox (`~/code/firefox/remote/marionette/driver.sys.mjs`,
`Context.Chrome` enum, `setContext` command). WebDriver BiDi is the strategic
direction but its chrome-context surface is still maturing; Marionette is
where we get reliable privileged eval today.

---

## Tiered plan

The plan is staged so each tier ships value on its own and unblocks the next.
Don't skip ahead — the upper tiers' value compounds with what's below.

### Tier 1 — Pure unit tests (`bun test`)

**Scope:** functions with no chrome globals and no DOM.

**Tooling:** built-in `bun test`. No deps.

**What this catches:** algorithmic bugs in tree walks, serialization round-trip
errors, queue helper edge cases.

**Coverage ceiling:** ~30% of LOC. Modules that are mostly pure data flow
(`persist.ts`, parts of `helpers.ts`, parts of `vim.ts`) live entirely here.

**Status:** in progress. `src/tabs/persist.test.ts` covers ~100% of the
pure surface in persist.ts. `src/tabs/helpers.test.ts` is the next addition.

### Tier 2 — Mocked DOM + chrome globals (`bun test` + `happy-dom`)

**Scope:** functions that touch `document`, mutable elements, `Services.prefs`,
or `IOUtils`, but whose logic is deterministic given those inputs.

**Tooling:**
- `happy-dom` as dev dep (faster than jsdom, better Bun integration)
- `src/test/harness.ts` exposing mock `Services`, `IOUtils`, `gBrowser`, and
  a `document.createXULElement` that returns a regular `HTMLElement`.

**What this catches:** state-machine logic in compact mode, event-handler
cause/effect chains, tree-row sync bugs.

**What this does NOT catch:** real Firefox API drift, real event-loop
ordering across the chrome process, real CSS interactions (popover top-layer,
`-moz-sidebar` token resolution). Tests passing here mean *the logic is
right*, not *the behavior in Firefox is right*.

**Coverage ceiling:** 60–75% of LOC.

**Status:** not started. Sprint 2.

### Tier 3 — Real Firefox via Marionette

**Scope:** end-to-end behavior in an actual running Firefox.

**Tooling:**
- `geckodriver` binary (system install — see installation notes below)
- `tools/test-driver/` — node-side orchestration:
  - `profile.ts` — create/destroy ephemeral test profile with palefox
    pre-installed (copies `chrome/` + writes autoconfig prefs)
  - `marionette.ts` — thin Marionette client (HTTP+WebSocket to geckodriver
    at port 4444; protocol is JSON command/response)
  - `runner.ts` — spawn Firefox `--marionette --headless`, connect, set
    context to chrome, evaluate test scripts, collect results, kill
- `tests/integration/` — test scripts that get evaluated in chrome scope
- `bun run test:integration` script

**What this catches:** the bugs Tier 2 misses. Sidebar revamp regressions.
`-moz-sidebar` transparent-token leak. Popover top-layer transform escape.
Compact-mode event-loop races that depend on real `transitionend` timing.
Mute audio menu item only working with real `linkedBrowser`.

**Coverage ceiling:** in principle 100%, but each test costs 1–3s to spin up
a Firefox window. Practical suites are 50–100 focused integration tests, not
exhaustive.

**Status:** not started. Sprint 3 — strategic unblocker.

### Tier 4 — Autonomous AI test loop

**Scope:** the iteration substrate itself. Once Tier 3 exists with structured
result output, the manual loop documented in CLAUDE.md (user reloads, AI
reads logs) becomes:

```
AI edits code → bun run test:integration → AI parses JSON → AI iterates
```

**Tooling:** parseable result format from Tier 3 runner; one new section in
CLAUDE.md telling future-AI where the test runner is and how to invoke it.

**Status:** not started. Sprint 4 — natural extension of Tier 3.

---

## Sprint checklist

Mark items as you ship them. Do NOT skip a sprint to start a later one.

### Sprint 1 — Foundations

- [x] `bun test` script in `package.json`
- [x] `src/tabs/persist.test.ts` — 20 tests, ~100% pure surface of persist.ts
- [x] `docs/dev/testing.md` (this file) — linked from CLAUDE.md
- [x] `src/tabs/helpers.test.ts` — treeData / levelOf / levelOfRow / dataOf / subtreeRows / hasChildren (24 tests)
- [x] `bun test --coverage` works; baseline at the time of writing:
      `helpers.ts 78.6% / persist.ts 68.6% / log.ts 13.6%` (the chrome-IO
      paths are Tier-2 territory — happy-dom mocks needed)
- [x] Dev docs consolidated under `docs/dev/` (compact-mode-dissertation,
      chrome-reference/ moved here from `docs/`)

### Sprint 2 — Tier 2 (mocked DOM)

- [x] Add `happy-dom` dev dep
- [x] `src/test/harness.ts` — happy-dom window/document, mock `Services` (with
      addObserver/notify cascade), `IOUtils`, `ChromeUtils`, `Ci`/`Cu`/`Cc`,
      `requestAnimationFrame`, `getComputedStyle`, `MutationObserver`,
      `document.createXULElement` mapped to `createElement`, pre-populated
      `#sidebar-main` and `#navigator-toolbox`. Restore-on-cleanup pattern.
- [x] `src/drawer/compact.test.ts` — 17 tests covering toggle (vert+horiz),
      attribute write-through, pref-observer cascade, verticalTabs auto-swap
      (in both directions), pinSidebar/pinToolbox, destroy cleanup, init-time
      `applyCompactForCurrentMode`.
- [ ] One additional module covered (`drag.ts` OR `rows.ts`) — deferred
- [x] Coverage report runs (`bun test --coverage`). **Caveat:** Bun's
      coverage % under-reports closure-heavy files (`compact.ts` shows ~7%
      line coverage despite real exercise). Treat the coverage tool as a
      hint, not ground truth. Use the test count + scenario list as the
      authoritative measure.

### Sprint 3 — Tier 3 (real Firefox)

- [x] geckodriver NOT required — we speak Marionette directly (TCP). NixOS
      Firefox already includes the fx-autoconfig loader (`mozilla.cfg` +
      `defaults/pref/autoconfig.js` baked into the package), so we don't
      need to write to the binary install dir either.
- [x] `tools/test-driver/profile.ts` — ephemeral profile under `mkdtemp`,
      copies `chrome/` from repo, writes `user.js` with Marionette + sane
      headless prefs. Auto-cleanup on `cleanup()`.
- [x] `tools/test-driver/marionette.ts` — minimal Marionette TCP client.
      Wire format: `<utf8-byte-length>:<json>`. Implements
      `WebDriver:NewSession`, `Marionette:SetContext`, `WebDriver:ExecuteScript`,
      `WebDriver:DeleteSession`. Handles framing, banner, in-flight map.
- [x] `tools/test-driver/runner.ts` — orchestrates: createProfile → spawn
      Firefox `--marionette --headless --remote-allow-system-access` →
      connectMarionette → setContext("chrome") → run tests → teardown.
      Emits structured JSON events (`test:start`/`test:pass`/`test:fail`/
      `summary`) to stdout for AI/CI consumption.
- [x] `tests/integration/compact.ts` — 4 tests covering bootstrap,
      compact pref-observer chain, hover-strip element create/remove,
      horizontal-compact mode swap.
- [x] `bun run test:integration` script (chains build + runner)
- [x] Headless mode works. **Caveat:** `#sidebar-button` doesn't exist
      under `--headless` at script-eval time, so any test depending on
      our `#pfx-sidebar-button` (built only when the native one is
      present) won't pass headlessly. Headless tests should target
      sidebar/toolbox state + pref behavior, not toolbar UI specifics.
- [x] **Critical Firefox flag:** `--remote-allow-system-access` is
      required for chrome-context `executeScript`. Landed in Firefox 128+
      as a safety gate. Without it: "System access is required."

### Sprint 4 — Suite expansion + AI loop

- [x] JSON result format from runner — Sprint 3 already shipped this.
      Each line is one `{"type": "...", ...}` object. Parse line-by-line.
- [x] CLAUDE.md addition: "AI iteration loop" section — points at
      `bun run test:integration` and the JSON format.
- [ ] Integration tests: tab-tree round-trip across save/restore
- [ ] Integration tests: vim chords (`dd`, `gg`, `yy`)
- [ ] Integration tests: drag-drop reorder (will need synthesized drag events)
- [ ] Document common failure modes + recovery (Firefox didn't start,
      profile got stuck, port collision)
- [ ] (stretch) Make the runner support a single-test filter for fast
      iteration: `bun run test:integration -- --grep="hover strip"`.

---

## Working principles

- **Real bugs first.** Coverage % is a lagging indicator. If we have 90%
  coverage but the next compact regression still ships, we built the wrong
  tests. Test the regression-prone paths heavily; let purely-stable code
  have less coverage.
- **Don't conflate tiers.** A Tier 2 test passing does not mean the behavior
  works in Firefox. Tier 3 is the source of truth for "this works in real
  Firefox."
- **Keep the harness tiny.** `src/test/harness.ts` should be small enough
  to read and audit. If it grows beyond ~200 lines, that's a smell — the
  module under test probably needs refactoring for testability.
- **Marionette over BiDi (for now).** Marionette has been the Firefox-side
  remote-control protocol since 2013. BiDi is newer and more cross-browser
  but we don't need cross-browser; we need privileged eval, which Marionette
  has nailed.
- **Test in real Firefox, not a forked engine.** No Servo-based shortcuts,
  no Geckodriver-emulating-something-else. The point of Tier 3 is to catch
  Firefox-specific regressions.

---

## NixOS installation notes (Sprint 3 prereq)

Geckodriver is in nixpkgs. Easiest path is an ephemeral shell:

```sh
nix shell nixpkgs#geckodriver -c geckodriver --version
```

Or pin into `flake.nix`/`shell.nix` if/when we add one.

Firefox binary on NixOS lives at `$(which firefox)` after install — confirm
with `which firefox` once and bake the path into the test-driver config.

---

## Open questions to resolve as we go

- Does Marionette's `executeScript` in chrome context have a payload size
  limit? If yes, we may need to inline test fixtures rather than passing
  large strings.
- Headless Firefox sometimes behaves differently from headed (input events
  in particular). May need to support both modes for hover-driven tests.
- Profile reuse vs ephemeral: ephemeral is safer (clean state) but slower
  (~1s of profile setup per test). Could amortize by running multiple tests
  per profile if we add a reset between them.
