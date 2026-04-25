# Palefox Codebase Audit — 2026-04-25

---

## 0. Spring cleaning: code quality and organization

### File inventory

```
chrome/JS/
  palefox-hello.uc.js     9 lines   startup confirmation stub
  palefox-drawer.uc.js  751 lines   sidebar layout, compact mode, button, HTTP banner
  palefox-tabs.uc.js   2811 lines   everything else
```

`palefox-drawer.uc.js` is reasonably scoped, though it mixes 5 distinct concerns (layout expand/collapse, URL bar width sync, drag overlay, compact mode state machine, sidebar button + context menu, HTTP banner). Each is self-contained internally, but they share module-level state (`flashTimer`, `hoverStrip`, `urlbarToolbar`, etc.) that makes the file harder to reason about in isolation.

`palefox-tabs.uc.js` at 2811 lines is the real problem. It handles: tree data structure, session persistence, session restore, vim key handling, drag-drop, group management, horizontal mode rendering, multi-select, search/filter, closed-tab memory, and tab row DOM construction. These have no clear internal API boundaries between them. A bug in one area requires reading the whole file to understand side effects.

### Duplication

- Tab row and group row construction share 40%+ boilerplate element creation. There is no `createRow(type, data)` abstraction — the DOM construction is copy-pasted between the two paths.
- Event handler attachment repeats near-identical patterns 60+ times in tabs.uc.js: `addEventListener → guard check → execute`. No helper.
- The session restore match logic contains a 4-source URL probe + retry chain (50ms, 250ms, 1000ms microtask stagger) that was called out in `NOTES/sidebery-simplification-plan.md` as the thing to replace. It hasn't been replaced.

### Documentation

drawer.uc.js has genuinely good inline documentation — the compact mode state model comments (lines 257–284) clearly explain the inverted show/hide logic, what was ported from Zen, and why. This is the standard to apply everywhere.

tabs.uc.js is largely uncommented. `handleNormalKey()` (90 lines, 3-level switch nesting) has no docstring. The tree data shape (`treeOf` WeakMap) is never described at the top of the file.

### Magic numbers

| Location | Value | Meaning |
|---|---|---|
| drawer.uc.js:291 | `300` | KEEP_HOVER_DURATION ms |
| drawer.uc.js:309 | `+100` | _ignoreNextHover buffer beyond KEEP_HOVER — undocumented why |
| tabs.uc.js:14 | `14` | INDENT px per tree level |
| tabs.uc.js:65 | `32` | CLOSED_MEMORY max closed tab history |

### Recommended split

| New file | Responsibility |
|---|---|
| `palefox-drawer.uc.js` | Keep as is, but extract compact mode into `palefox-compact.uc.js` |
| `palefox-tabs-model.uc.js` | Tree data, parentId, levelOf, subtreeOf, session persist/restore |
| `palefox-tabs-render.uc.js` | Virtual list, row DOM construction, scroll management |
| `palefox-tabs-input.uc.js` | Vim keybindings, drag-drop, multi-select, search |
| `palefox-tabs-groups.uc.js` | Group management |

This isn't urgent but becomes critical once we start the parentId migration — the current entanglement will make surgical changes very risky.

---

## 1. Multi-window state corruption

### What actually happens

All scripts run as IIFEs with no load-once guard (`palefox-hello.uc.js` has `@onlyonce` but that's just a stub log). When Firefox opens a second window, fx-autoconfig runs `palefox-drawer.uc.js` and `palefox-tabs.uc.js` again in the new window's context.

This is **correct** — each window needs its own sidebar. The IIFE means module-scoped variables (`flashTimer`, `hoverStrip`, `treeOf`, etc.) are per-window instances. There is no shared mutable state between windows at the JS level.

**The real bug is unremoved `Services.prefs.addObserver` registrations.**

`Services.prefs` is a global singleton — its observer registry spans all windows. drawer.uc.js registers observers for `pfx.view.draggable-sidebar` and `pfx.sidebar.compact` (lines 210, 530). Each new window adds more. When window 1 closes, its observers are not removed. They continue firing, with closures that reference window 1's dead DOM nodes. This causes:

1. **Errors when pref changes** — observer fires, accesses `sidebarMain` from closed window 1, throws or silently no-ops depending on GC state.
2. **Memory leak** — the closed window's DOM subtree stays alive as long as the observer closure references it.
3. **Stale state writes** — `Services.prefs.setBoolPref` called from a stale observer could loop with the live window's observer, causing double-toggle.

### Fix

Store observer references and remove them on window unload:

```js
const draggableObserver = { observe() { /* ... */ } };
Services.prefs.addObserver(DRAGGABLE_PREF, draggableObserver);
window.addEventListener("unload", () => {
  Services.prefs.removeObserver(DRAGGABLE_PREF, draggableObserver);
  Services.prefs.removeObserver(COMPACT_PREF, compactObserver);
}, { once: true });
```

This should be done for every `addObserver` call across all scripts. It's not a multi-window corruption in the traditional sense (state isn't shared), but it is a zombie-observer problem that gets worse with each window opened and closed.

