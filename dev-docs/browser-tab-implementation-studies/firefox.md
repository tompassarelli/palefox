# Firefox Tab & Sidebar System: Reference

This document serves two purposes: a case study of how Firefox's native vertical tabs work (and why they fall short of our goals), and a comprehensive reference for the Firefox APIs, DOM surfaces, and browser behaviors we build on in chrome JS. Source references point to `~/code/firefox`.

---

## Part 1: Vertical Tabs — Case Study

### Architecture

Firefox vertical tabs are a **layout orientation toggle** on the existing horizontal tab strip, not a separate component. The preference `sidebar.verticalTabs` (managed in `browser/components/sidebar/SidebarManager.sys.mjs:11`) switches rendering orientation.

`toggleTabstrip()` (`browser/components/sidebar/browser-sidebar.js:2240–2279`) **does not reparent any DOM**. It only:
- Sets `arrowScrollbox.setAttribute("orient", "vertical")` (line 2255)
- Sets `tabStrip.setAttribute("orient", "vertical")` (line 2256)
- Toggles CSS visibility of the vertical toolbar element (line 2267)

The tab strip stays in place. Vertical mode is CSS flexbox axis flipped via `orient` attribute — a shallow retrofit, not a redesign.

### Data model

- `MozTabbrowserTabs` (`tabbrowser/content/tabs.js:18`) — the tab strip web component
- `MozTabbrowserTab` (`tabbrowser/content/tab.js:15`) — individual tab elements
- `MozTabbrowserTabGroup` (`tabbrowser/content/tabgroup.js:14`) — collapsible group wrappers with label and color; contains tabs via `<html:slot/>` (line 21). **Groups cannot be nested.**
- `gBrowser.tabs` — authoritative linear NodeList in document order

**Two separate tab relationship systems, both limited:**

1. `tab.owner` / `openerTab` — single-level direct reference to opener. Used for tab selection on close. **Nulled** when Firefox exits interrupt mode (`tabbrowser.js:3307`: `this.selectedTab.owner = null`). Not persistent across sessions.
2. **Successor chain** — `setSuccessor()` and `predecessors` Set (`tabbrowser.js:9064–9093`). Drives tab history navigation. Single-direction linked list, not a tree.

`_lastRelatedTabMap` is an ephemeral WeakMap reset on tab close (`tabbrowser.js:1664`). Not a persistent relationship store.

### Rendering

All visible tabs are real DOM nodes — no virtual scrolling, no recycling. Tabs are appended at creation (`tabbrowser.js:4555, 4579, 4593`). Lazy *content* restoration (deferred page load) exists but does not reduce DOM node count. 500 tabs = 500 DOM elements always.

### Event flow

Events handled in `MozTabbrowserTabs.handleEvent` (`tabs.js:250`):
- `TabSelect` (line 286) — updates selection, scrolls to tab
- `TabClose` (line 300) — removes tab element
- `TabAttrModified`, `TabHide`, `TabShow` — update focusable item list
- `TabGroupExpand` / `TabGroupCollapse` — toggle group visibility

**TabMove fires multiple times per operation** (`tabbrowser.js:4018`: explicit comment). Filter on `detail.fromIndex !== detail.toIndex`.

### Autohide sidebar

`sidebar.visibility = "expand-on-hover"` is not CSS-only. It has a full JS state machine (`browser-sidebar.js:2281–2327`): `onMouseEnter()` / `onMouseLeave()`, `debouncedMouseEnter()` via `DeferredTask`, `MousePosTracker.addListener()` (line 2395).

### Persistence

- `sidebar.verticalTabs` pref — `XPCOMUtils.defineLazyPreferenceGetter` (`SidebarManager.sys.mjs:37–45`)
- `sidebar.visibility` pref — reverts to `"hide-sidebar"` on vertical disable (`SidebarManager.sys.mjs:234, 243`)
- Tab state: `SessionStore.setTabState()` (`tabbrowser.js:3413`)
- Tab groups: `SessionStore.getSavedTabGroup()` / `forgetSavedTabGroup()` (`tabbrowser.js:3856–3860`)

