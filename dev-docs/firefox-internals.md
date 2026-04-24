# Firefox Internals Reference

This document captures the Firefox APIs, DOM surfaces, and browser behaviors that palefox depends on. It is intended as a reference for anyone working on the codebase — especially before any substantial rewrite — so we don't rediscover these constraints from scratch.

Where a behavior was verified by reading Firefox source (`~/code/firefox`), the source location is noted. Where it was discovered empirically, that is noted instead.

---

## Chrome JS execution environment

Scripts in `chrome/JS/` are loaded by fx-autoconfig (`chrome/utils/`) as privileged chrome scripts. They run in the browser window's JS context with full access to:

- `window`, `document` — the browser chrome window and its XUL document
- `gBrowser` — the browser's tab management object (see below)
- `Services` — XPCOM service registry (`Services.prefs`, `Services.io`, etc.)
- `ChromeUtils` — module import, ES module loading
- `SessionStore` — may or may not be exposed as a global depending on Firefox version; import explicitly via `ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs")`
- `Cu`, `Cc`, `Ci` — XPCOM shorthand (generally not needed for our use)

**When scripts run:** fx-autoconfig runs `@include main` scripts once per browser window at `gBrowserInit.delayedStartupFinished`. Scripts run after most of Firefox's own initialization is complete. Guard on this event if you need to wait for it:

```js
if (gBrowserInit.delayedStartupFinished) {
  init();
} else {
  window.addEventListener("MozAfterPaint", function onPaint() {
    if (!gBrowserInit.delayedStartupFinished) return;
    window.removeEventListener("MozAfterPaint", onPaint);
    init();
  });
}
```

**Script isolation:** Each window gets a fresh IIFE execution. Module-level variables are per-window. There is no shared mutable state between windows at the script level. `Services.prefs` and `Services.io` are global singletons shared across all windows — pref observers registered via `Services.prefs.addObserver` must be removed on `window` unload or they become zombies holding dead window references.

---

## Key DOM elements

These element IDs are stable across Firefox versions we target. All accessed via `document.getElementById(id)`.

| ID | Element type | What it is |
|---|---|---|
| `sidebar-main` | `<sidebar-main>` (LitElement) | Outer sidebar container; owns the tab strip and sidebar panel slots |
| `sidebar-main` (inner) | `<sidebar-main>` custom element | Inside `#sidebar-main` box; has shadow DOM with sidebar tools, resize splitter |
| `navigator-toolbox` | `<toolbox>` | Contains nav-bar, bookmarks bar, etc. Reparented into sidebar in expanded layout |
| `nav-bar` | `<toolbar>` | Toolbar row inside navigator-toolbox; contains urlbar-container and extension buttons |
| `urlbar-container` | `<hbox>` | Wraps `#urlbar`; must stay inside a `<toolbar>` ancestor for urlbar breakout to work |
| `urlbar` | `<hbox>` (UrlbarInput wrapper) | The address bar; has `popover="manual"` set by Firefox so it lives in CSS top layer |
| `tabbrowser-arrowscrollbox` | `<arrowscrollbox>` | Scrollable container for Firefox's native tab elements in vertical mode |
| `tabbrowser-tabs` | `<tabs>` / `MozTabbrowserTabs` | Firefox's tab strip component |
| `browser` | `<browser>` | The content area |
| `identity-box` | `<hbox>` | Security indicator; `classList.contains("notSecure")` for HTTP detection |
| `toolbar-context-menu` | `<menupopup>` | Native toolbar right-click menu; we extend it with our items |

### `#sidebar-main` and `sidebar-launcher-expanded`

`#sidebar-main` is controlled by Firefox's sidebar system. The attribute `sidebar-launcher-expanded` is present when the sidebar is open (vertical tab strip visible). Absent when collapsed. This is the ground-truth signal for sidebar visibility in vertical tab mode.

The inner `<sidebar-main>` custom element is a LitElement with a shadow root. The shadow root contains the resize splitter (`#sidebar-tools-and-extensions-splitter`). To style shadow DOM elements, use `adoptedStyleSheets`:

```js
const sr = sidebarMainElement.shadowRoot;
const sheet = new CSSStyleSheet();
sheet.replaceSync(`#sidebar-tools-and-extensions-splitter { display: none !important; }`);
sr.adoptedStyleSheets.push(sheet);
```

The LitElement registers these event listeners on `#sidebar-main` (empirically discovered):
- `contextmenu` — intercepts right-clicks for sidebar extension management
- `popuphidden` / `popupshown` — tracks menu state
- `sidebar-show` / `sidebar-hide` — panel visibility
- `SidebarItemAdded/Changed/Removed` — sidebar item updates