---

## 2. Autohide stuck bug — root cause

### Confirmed: MutationObserver leak

`compactEnable()` at line 445–459 creates a `MutationObserver` on `urlbar` watching for `breakout-extend` attribute changes:

```js
function compactEnable() {
  ...
  new MutationObserver(() => {
    if (!sidebarMain.hasAttribute("data-pfx-compact")) return;
    if (urlbar.hasAttribute("breakout-extend")) {
      urlbar.setAttribute("popover", "manual");
      urlbar.showPopover();
    } else {
      urlbar.removeAttribute("popover");
      if (!sidebarMain.matches(":hover")) flashSidebar(KEEP_HOVER_DURATION);
    }
  }).observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
```

**No reference is stored. `compactDisable()` cannot disconnect it.**

Each enable call accumulates a new observer. After the user has toggled compact off/on N times: N observers watch urlbar.

### How this causes stuck state

When `breakout-extend` is added (urlbar focused/expanded), all N observers fire. Observer 1 calls `urlbar.showPopover()` — succeeds, popover shown. Observer 2 calls `urlbar.showPopover()` on an already-shown popover — **throws `InvalidStateError`**. Observers 3–N same.

The HTML popover API fires `toggle` events, not XUL `popupshown`/`popuphidden`. However, the urlbar's autocomplete results panel IS a XUL panel that fires `popupshown`. If `showPopover()` on the urlbar triggers XUL panel events as a side effect, the `_openPopups` counter (lines 322–334) can drift:

- Observer 1: triggers `popupshown` → `_openPopups = 1`
- Observer 2: `showPopover()` throws before any event fires
- Urlbar closes: exactly 1 `popuphidden` fires → `_openPopups = 0`

Under this path, `_openPopups` stays balanced. But there is a second path to stuck state.

### `isGuarded()` permanent lock

```js
function isGuarded() {
  if (_openPopups > 0) return true;
  if (urlbar?.hasAttribute("breakout-extend")) return true;
  if (document.querySelector("toolbarbutton[open='true']")) return true;
  if (document.querySelector(".tabbrowser-tab[multiselected]")) return true;
  if (document.querySelector("[pfx-dragging]")) return true;
  return false;
}
```

`toolbarbutton[open='true']` — any toolbarbutton that gets `open="true"` and doesn't have it removed (popup dismissed abnormally, element removed from DOM while popup open) permanently returns true from `isGuarded()`.

When `isGuarded()` is permanently true, `flashSidebar` runs its setTimeout, which calls `isGuarded()` and skips `setHover(false)`. It then sets `flashTimer = null`. Every subsequent `onSidebarLeave` calls `flashSidebar` again, which (since `flashTimer` is null) calls `setHover(true)` — making the sidebar visible — then schedules another `setHover(false)` that gets blocked. The sidebar flickers to visible on every mouseleave and stays there.

### The actual stuck state: popupshown/popuphidden imbalance

The most robust explanation for "works for 5–10 minutes then stops": a XUL popup somewhere in normal browser use fires `popupshown` and then gets removed from the DOM without firing `popuphidden`. `_openPopups` increments to 1 and never comes back down. This is a known Firefox edge case — dropdowns inside dynamically-removed elements, panels closed by `hidePopupWithoutAnimation`, panels whose parent is detached.

The `_isIgnoredPopup` filter (`e.composedTarget || e.target`) uses `composedTarget` which **is not a standard property**. In Firefox's event model this would be `event.composedPath()[0]` or `event.explicitOriginalTarget`. If `composedTarget` is undefined, the filter falls back to `e.target` — which for tooltip elements is the tooltip's parent, not the tooltip itself. Tooltip events may not be correctly filtered, inflating `_openPopups`.