### Problems vs ideal model

**No tree hierarchy.** No `parentId`, no nesting depth, no subtree concept. Groups are flat labeled containers. `openerTab` is ephemeral and single-level.

**Non-virtual DOM.** 500 tabs = 500 DOM elements. Same scaling failure as Sidebery.

**Vertical mode is unfinished.** `orient` flip is a retrofit. D&D, keyboard nav, and group animations all have known vertical-mode bugs. `tabbrowser.js:4473` guards `!this.tabContainer.verticalMode` indicating some divergent paths — but the architecture is not redesigned.

**No workspace isolation.** Tab groups are cosmetic; no mechanism to scope tab display to a context.

**What it gives us.** `gBrowser.tabs` as authoritative linear order; `TabMove`/`TabOpen`/`TabClose`/`TabSelect` events directly; `gBrowser.moveTab` for programmatic reordering; SessionStore without the WebExtension round-trip. These are the foundations we build on.

### Key source files

| Component | File | Lines |
|---|---|---|
| Tab strip | `tabbrowser/content/tabs.js` | 18, 64–99, 250–300 |
| Tab element | `tabbrowser/content/tab.js` | 15–46 |
| Tab group | `tabbrowser/content/tabgroup.js` | 14–80 |
| Core tabbrowser | `tabbrowser/content/tabbrowser.js` | 3307, 3413, 3856–3860, 4018, 9064–9093 |
| Orientation toggle | `sidebar/browser-sidebar.js` | 2240–2327 |
| Sidebar prefs | `sidebar/SidebarManager.sys.mjs` | 11, 37–45, 225–246 |

---

## Part 2: Full API Reference

### `gBrowser`

`gBrowser` is the browser's tab management object, exposed as a window global. It is a `tabbrowser` element.

#### Properties

| Property | Type | Notes |
|---|---|---|
| `gBrowser.tabs` | live `NodeList` of `MozTabbrowserTab` | Authoritative linear tab order. Iterate as `[...gBrowser.tabs]` — the live collection shifts under iteration during mutations. |
| `gBrowser.selectedTab` | `MozTabbrowserTab` | Active tab. **Writable** — assigning switches the active tab. |
| `gBrowser.selectedBrowser` | `<browser>` | `linkedBrowser` of the selected tab. |
| `gBrowser.tabContainer` | `MozTabbrowserTabs` | The tab strip component. Source of all tab events. |

#### Methods

**`gBrowser.addTab(url, options)`**
Creates a new tab. Returns `MozTabbrowserTab`. Key options:
- `{ relatedToCurrent }` — places tab near the current tab per Firefox's placement rules
- `{ ownerTab }` — sets `tab.owner` on the new tab
- `{ triggeringPrincipal }` — use `Services.scriptSecurityManager.getSystemPrincipal()` for chrome-initiated tabs

**`gBrowser.removeTab(tab, options)`**
Closes a tab. Fires `TabClose` before removal. Options: `{ animate, skipPermitUnload }`.

**`gBrowser.moveTab(tab, toIndex)`**
Moves tab to position `toIndex` in `gBrowser.tabs`. **This is the only correct way to reorder tabs** — it keeps Firefox's internal order, the native tab strip, and SessionStore in sync. Fires `TabMove` after. Because TabMove fires multiple times per operation, filter on `detail.fromIndex !== detail.toIndex`.

**`gBrowser.duplicateTab(tab)`**
Creates a duplicate of `tab` placed next to it. Returns the new tab.

**`gBrowser.setInitialTabTitle(tab, title)`**
Sets a tab's title before page load completes. Useful for named group tabs or placeholder tabs.

**`gBrowser.getBrowserForTab(tab)`**
Returns the `<browser>` element for a tab. Equivalent to `tab.linkedBrowser`.

---

### `MozTabbrowserTab` — the tab object