Any element reparented inside `#sidebar-main` has its events intercepted. Fix: `e.stopPropagation()` on the reparented element for events you don't want reaching the LitElement.

---

## gBrowser

`gBrowser` is the primary interface to Firefox's tab management. It is a `tabbrowser` element exposed as a window global.

### Properties we use

| Property | Type | Notes |
|---|---|---|
| `gBrowser.tabs` | `NodeList` of `MozTabbrowserTab` | All tabs in order; live collection; iterate as `[...gBrowser.tabs]` for stability |
| `gBrowser.selectedTab` | `MozTabbrowserTab` | The currently active tab; writable — assignment switches the active tab |
| `gBrowser.selectedBrowser` | `<browser>` | `linkedBrowser` of the selected tab |
| `gBrowser.tabContainer` | `MozTabbrowserTabs` | The tab strip element; source of tab events |

### Methods we use

**`gBrowser.addTab(url, options)`** — creates a new tab. Returns the `MozTabbrowserTab`. Key options: `{ relatedToCurrent, ownerTab, triggeringPrincipal }`. For new tabs from palefox use `{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }` or omit for user-initiated.

**`gBrowser.removeTab(tab, options)`** — closes a tab. Options: `{ animate, skipPermitUnload }`. Fires `TabClose` synchronously before removal.

**`gBrowser.moveTab(tab, index)`** — moves tab to position `index` in `gBrowser.tabs`. **This is the only correct way to reorder tabs** — it keeps Firefox's internal tab order, the native tab strip, and SessionStore all in sync. Fires `TabMove` after. Note: Firefox fires `TabMove` multiple times per move for some transitions (verified in `tabbrowser.js:4018`); filter on `detail.fromIndex !== detail.toIndex`.

**`gBrowser.duplicateTab(tab)`** — creates a duplicate of `tab` next to it. Returns the new tab.

### Tab object (`MozTabbrowserTab`)

Tab elements are XUL `<tab>` elements extended with `MozTabbrowserTab`. Key properties and attributes:

| Property / Attribute | How to read | Notes |
|---|---|---|
| `tab.label` | `.label` property | Display title; may lag behind actual page title |
| `tab.selected` | `.selected` property or `[selected]` attr | Whether this is the active tab |
| `tab.pinned` | `.pinned` property or `[pinned]` attr | Whether pinned |
| `tab.hidden` | `.hidden` property | Whether hidden from tab strip |
| `tab.getAttribute("image")` | attribute | Favicon URL; may be `""` for default |
| `tab.hasAttribute("busy")` | attribute | Tab is loading; Firefox toggles this during `gBrowser.moveTab` animations — skip syncing `busy` for tabs in `movingTabs` set |
| `tab.hasAttribute("pending")` | attribute | Session-restored tab not yet loaded; `linkedBrowser.currentURI` will be `about:blank` |
| `tab.linkedBrowser` | property | The `<browser>` content element for this tab |
| `tab.linkedBrowser.currentURI.spec` | property chain | Current URL; `"about:blank"` for pending/lazy tabs |
| `tab.owner` | property | Direct reference to the opener tab; nulled by Firefox when exiting "interrupt mode" (`tabbrowser.js:3307`); do not rely on persistence |

**`tab.owner` is not persistent.** Firefox nulls it on `this.selectedTab.owner = null` at `tabbrowser.js:3307` when leaving interrupt mode. Do not use `tab.owner` as a substitute for `parentId` — it is ephemeral and loses its value during normal browsing.

---

## Tab events

All fired on `gBrowser.tabContainer`. Listen with:

```js
gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
```

| Event | `event.target` | Key detail properties | Notes |
|---|---|---|---|
| `TabOpen` | the new tab | — | Fires after tab is in `gBrowser.tabs` but browser may not be navigated yet |
| `TabClose` | the closing tab | — | Fires before tab is removed from `gBrowser.tabs` |
| `TabMove` | the moved tab | `detail.fromIndex`, `detail.toIndex` | **Fires multiple times per operation** — filter `fromIndex !== toIndex` |
| `TabSelect` | the newly selected tab | — | Fires after `gBrowser.selectedTab` changes |
| `TabAttrModified` | the modified tab | `detail.changed` (array of attr names) | Fires for: `image`, `label`, `busy`, `soundplaying`, `muted`, `pinned`, `sharing`, `pictureinpicture` |
| `TabPinned` | the tab | — | Subset of TabAttrModified; fires when `pinned` changes to true |
| `TabUnpinned` | the tab | — | When `pinned` changes to false |
| `TabShow` | the tab | — | When `tab.hidden` becomes false |
| `TabHide` | the tab | — | When `tab.hidden` becomes true |
| `TabGrouped` | the tab | — | Tab added to a group |
| `TabUngrouped` | the tab | — | Tab removed from a group |