### Fix

1. **Store and disconnect the urlbar MutationObserver:**

```js
let urlbarCompactObserver = null;

function compactEnable() {
  ...
  if (urlbar && !urlbarCompactObserver) {
    urlbarCompactObserver = new MutationObserver(() => { ... });
    urlbarCompactObserver.observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
  }
}

function compactDisable() {
  urlbarCompactObserver?.disconnect();
  urlbarCompactObserver = null;
  ...
}
```

2. **Add a periodic `_openPopups` sanity reset:**

```js
window.addEventListener("focus", () => {
  // Re-sync counter from actual DOM state on window focus.
  // Guards against phantom increments from closed popups.
  const actualOpen = document.querySelectorAll("panel[panelopen='true'], menupopup[panelopen='true']").length;
  if (_openPopups > actualOpen) _openPopups = actualOpen;
});
```

3. **Fix `_isIgnoredPopup` to use standard API:**

```js
function _isIgnoredPopup(e) {
  const el = e.composedPath?.()?.[0] ?? e.target;
  return el.localName === "tooltip" || el.id === "tab-preview-panel";
}
```

---

## 3. Dev logging mode

### Design

The logging system should be a lightweight pref-gated module, not a third-party library.

**Activation:** `Services.prefs.setBoolPref("pfx.debug", true)` — no restart required. Observers in each script react and enter verbose mode.

**Core API:**

```js
const PFX_DEBUG = Services.prefs.getBoolPref("pfx.debug", false);

function pfxLog(module, event, data = {}) {
  if (!Services.prefs.getBoolPref("pfx.debug", false)) return;
  const state = {
    compact: sidebarMain.hasAttribute("data-pfx-compact"),
    hover: sidebarMain.hasAttribute("pfx-has-hover"),
    guarded: isGuarded(),
    openPopups: _openPopups,
    flashPending: flashTimer !== null,
    ...data,
  };
  console.log(`[PFX:${module}] ${event}`, JSON.stringify(state, null, 2));
}
```

**Instrument key transitions:**

- `setHover(value)` — log value + full state
- `flashSidebar(duration)` — log whether starting fresh or resetting, current guard state
- `compactEnable()` / `compactDisable()` — log full state before and after
- `isGuarded()` — log which guard triggered (not just the boolean)
- `_openPopups` increment/decrement — log the popup element's id/tagName/type
- `onSidebarEnter()` / `onSidebarLeave()` — log `:hover` result and `_ignoreNextHover` state

**DOM state snapshot on stuck detection:**

Add a watchdog: if `pfx-has-hover` is set for more than 10 seconds without the mouse being over the sidebar, log a full DOM state dump and reset:

```js
let hoverWatchdog = null;

function setHover(value) {
  if (value) {
    sidebarMain.setAttribute("pfx-has-hover", "true");
    if (PFX_DEBUG) {
      clearTimeout(hoverWatchdog);
      hoverWatchdog = setTimeout(() => {
        if (!sidebarMain.matches(":hover")) {
          pfxLog("compact", "STUCK_DETECTED — hover set but not hovering, force-clearing", {
            openPopups: _openPopups,
            guardedReason: guardedReason(),
          });
          setHover(false);
          clearFlash();
          _openPopups = 0; // force reset
        }
      }, 10000);
    }
  } else {
    sidebarMain.removeAttribute("pfx-has-hover");
    clearTimeout(hoverWatchdog);
  }
}
```

This gives you: a 10-second auto-recovery in debug mode, and a console log with full context showing exactly what state caused the stuck. The log is the bug report.

**For tabs:** wrap `onTabOpen`, `onTabClose`, `onTabMove`, `buildPanel`, `writeToDisk`, `buildFromSaved` with `pfxLog("tabs", ...)` calls that include the tree's current `parentId` chain and panel order. This makes session restore failures diagnosable from logs alone.

---

## 4. Tab handling: quality assessment and strategy

### Current quality

`palefox-tabs.uc.js` uses the **level-based tree model** — each tab row has a `level` integer, and tree relationships are inferred by scanning adjacent rows. This was identified in `NOTES/sidebery-simplification-plan.md` as the root cause of session restore fragility and drag-drop desync with Firefox's tab order. That migration has not been done.