Tab elements are XUL `<tab>` elements extended by `MozTabbrowserTab` (`tabbrowser/content/tab.js`). They live in `gBrowser.tabs` and in the DOM.

#### Properties

| Property | Notes |
|---|---|
| `tab.label` | Display title. May lag behind actual page title by one event cycle. |
| `tab.selected` | Boolean. Whether this is the active tab. Also reflected as `[selected]` attribute. |
| `tab.pinned` | Boolean. Reflected as `[pinned]` attribute. |
| `tab.hidden` | Boolean. Whether hidden from tab strip. |
| `tab.owner` | Direct reference to opener tab. **Nulled by Firefox on interrupt mode exit** (`tabbrowser.js:3307`). Do not rely on persistence. |
| `tab.group` | The `MozTabbrowserTabGroup` this tab belongs to, or `null`. |
| `tab.linkedBrowser` | The `<browser>` content element for this tab. |

#### Attributes (read via `tab.getAttribute`, `tab.hasAttribute`)

| Attribute | Notes |
|---|---|
| `image` | Favicon URL. Empty string for default favicon. |
| `busy` | Tab is loading. Firefox toggles this during `gBrowser.moveTab` animation — a brief spurious `busy=true` fires during every move. Skip syncing `busy` for tabs currently being moved programmatically. |
| `pending` | Session-restored tab not yet loaded. `linkedBrowser.currentURI` will be `"about:blank"`. Use SessionStore to read the real URL. |
| `selected` | Active tab. |
| `pinned` | Pinned tab. |
| `soundplaying` | Tab is producing audio. |
| `muted` | Tab audio is muted. |
| `sharing` | Tab is sharing camera/mic/screen. |
| `pictureinpicture` | Tab has a PiP window open. |
| `pfx-id` | Palefox-specific. Our stable cross-session tab identity, persisted via `SS.persistTabAttribute("pfx-id")`. |

#### Reading tab URL (including pending tabs)

`tab.linkedBrowser.currentURI.spec` returns `"about:blank"` for pending/lazy-restored tabs. To get the real URL:

```js
function tabUrl(tab) {
  const spec = tab.linkedBrowser?.currentURI?.spec;
  if (spec && spec !== "about:blank") return spec;
  try {
    const state = JSON.parse(SS.getTabState(tab));
    const entries = state.entries;
    return entries?.[state.index - 1]?.url ?? "";
  } catch { return ""; }
}
```

---

### Tab events

All events fire on `gBrowser.tabContainer` and bubble. Listen with:

```js
gBrowser.tabContainer.addEventListener("TabOpen", handler);
```

#### Complete event table

| Event | `event.target` | `event.detail` | When |
|---|---|---|---|
| `TabOpen` | new tab | `{ adoptedTab? }` | After tab exists in `gBrowser.tabs`; browser may not yet be navigated |
| `TabClose` | closing tab | `{ adoptedByWindow? }` | Before tab is removed from `gBrowser.tabs` |
| `TabMove` | moved tab | `{ fromIndex, toIndex }` | After move; **fires multiple times per operation** |
| `TabSelect` | newly active tab | — | After `gBrowser.selectedTab` updates |
| `TabAttrModified` | modified tab | `{ changed: string[] }` | When any tracked attribute changes; `changed` lists which |
| `TabPinned` | tab | — | When `pinned` becomes true |
| `TabUnpinned` | tab | — | When `pinned` becomes false |
| `TabShow` | tab | — | When `tab.hidden` becomes false |
| `TabHide` | tab | — | When `tab.hidden` becomes true |
| `TabGrouped` | tab | — | Tab added to a `MozTabbrowserTabGroup` |
| `TabUngrouped` | tab | — | Tab removed from a group |
| `TabGroupCreate` | group | — | New group created |
| `TabGroupRemove` | group | — | Group removed |
| `TabGroupCollapse` | group | — | Group collapsed |
| `TabGroupExpand` | group | — | Group expanded |

#### `TabAttrModified` — tracked attributes

