# Post-mortem: content-focus bridge in v0.40.0

**Date:** 2026-04-26  
**Severity:** User-visible regression in published v0.40.0 release; release was unpublished, fixed, and re-published in the same window.  
**Surface:** `o` / `t` / `x` global keys swallowing keystrokes in content inputs (chat boxes, code editors, contentEditable docs).

## What happened

The v0.40.0 global keymap (`t`/`:`/`o`/`O`/`x`/`` ` ``) was wired at the chrome `document` level — capture-phase keydown listener. Keys typed into web pages reach that listener too (chrome dispatches first, forwards to content if uneclaimed), so palefox needed to know "is the user typing into something" before claiming a key.

Vimium and Tridactyl solve this by running in **content scope** as WebExtension content scripts. They check `document.activeElement` directly via `isTextEditable` / `isFocusable`. Palefox runs in **chrome scope**; the e10s process boundary forbids reading content DOM. There is no chrome-side equivalent.

The right answer was always a frame script: ship the same `isEditable` logic into content via `gBrowser.messageManager.loadFrameScript(dataUrl, true)`, have it report a boolean back via `sendAsyncMessage`. That's the same primitive Firefox uses internally (form autofill, find-in-page, password manager). It took **four iterations across two re-publishes** to land it correctly.

## Iterations and their failure modes

### Iteration 1: `chromeFocused()` heuristic (commit 89eaa36)

```ts
function chromeFocused(): boolean {
  const fw = Services.focus?.focusedWindow;
  return !fw || fw === window;
}
```

**Premise:** if focus is in a content window, bail.

**Failure:** over-broad. `Services.focus.focusedWindow !== window` is true whenever ANY content has focus, including when content's focus is on `<body>` with no input. So `x` died on YouTube/Reddit body-only pages — the exact case where palefox keys MUST fire.

**Why I shipped it:** I didn't write a Tier 3 test before pushing. The user reported `x` not firing on YouTube about 10 minutes after I shipped to their browser.

### Iteration 2: frame script with `instanceof Element` and global `addEventListener` (commit 5a2cc5d)

```js
function isSelectable(el) {
  if (!(el instanceof Element)) return false;  // ReferenceError
  ...
}
addEventListener("focusin", report, true);  // attached but never fires because report errored on first call
```

**Premise:** ship the Vimium logic into content via frame script.

**Failure:** `Element` is not a global in a frame script context. The check `el instanceof Element` threw `ReferenceError`, killing `report()` on first invocation. The chrome-side cache stayed empty forever. The bridge silently did nothing.

**Why I shipped it:** I wrote and built without running an integration test — the chrome side compiled fine, the frame script source string compiled fine (it's never parsed at TS time), and I had no fast feedback loop showing me the runtime ReferenceError. I republished v0.40.0 pointing at this commit.

### Iteration 3: `content.addEventListener` (mid-debugging)

After the user reported `o` was still spawning the floating urlbar in their Claude.ai chat, I "fixed" the `Element` issue by switching to `content.addEventListener` and `content.Element`.

**Failure:** `content` is a moving reference. It points to the CURRENT content window. When the page navigates (or even when the test scaffolding navigates the selected tab), `content` is replaced with a new window object. Listeners attached to the old `content` window are now on a discarded object. Focus events on the new page never fire them.

**Why I shipped it:** I still hadn't written a test. I was iterating against the user's manual reload loop.

### Iteration 4: duck-type `isEditable`, global `addEventListener`, content.document.activeElement (commit 8db0b6c)

The actual fix:

```js
function isSelectable(el) {
  if (!el || typeof el.nodeName !== "string") return false;  // duck-type, no instanceof
  ...
}
addEventListener("focusin", report, true);  // global on the message manager's EventTarget
function deepActiveElement() {
  return content.document.activeElement;  // content is fine for READS at event time
}
```

Verified against:
- `dom/chrome-webidl/MessageManager.webidl:434` — `ContentFrameMessageManager : EventTarget`. The global `addEventListener` IS valid in a frame script, attaches to the message manager's own event target (which dispatches content events from every content window loaded into this frame loader, surviving navigation).
- `tools/lint/eslint/eslint-plugin-mozilla/lib/environments/frame-script.mjs` — enumerates the frame-script globals. `Element`, `document`, `window` are NOT among them. Use `content.document` and duck-type element checks.

8/8 Tier 3 tests pass: initial state, `<input>`, `<textarea>`, contentEditable, ARIA `role=textbox`, button (stays false), blur returns to false, body-focus still fires `x`.

## Root causes

### 1. Tests came after, not before

This codebase has a Tier 3 Marionette runner explicitly designed for AI iteration (`bun run test:integration`). CLAUDE.md tells me to use it BEFORE shipping. I shipped to the user's browser as the primary verification path twice.

A test file exercising the bridge contract — focus an `<input>`, assert `pfxTest.contentInputFocused() === true` — would have failed in 3 seconds on iteration 2 with a clear "bridge never reported anything" signal. Instead the failure surfaced 10–60 minutes later as user frustration.

### 2. Built on guesses, not source

When the user said "do a phd level deep dive," I should have read `MessageManager.webidl` and `frame-script.mjs` first. Both are < 100 lines. They unambiguously answer:

- What globals are defined in a frame script? (`dump`, `atob`, `btoa`, `addMessageListener`, `removeMessageListener`, `sendAsyncMessage`, `sendSyncMessage`, `content`, `docShell`, `tabEventTarget`)
- What does the frame-script global inherit? (`EventTarget` — so `addEventListener` is valid)
- Does `Element` exist? (No.)
- Is `document` the chrome doc or content doc? (Neither — it doesn't exist; use `content.document`.)

Each of these answers, read from source rather than assumed, would have pre-empted a wrong iteration.

### 3. Heuristic-first thinking

Iteration 1's `chromeFocused()` was a guess from chrome's vantage. The honest framing — "Vimium and Tridactyl work because they're IN content; chrome can't read content DOM; therefore we need a content-side helper, which Firefox already has a primitive for" — would have led directly to a frame script. I had this thought but didn't act on it; I built the heuristic anyway because it was 5 lines vs the bridge's 200.

### 4. New layer instead of validating baseline

When the bridge "didn't work" in iteration 2, my next move was to add a hello-probe smoke test (good) WITHOUT first re-checking my baseline assumptions about frame-script globals (bad). The smoke test was useful diagnosis; checking the IDL would have been faster.

## What changes

### CLAUDE.md gets a TDD discipline section

Distilled rule for cross-process, IPC, or new-Firefox-API work:

1. Read the IDL / Firefox source before writing code.
2. Write the Tier 3 test that asserts the contract.
3. Write the implementation. `bun run test:integration` until it passes.
4. ONLY THEN push to user.

If the test substrate doesn't exist for the surface yet, the first PR for that surface is the substrate.

### Diagnosis introspection stays

`pfxTest.contentFocusDiag()` exposes `messageCount` / `lastMessageEditable` / `cachedForCurrent`. Cheap, gated on `pfx.test.exposeAPI`, future-me thanks past-me when the next bridge bug shows up.

### A test was deferred

`content-focus: x global key bails when content input is focused` (the end-to-end behavioral test) is documented inline as TODO. Marionette's `setContext("content")` → `setContext("chrome")` round-trip lands `dispatchEvent` keystrokes in a sandbox that doesn't reach our document listener, AND content focus drops mid-test. Both are test-driver artifacts unrelated to the bridge logic; the unit-level tests (8 of them) cover the bridge contract directly. Re-adding the end-to-end test needs a different fixture pattern (probably headed Firefox + synthesized OS-level events).

## Timeline

- 21:24 — v0.40.0 published with `chromeFocused()` (iteration 1).
- ~21:35 — User reports `x` doesn't fire on YouTube. Release pulled to draft.
- ~21:50 — Iteration 2 shipped with frame-script bridge using `Element` and global `addEventListener`. v0.40.0 re-published.
- ~22:10 — User reports `o` still hijacking Claude.ai chat. Release pulled to draft. User instruction: "do a phd level deep dive."
- ~22:30 — Iteration 3 (`content.addEventListener`). Still broken.
- ~23:00 — Iteration 4 lands. 8/8 bridge tests pass. v0.40.0 re-published as commit `8db0b6c`.

Total elapsed: ~90 minutes for what should have been one test-then-build pass. The TDD-first version would have taken ~20.