As a result:
- **Drag-drop** does not call `gBrowser.moveTab`. It only reorders the palefox DOM. Firefox's tab strip order drifts from palefox's panel order over time.
- **Session restore** uses the 4-source URL probe + retry chain (50ms/250ms/1000ms deferrals) that `sidebery-simplification-plan.md` planned to replace with a positional blindspot match.
- **No virtual rendering.** All tab rows are real DOM elements. At 200 tabs this is already measurable.
- **Horizontal mode** is incomplete — there are stub paths and `// TODO` markers.

The code is functional for light use but is not the target architecture. The session restore and drag-drop are the two most fragile parts.

### What to base the replacement on

**Do not copy Firefox's tab rendering code.** Firefox's `MozTabbrowserTabs` is XUL, non-virtual, and tightly coupled to the tab strip's horizontal layout. The `orient` flip is a retrofit. We can do substantially better with our own DOM.

**Do use Firefox as the event bus and source of truth:**
- `gBrowser.tabs` — authoritative linear tab order; never maintain a parallel order
- `TabOpen`, `TabClose`, `TabMove`, `TabSelect`, `TabAttrModified` — the complete event surface; listen to these, not to our own DOM
- `gBrowser.moveTab(tab, index)` — the only way to reorder tabs; routing all moves through this keeps Firefox's native strip in sync
- `SessionStore.setTabValue()` / `getTabValue()` — available to chrome JS without the WebExtension round-trip
- `tab.linkedBrowser.currentURI.spec` — direct URL access, no async

**Do adopt Zen's UX patterns where valid:**
- Workspace scoping via attribute routing — translate to our own mechanism without DOM reparenting
- Essential/always-visible tabs concept — useful UX primitive
- Per-workspace scroll state

**Don't adopt Zen's fork-requiring architecture:**
- No `allTabs` patch — this breaks Firefox internals
- No DOM reparenting of tab elements — our sidebar is our own DOM, separate from Firefox's tab strip
- No build-time patches

**The right model** is described in `NOTES/sidebery-simplification-plan.md` and is essentially Sidebery's data model, natively implemented:

```js
// Per-tab tree metadata stored on the tab element itself
// (or in a WeakMap keyed by tab)
treeData(tab) = { parentId, folded, workspaceId, customTitle }

// Linear order = gBrowser.tabs order (always, without exception)
// Tree = parentId overlay on that order
// Rendering = virtual list, only visible rows in DOM
```

### Native context menu

Currently palefox-tabs builds its own context menu from scratch. This is unnecessary work and produces a worse result — we're reimplementing what Firefox already has, minus the localization, accessibility, and feature coverage.

Firefox's tab context menu is `#tabContextMenu` (defined in `browser-context.inc.xhtml`). In chrome JS we can:

1. Listen to `#tabContextMenu`'s `popupshowing` event
2. Show/hide native items based on our state
3. Add our own items with `document.createXULElement("menuitem")`

Items Firefox provides for free: Close Tab, Close Other Tabs, Close Tabs to the Right, Undo Close Tab, Reopen in Container, Pin Tab, Mute Tab, Duplicate Tab, Move to New Window, Select All Tabs. All localized, all accessible, all maintained by Mozilla.

Items we'd add: Set Parent, Move to Workspace, Collapse Subtree, Close Subtree, Move Subtree to Workspace.

Items we'd hide: Move to New Window (if we don't support cross-window tree operations), any items that don't apply in vertical mode.

This is less code, better UX, and zero maintenance burden on our side for the core items. The drawer.uc.js already does this pattern for the toolbar context menu — the same approach applies to the tab context menu.

---

## Summary: priority order

| Priority | Issue | Effort | Impact |
|---|---|---|---|
| 1 | Fix autohide MutationObserver leak (drawer.uc.js:445) | 30 min | Fixes the stuck bug |
| 2 | Fix pref observer cleanup on window unload | 1 hr | Fixes multi-window zombie leak |
| 3 | Add `pfx.debug` logging mode | 2–3 hr | Makes future bugs diagnosable |
| 4 | parentId migration (per sidebery-simplification-plan.md) | 1–2 days | Fixes restore, drag-drop desync |
| 5 | Virtual list rendering | 1–2 days | Fixes scale |
| 6 | Native context menu adoption | 4–6 hr | Better UX, less code |
| 7 | Split palefox-tabs.uc.js into modules | 1 day | Makes items 4–6 safe to implement |