`event.detail.changed` is an array of the attribute names that changed in this batch. Attributes tracked: `image`, `label`, `busy`, `soundplaying`, `muted`, `pinned`, `sharing`, `pictureinpicture`. Use this instead of separate MutationObservers on individual tabs.

#### `TabOpen` timing

When `TabOpen` fires:
- The tab exists in `gBrowser.tabs` at its final index
- `tab.linkedBrowser.currentURI` may be `about:blank`
- `tab.getAttribute("image")` may be empty
- For session-restored tabs: `tab.hasAttribute("pending")` is true; the browser does not navigate until the tab is activated

#### `TabMove` fires multiple times

`tabbrowser.js:4018` has an explicit comment warning of this. Every `TabMove` handler must guard:

```js
function onTabMove(e) {
  if (e.detail.fromIndex === e.detail.toIndex) return;
  // safe to process
}
```

#### `TabClose` and `gBrowser.tabs`

When `TabClose` fires, `event.target` is still in `gBrowser.tabs`. The tab is removed from `gBrowser.tabs` after the event completes. It is safe to read `[...gBrowser.tabs].indexOf(tab)` inside a `TabClose` handler.

---

### `MozTabbrowserTabGroup` — tab groups

`tabbrowser/content/tabgroup.js:14`. Collapsible containers for tabs. Not nestable. Contains tabs via Web Component `<html:slot/>` — tabs are slotted into the group, not DOM-children of it.

```js
tab.group           // the group this tab belongs to, or null
group.label         // display name
group.color         // color key (string)
group.collapsed     // boolean; setting this collapses/expands
group.tabs          // array of member tabs
```

Groups are not a tree. They are flat named collections. `tab.group` is the only relationship — there is no parent group or nested group concept.

---

### SessionStore

#### Accessing from chrome JS

`SessionStore` is not reliably exposed as a global in all Firefox builds. Import explicitly:

```js
const SS = (() => {
  try { if (typeof SessionStore !== "undefined") return SessionStore; } catch {}
  try {
    return ChromeUtils.importESModule(
      "resource:///modules/sessionstore/SessionStore.sys.mjs"
    ).SessionStore;
  } catch (e) {
    console.error("SessionStore unavailable", e);
    return null;
  }
})();
```

#### Methods

**`SS.getTabState(tab)`** → JSON string
Returns the full session state for a tab: `{ entries, index, attributes, ... }`. `entries[index - 1].url` is the real URL for pending tabs. This is the only way to read the URL of a lazy-restored tab before it loads.

**`SS.setTabState(tab, stateJSON)`**
Replaces a tab's session state. Not commonly needed; prefer attribute-based approaches.

**`SS.persistTabAttribute(attrName)`**
Registers a tab DOM attribute for automatic session persistence. After calling this, any `tab.setAttribute(attrName, value)` survives browser restart, `undoCloseTab`, and `undoCloseWindow`. Firefox writes and restores the attribute as part of normal session handling.

```js
SS.persistTabAttribute("pfx-id"); // call once at startup
tab.setAttribute("pfx-id", "42"); // now survives restarts
```

This is the only clean mechanism for stable cross-session tab identity in chrome JS. The WebExtension equivalent (`browser.sessions.setTabValue`) is not available to chrome scripts.

**Caveat:** `persistTabAttribute` may be absent in some builds. Guard:
```js
if (SS?.persistTabAttribute) {
  try { SS.persistTabAttribute("pfx-id"); } catch {}
}
```

**`SS.getSavedTabGroup(groupId)`** / **`SS.forgetSavedTabGroup(groupId)`**
Reads/removes a saved tab group from session state. Used internally by Firefox; not needed for our tab tree model.

#### What is NOT available in chrome JS

The WebExtension API `browser.sessions.setTabValue()` / `getTabValue()` stores arbitrary JSON per tab. This is **not accessible from chrome scripts**. Alternatives for structured per-tab data:
1. `SS.persistTabAttribute` — strings only, one attribute per field, survives sessions
2. A JSON file in the profile directory via `IOUtils` — arbitrary structure, manual read/write
3. `Services.prefs` — for small amounts of non-tab-specific data

