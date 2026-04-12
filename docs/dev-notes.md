# Dev Notes

## DOM Reparenting Constraints

### #navigator-toolbox reparenting into #sidebar-main

Moving #navigator-toolbox into #sidebar-main as a child:

| Feature | Status | Notes |
|---------|--------|-------|
| Toolbar button icons/layout | WORKS | |
| Button click handlers | WORKS | event listeners move with elements |
| getElementById lookups | WORKS | ID unchanged |
| Left-click on buttons | WORKS | |
| Right-click context menus | FIXED | see Context Menu Fix below |
| Urlbar dropdown/breakout | BROKEN | see Urlbar Breakout below |

### Context Menu Fix

**Problem:** `<sidebar-main>` custom element registers a `contextmenu`
listener on `#sidebar-main` in its `connectedCallback()`. After reparenting
`#navigator-toolbox` inside `#sidebar-main`, right-clicks on toolbar buttons
bubble up to the sidebar's handler, which interprets them as sidebar context
actions (extension management, hide sidebar, etc.) instead of toolbar actions.

**Fix:** `e.stopPropagation()` on `#navigator-toolbox`'s `contextmenu` event.
This prevents the event from reaching sidebar-main's listener. The native
toolbar context menu system still works because it's wired via the
`context="toolbar-context-menu"` attribute directly on `#nav-bar`.

```js
navigatorToolbox.addEventListener("contextmenu", (e) => {
  e.stopPropagation();
});
```

### Urlbar Breakout System

**Source:** `UrlbarInput.mjs`

The urlbar has a "breakout" system that pops it out of its container when
focused to render the autocomplete dropdown. This system has hard
dependencies on the DOM structure.

**Critical line (UrlbarInput.mjs:487):**
```js
this.#allowBreakout = !!this.closest("toolbar") && !document.documentElement.hasAttribute("customizing");
```

`#allowBreakout` is set during initialization. It checks `this.closest("toolbar")`
— if the urlbar doesn't have a `<toolbar>` ancestor, breakout is disabled entirely.
`#nav-bar` is a `<toolbar>` element. Moving `#urlbar-container` out of `#nav-bar`
means `closest("toolbar")` returns null → breakout disabled → no dropdown.

**Positioning (UrlbarInput.mjs:3012-3017):**
```js
this.style.top = px(
  this.parentNode.getBoxQuads({ ignoreTransforms: true, flush: false })[0].p1.y
);
```

The urlbar positions itself using `this.parentNode.getBoxQuads()`. The parent
is always `#urlbar-container` regardless of where it's placed. The geometry
changes when the container moves, but this alone doesn't break things — the
`closest("toolbar")` check is what kills it.

**Dimension tracking (UrlbarInput.mjs:3075-3077):**
```js
this.parentNode.style.setProperty(
  "--urlbar-container-height",
  px(getBoundsWithoutFlushing(this.parentNode).height)
);
```

Sets CSS variables based on parent bounds. Works regardless of DOM position.

**ResizeObserver (UrlbarInput.mjs:492-498):**
Only created when `#allowBreakout` is true. Observes `this.parentNode`
(#urlbar-container) and sets `--urlbar-width`. If breakout is disabled,
this observer is never created.

### Conclusion: #urlbar-container must stay inside #nav-bar

The `closest("toolbar")` check is a hard gate. Without a `<toolbar>`
ancestor, the entire breakout/dropdown system is disabled. Options:

1. **Leave urlbar inside #nav-bar, use CSS to visually reorder** — safest.
   Use `order` or flex wrapping to render it below the buttons.
2. **Monkey-patch `#allowBreakout`** — force it to true after reparenting,
   manually create the ResizeObserver. Fragile, may break on Firefox updates.
3. **Wrap the urlbar in a new `<toolbar>` element** — create a toolbar,
   move urlbar-container into it, place it wherever. The `closest("toolbar")`
   check would pass. Untested but promising.

### sidebar-main Event Interception

The `<sidebar-main>` custom element (a LitElement) handles these events
on `#sidebar-main`:

- `contextmenu` — intercepts right-clicks to show sidebar context menu
- `popuphidden` / `popupshown` — tracks menu state
- `sidebar-show` / `sidebar-hide` — tracks panel visibility
- `SidebarItemAdded/Changed/Removed` — updates sidebar UI

Any element reparented inside `#sidebar-main` will have its events
intercepted by these handlers unless propagation is stopped.