### `TabOpen` timing

When `TabOpen` fires, the tab exists in `gBrowser.tabs` but:
- `tab.linkedBrowser.currentURI.spec` may still be `"about:blank"` for a moment
- `tab.getAttribute("image")` may be empty
- For session-restored tabs, `tab.hasAttribute("pending")` is true and the browser will not navigate until the tab is activated

To get the real URL of a pending tab, use SessionStore:

```js
function tabUrl(tab) {
  const spec = tab.linkedBrowser?.currentURI?.spec;
  if (spec && spec !== "about:blank") return spec;
  try {
    const state = JSON.parse(SS.getTabState(tab));
    const entries = state.entries;
    return entries?.[state.index - 1]?.url || "";
  } catch { return ""; }
}
```

### `TabMove` fires multiple times

Verified in `tabbrowser.js:4018` — comment explicitly warns of this. Any `TabMove` handler must guard:

```js
function onTabMove(e) {
  if (e.detail.fromIndex === e.detail.toIndex) return;
  // ... handle move
}
```

---

## SessionStore

### What's available in chrome JS

`SessionStore` is accessible via:

```js
const SS = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
).SessionStore;
```

Or as a global `SessionStore` in some Firefox builds — check both.

### Methods we use

**`SS.getTabState(tab)`** — returns a JSON string of the tab's session state including `entries` (history stack), current `index`, and persisted attributes. Used to read the real URL of a pending/lazy tab before it loads.

**`SS.persistTabAttribute(attrName)`** — registers a tab DOM attribute for automatic persistence across sessions. Firefox's SessionStore saves and restores the attribute value on every tab. After calling this with `"pfx-id"`, any `tab.setAttribute("pfx-id", value)` survives browser restart and `undoCloseTab`. This is our mechanism for stable cross-session tab identity.

**Caveat:** `persistTabAttribute` may not be available in all builds. Always guard:

```js
if (SS?.persistTabAttribute) {
  try { SS.persistTabAttribute("pfx-id"); }
  catch (e) { /* falls back to URL matching */ }
}
```

### What is NOT available in chrome JS that Sidebery uses

Sidebery uses `browser.sessions.setTabValue()` / `getTabValue()` from the WebExtension API, which can store arbitrary JSON per tab. This is NOT available to chrome scripts. The chrome equivalent is `SS.persistTabAttribute` (attribute-based, strings only) + `SS.getTabState` (read-only for session data). Writing arbitrary structured data per tab requires either:
1. A DOM attribute per field (limited to strings, pollutes the DOM)
2. A separate JSON file written to the profile directory via `IOUtils`
3. `Services.prefs` for small amounts of data

---

## Services.prefs

```js
Services.prefs.getBoolPref(key, default)
Services.prefs.setBoolPref(key, value)
Services.prefs.getIntPref(key, default)
Services.prefs.setIntPref(key, value)
Services.prefs.getCharPref(key, default)
Services.prefs.setCharPref(key, value)
```

**`addObserver(key, observer)`** — fires `observer.observe(subject, topic, key)` when pref changes. **Registered globally — must be removed on window unload:**

```js
const obs = { observe() { /* ... */ } };
Services.prefs.addObserver("pfx.my.pref", obs);
window.addEventListener("unload", () => {
  Services.prefs.removeObserver("pfx.my.pref", obs);
}, { once: true });
```

Failure to remove: observer holds a closure reference to the window's DOM. After the window closes, subsequent pref changes fire the observer against dead DOM nodes — errors, memory leaks, or silent corruption.

---

## XUL elements

`document.createXULElement(tagName)` creates a XUL element. Key elements we use:

| Tag | Use | Key attributes |
|---|---|---|
| `hbox` | Horizontal flex container | `align="center"` for vertical centering |
| `vbox` | Vertical flex container | — |
| `box` | Generic container | `orient` for axis |
| `label` | Text node | `value="..."` (not textContent), `crop="end"` for ellipsis, `flex="1"` to fill |
| `image` | Icon/image | `src="..."` for URL, or CSS `list-style-image` |
| `toolbar` | Toolbar container | Required ancestor for urlbar breakout |
| `toolbarbutton` | Clickable toolbar button | `tooltiptext`, `context` for right-click menu |
| `menupopup` | Popup menu container | `openPopupAtScreen(x, y, isContext)` to open |
| `menuitem` | Menu item | `label`, `command` event |
| `menuseparator` | Separator line | — |

XUL `<label>` uses `value` attribute, not `textContent`. Setting `textContent` on a label inserts a text node child and breaks the `crop` attribute.