---

### The sidebar system

#### Key elements

| Element | How to get | Notes |
|---|---|---|
| `#sidebar-main` | `document.getElementById("sidebar-main")` | Outer XUL container box; owns layout |
| `<sidebar-main>` | `sidebarMain.querySelector("sidebar-main")` | Inner LitElement with shadow DOM |
| Shadow root | `sidebarMainElement.shadowRoot` | Contains resize splitter, sidebar tools |

#### `sidebar-launcher-expanded` attribute

Present on `#sidebar-main` when the sidebar is open (vertical tab strip visible). Absent when collapsed. This is the ground-truth signal for sidebar expand/collapse state in vertical mode. Monitor with a MutationObserver:

```js
new MutationObserver(() => {
  const expanded = sidebarMain.hasAttribute("sidebar-launcher-expanded");
  // react to state change
}).observe(sidebarMain, { attributes: true, attributeFilter: ["sidebar-launcher-expanded"] });
```

#### Shadow DOM styling

The LitElement's shadow root is not reachable via normal CSS. Use `adoptedStyleSheets`:

```js
const sheet = new CSSStyleSheet();
sheet.replaceSync(`#sidebar-tools-and-extensions-splitter { display: none !important; }`);
sidebarMainElement.shadowRoot.adoptedStyleSheets.push(sheet);
```

The shadow root may not exist immediately at script load time if the LitElement hasn't upgraded yet. Poll:

```js
function hideSplitter() {
  const sr = sidebarMainElement?.shadowRoot;
  if (!sr) return setTimeout(hideSplitter, 100);
  // apply stylesheet
}
```

#### LitElement event interception

`<sidebar-main>` registers these listeners on `#sidebar-main` in its `connectedCallback`:
- `contextmenu` — intercepts for extension management context menu
- `popuphidden` / `popupshown` — menu state tracking
- `sidebar-show` / `sidebar-hide` — panel visibility
- `SidebarItemAdded/Changed/Removed` — sidebar content updates

Any element reparented inside `#sidebar-main` has these events intercepted. Fix: `e.stopPropagation()` on the child element for events that should not reach the LitElement.

#### Relevant sidebar prefs

| Pref | Type | Notes |
|---|---|---|
| `sidebar.verticalTabs` | bool | Whether vertical tabs mode is active |
| `sidebar.visibility` | string | `"always-show"` / `"expand-on-hover"` / `"hide-sidebar"` |
| `sidebar.main.tools` | string | Comma-separated list of enabled sidebar tools |

---

### The urlbar and its breakout system

Source: `browser/components/urlbar/UrlbarInput.mjs`. Also documented in `docs/dev-notes.md`.

#### `closest("toolbar")` gate

`UrlbarInput.mjs:487`:
```js
this.#allowBreakout = !!this.closest("toolbar") && !document.documentElement.hasAttribute("customizing");
```
`#allowBreakout` is set once at initialization. If `#urlbar-container` lacks a `<toolbar>` ancestor at that moment, the autocomplete dropdown is **permanently disabled** for the session. Moving `#urlbar-container` out of `#nav-bar` requires first wrapping it in a new `<toolbar>` element.

#### `breakout-extend` attribute

Added to `#urlbar` when the dropdown is open. Removed when closed. The urlbar positions and sizes itself based on this attribute. Monitor it to manage popover state:

```js
new MutationObserver(() => {
  if (urlbar.hasAttribute("breakout-extend")) {
    // dropdown opened
  } else {
    // dropdown closed
  }
}).observe(urlbar, { attributes: true, attributeFilter: ["breakout-extend"] });
```

#### `popover="manual"` and the CSS top layer

Firefox sets `popover="manual"` on `#urlbar` so the dropdown renders above everything — including fixed-position elements and CSS `transform` containers. Elements in the top layer ignore ancestor `transform`, `overflow`, and `z-index`.

This conflicts with sidebar slide animations: if the sidebar has `transform: translateX(...)`, the urlbar dropdown stays at its original screen position rather than moving with the sidebar.

Fix pattern used in palefox:
1. In compact/slide mode: `urlbar.removeAttribute("popover")` — removes it from the top layer, making it transform with its parent
2. When `breakout-extend` is added: `urlbar.setAttribute("popover", "manual"); urlbar.showPopover()` — returns it to the top layer for the dropdown
3. When `breakout-extend` is removed: `urlbar.removeAttribute("popover")` — back out of top layer

**`urlbar.showPopover()` throws `InvalidStateError` if already shown.** Guard:
```js
if (!urlbar.matches(":popover-open")) urlbar.showPopover();
```

#### Width sync

Firefox's `UrlbarInput.mjs` periodically sets `--urlbar-width` on `#urlbar` via a `ResizeObserver` on `#urlbar-container`. When the urlbar is inside the sidebar, this value may not reflect the sidebar's actual width. Override with a `ResizeObserver` on `#sidebar-main`:

```js
new ResizeObserver(() => {
  if (!urlbar.hasAttribute("breakout-extend")) {
    const w = sidebarMain.getBoundingClientRect().width - inset * 2;
    urlbar.style.setProperty("--urlbar-width", w + "px");
  }
}).observe(sidebarMain);
```

---

### `#navigator-toolbox` reparenting

Moving `#navigator-toolbox` into `#sidebar-main` as a child works for most purposes. Known behaviors:

| Feature | Status |
|---|---|
| Toolbar button icons/layout | Works |
| Button click handlers | Works — event listeners move with elements |
| `getElementById` lookups | Works — IDs unchanged |
| Right-click context menus | **Requires fix** — see below |
| Urlbar breakout | **Requires fix** — see urlbar section above |

**Context menu fix.** After reparenting, `contextmenu` events from toolbar buttons bubble up to `<sidebar-main>`'s listener, which handles them as sidebar context actions. Fix:

```js
navigatorToolbox.addEventListener("contextmenu", (e) => {
  if (navigatorToolbox.parentNode === sidebarMain) e.stopPropagation();
});
```

The native toolbar context menu still works because it's wired via `context="toolbar-context-menu"` attribute on `#nav-bar`, not via event bubbling.

---

### XUL elements

`document.createXULElement(tagName)` creates XUL elements. They participate in XUL layout (flex, box model) which differs from HTML layout.

#### Elements we use

| Tag | Use | Key attributes |
|---|---|---|
| `hbox` | Horizontal flex row | `align="center"` for vertical centering of children |
| `vbox` | Vertical flex column | — |
| `box` | Generic flex container | `orient="horizontal\|vertical"` |
| `label` | Text display | `value="..."` (**not** `textContent`), `crop="end"` for ellipsis, `flex="1"` to fill |
| `image` | Icon/image | `src="..."` or CSS `list-style-image` |
| `toolbar` | Toolbar row | Required `<toolbar>` ancestor for urlbar breakout |
| `toolbarbutton` | Clickable button | `tooltiptext`, `context` for right-click menu ID |
| `menupopup` | Popup menu | `.openPopupAtScreen(x, y, isContext)` to open |
| `menuitem` | Menu entry | `label`, listens to `command` event |
| `menuseparator` | Separator | — |

#### XUL `<label>` — use `value`, not `textContent`

XUL labels display text via the `value` attribute. Setting `textContent` inserts a text node child which overrides `value` and breaks `crop="end"`. Always:
```js
label.setAttribute("value", "My Title");  // correct
label.textContent = "My Title";            // breaks crop
```

#### XUL `flex`

XUL flex is similar to CSS flexbox but uses the `flex` attribute on children, not CSS. `flex="1"` makes an element expand to fill available space. `align="center"` on the container vertically centers children.

---

### `Services.prefs`