---

## Urlbar breakout system

Documented in `docs/dev-notes.md`. Summary:

Firefox's urlbar has a "breakout" system that pops it out of its container when focused to display the autocomplete dropdown. It has two hard constraints:

1. **`closest("toolbar")` gate** (`UrlbarInput.mjs:487`): If `#urlbar-container` doesn't have a `<toolbar>` ancestor, `#allowBreakout` is false and the dropdown is completely disabled. When we move `#urlbar-container` out of `#nav-bar`, we must reparent it into a new `<toolbar>` element we create (`pfx-urlbar-toolbar`).

2. **`popover="manual"` top layer** (`UrlbarInput.mjs`): Firefox sets `popover="manual"` on `#urlbar` so that the breakout renders above everything including fixed-position elements. When compact mode is active and the sidebar has CSS `transform`, the popover must be removed (removing it from the top layer so it transforms with the sidebar) and restored when breakout opens.

The `breakout-extend` attribute on `#urlbar` is the signal that the dropdown is open. Watch it with a MutationObserver to manage the popover toggle.

---

## Popover top layer

Firefox uses the CSS top layer (via `popover="manual"`) for the urlbar dropdown. Elements in the top layer are immune to ancestor `transform`, `overflow`, and `z-index`. This means:

- If the sidebar has `transform: translateX(...)` for slide animation, the urlbar dropdown will NOT move with it — it stays at its original screen position.
- Fix: `urlbar.removeAttribute("popover")` while the sidebar is in compact/sliding state; re-add `popover="manual"` and call `urlbar.showPopover()` when the urlbar is about to break out.
- `urlbar.showPopover()` throws `InvalidStateError` if the popover is already shown. Guard with `urlbar.matches(":popover-open")` before calling.

---

## MutationObserver patterns

### What we observe and why

| Target | Options | Purpose |
|---|---|---|
| `#sidebar-main` | `{ attributes: true, attributeFilter: ["sidebar-launcher-expanded"] }` | Detect sidebar expand/collapse to run `expand()` / `collapse()` |
| `#sidebar-main` | `{ attributes: true, attributeFilter: ["sidebar-launcher-expanded"] }` | Sync sidebar width on change |
| `#urlbar` | `{ attributes: true, attributeFilter: ["style"] }` | Sync urlbar width when Firefox updates `--urlbar-width` |
| `#urlbar` | `{ attributes: true, attributeFilter: ["breakout-extend"] }` | Toggle `popover` attribute for compact mode compatibility |
| `#tabbrowser-arrowscrollbox` | `{ childList: true }` | Update drag overlay position when tabs are added/removed |
| `#identity-box` | `{ attributes: true, attributeFilter: ["class"] }` | Detect HTTP/HTTPS state change for insecure banner |

### Lifecycle rule

Every `MutationObserver` that is created conditionally (e.g., inside `compactEnable()`) must have its reference stored and must be disconnected in the corresponding teardown function. Creating observers inside toggle functions without storing the reference causes accumulation — each enable call adds a new observer that cannot be cleaned up.

```js
// Correct pattern
let myObserver = null;

function enable() {
  if (myObserver) return; // guard against double-enable
  myObserver = new MutationObserver(handler);
  myObserver.observe(target, options);
}

function disable() {
  myObserver?.disconnect();
  myObserver = null;
}
```

---

## Popup event system

Firefox XUL popups fire `popupshown` and `popuphidden` on `document` (bubbling). These are XUL events, distinct from the HTML Popover API's `toggle` event.

- `popupshown` fires when a `<menupopup>`, `<panel>`, or similar XUL popup becomes visible
- `popuphidden` fires when it closes
- `event.target` is the popup element itself

**Tooltips** fire these events constantly and must be excluded from any popup-count logic. Test `el.localName === "tooltip"` to filter. Use `event.composedPath()[0]` (not `event.composedTarget`, which is not a standard property) to get the actual element across shadow DOM boundaries.

**Mismatched events:** If a popup element is removed from the DOM while open (e.g., dynamically created menus), `popuphidden` may not fire. Any counter tracking open popups must have a safety drain (e.g., reset on `window` focus, or clamp to 0 on underflow — `Math.max(0, count - 1)`).

---

## File persistence (IOUtils)

For writing JSON state to the Firefox profile directory:

```js
const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
const filePath = PathUtils.join(profileDir, "palefox-tab-tree.json");

// Write
await IOUtils.writeJSON(filePath, data);

// Read
const data = await IOUtils.readJSON(filePath);
```

`IOUtils` is a global in chrome scripts. `PathUtils.join` handles platform path separators. Write is atomic (writes to a temp file, then renames). Both are async.