```js
Services.prefs.getBoolPref(key, defaultValue)   // → boolean
Services.prefs.setBoolPref(key, value)
Services.prefs.getIntPref(key, defaultValue)    // → integer
Services.prefs.setIntPref(key, value)
Services.prefs.getCharPref(key, defaultValue)   // → string
Services.prefs.setCharPref(key, value)
```

**`addObserver(key, observer)`**
Fires `observer.observe(subject, topic, key)` when the pref changes. Observer is registered in the **global** pref service — it fires for all windows, and persists after the window closes unless explicitly removed.

**Always remove on window unload:**
```js
const obs = { observe() { /* ... */ } };
Services.prefs.addObserver("my.pref", obs);
window.addEventListener("unload", () => {
  Services.prefs.removeObserver("my.pref", obs);
}, { once: true });
```

Failure to remove: the observer holds a closure over the window's DOM. After the window closes, pref changes fire the observer against dead DOM nodes — errors, memory leaks, or silent corruption. This compounds with every window open/close cycle.

---

### MutationObserver — lifecycle rules

Every `MutationObserver` created inside a toggle function (e.g., `enable()` / `disable()` pattern) must be stored and disconnected in the corresponding teardown.

**Correct pattern:**
```js
let obs = null;

function enable() {
  if (obs) return; // idempotent
  obs = new MutationObserver(handler);
  obs.observe(target, options);
}

function disable() {
  obs?.disconnect();
  obs = null;
}
```

**Wrong pattern (accumulates observers):**
```js
function enable() {
  new MutationObserver(handler).observe(target, options);
  // reference discarded — cannot disconnect
}
```

After N calls to the wrong `enable()`: N observers run on every mutation. If enable/disable are called from a pref observer that fires per window open, the count grows unboundedly.

---

### XUL popup events

Firefox XUL popups fire `popupshown` and `popuphidden` on `document` (bubbling). These are XUL events — distinct from the HTML Popover API's `toggle` event. A `popover="manual"` element calling `showPopover()` fires `toggle`, not `popupshown`.

- `event.target` — the popup element (`<menupopup>`, `<panel>`, etc.)
- To get the element across shadow DOM: `event.composedPath()[0]` (not `event.composedTarget`, which is non-standard)
- Filter tooltips: `el.localName === "tooltip"`

**Popup counter drift.** If a popup element is removed from the DOM while open, `popuphidden` may not fire. Any code counting open popups must clamp on underflow: `Math.max(0, count - 1)`.

---

### File I/O — profile directory

For writing JSON state to the Firefox profile:

```js
const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
const filePath = PathUtils.join(profileDir, "my-file.json");

await IOUtils.writeJSON(filePath, data);          // atomic write
const data = await IOUtils.readJSON(filePath);    // throws if missing
```

`IOUtils` is a global in chrome scripts. `PathUtils.join` handles platform path separators. `IOUtils.writeJSON` is atomic — writes to a temp file, then renames. Both are async/Promise-based.

To check existence before reading:
```js
if (await IOUtils.exists(filePath)) {
  const data = await IOUtils.readJSON(filePath);
}
```

---

### Chrome script execution environment

Scripts in `chrome/JS/` are loaded by fx-autoconfig as privileged chrome scripts, one execution per browser window. Available globals:

| Global | Notes |
|---|---|
| `window`, `document` | The browser chrome window and XUL document |
| `gBrowser` | Tab management — see above |
| `Services` | XPCOM service registry |
| `ChromeUtils` | Module import, `importESModule` |
| `IOUtils`, `PathUtils` | File I/O |
| `Cu`, `Cc`, `Ci` | XPCOM shorthand |
| `SessionStore` | May or may not be a global — import explicitly |

**Startup timing.** Scripts run after `gBrowserInit.delayedStartupFinished`. If you need to defer until startup is fully complete:

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

**Per-window isolation.** Each window gets a fresh IIFE execution. Module-level variables are per-window instances. `Services.prefs`, `Services.io`, and `SessionStore` are global singletons shared across windows.
