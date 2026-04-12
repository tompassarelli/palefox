# Compact Mode: Zen Browser Audit

Source: `ZenCompactMode.mjs` from Zen Browser (`desktop/src/zen/compact-mode/`)
Ported to: `chrome/JS/palefox-drawer.uc.js` compact mode section
Date: 2026-04-12

## State Model

Zen and palefox use the same inverted visibility model:
- **Hidden by default** when compact mode is active (CSS does the hiding)
- **Shown by adding an attribute** (`zen-has-hover` / `pfx-has-hover`)
- Absence of the hover attribute = hidden. No "hidden" attribute to race against.

Zen hides via `left` offset. We hide via `transform: translateX(-100%)`.
Zen uses `position: fixed` on the sidebar. We do the same.

## What We Ported

### `_ignoreNextHover` (ZenCompactMode.mjs:623)
**Ported.** When enabling compact mode via button click, the mouse is over the
sidebar. CSS applies `pointer-events: none`, which may cause a `mouseenter` on
the hover strip as the pointer "falls through." This flag blocks that one event.
Cleared next tick via `setTimeout(0)`.

### `flashElement` pattern (ZenCompactMode.mjs:672)
**Ported as `flashSidebar`.** On mouseleave, the sidebar lingers for 300ms before
hiding. If the mouse re-enters during this window, the hide is cancelled. Prevents
flicker when the mouse briefly crosses the sidebar edge. Zen's version is generic
(any element, any attribute, keyed by ID). Ours is hardcoded to the single sidebar.

### `onEnter` hover verification (ZenCompactMode.mjs:762)
**Ported as `onSidebarEnter`.** `setTimeout(0)` + `:hover` CSS check guards
against spurious mouseover events on Linux/Wayland (Mozilla bug 1818517).
`event.target.closest("panel")` ignores mouseover from popup panels overlapping
the sidebar. `requestAnimationFrame` batches DOM writes.

### `onLeave` hover verification (ZenCompactMode.mjs:788)
**Ported as `onSidebarLeave`.** Same `setTimeout(0)` + `:hover` guard. Calls
`flashSidebar` instead of immediate hide.

### Guard states (via `ZenHasPolyfill` in Zen)
**Ported as `isGuarded()`.** Zen uses a MutationObserver (`ZenHasPolyfill`) that
watches `[panelopen], [open], [breakout-extend]` inside the sidebar and sets a
`zen-compact-mode-active` attribute. We use `querySelector` checks instead —
simpler, sufficient for one element:
- `urlbar[breakout-extend]` — autocomplete dropdown open
- `toolbarbutton[open='true']` — toolbar menu open
- `.tabbrowser-tab[multiselected]` — tab drag in progress

### `sizemodechange` listener (ZenCompactMode.mjs:93)
**Ported.** Clears stale hover state when the window minimizes/maximizes/restores,
since the mouse position may no longer be over the sidebar.

### `HOVER_HACK_DELAY` (ZenCompactMode.mjs:47)
**Ported as literal `0`.** Zen makes this configurable via pref
(`zen.view.compact.hover-hack-delay`, default 0ms). We hardcode 0 since there's
no evidence we need a different value.

## What We Did NOT Port (Fork-Specific)

### `zen-user-show` attribute
Zen allows the user to manually "pin" the sidebar open (persists across hover
events). We don't have this UX concept. If we add a "pin sidebar" feature later,
this is the pattern to follow.

### `zen-has-empty-tab` attribute
Zen auto-shows the sidebar when an empty/new tab opens. Not a palefox feature.

### `zen-compact-animating` guard
Prevents the user from spam-toggling compact mode during the animation. Nice
defensive guard. We skip it because our CSS transition is simple and re-triggering
it mid-animation doesn't break anything visually.

### `animateCompactMode` (ZenCompactMode.mjs:434)
Zen uses `gZenUIManager.motion.animate` (a spring physics animation library) for
the sidebar slide, with margin offsets and splitter width calculations. We use
CSS `transition: transform` with a spring `linear()` easing function instead.
Same visual result, zero JS animation code.

### `_hasHoveredUrlbar` / floating urlbar handling
Zen has a "floating urlbar" feature where the urlbar detaches from the sidebar.
When the floating urlbar is hovered, the sidebar should NOT expand. We don't have
a floating urlbar (our urlbar breakout is different — it expands in place). Skip.

### macOS window button bounds check (ZenCompactMode.mjs:789-802)
Zen checks if the mouse is over macOS traffic light buttons during mouseleave to
prevent false leave events. Fork-specific platform handling. Skip.

### `supress-primary-adjustment` checks
Zen's custom layout engine flag. Not applicable outside the fork. Skip.

### Screen edge detection (`_getCrossedEdge`, ZenCompactMode.mjs:919)
Zen detects when the mouse leaves the window and re-enters at the sidebar edge.
Uses `mouseleave` on `documentElement`, measures which edge was crossed within
10px tolerance, then flashes the sidebar. We use a hover strip element instead —
an invisible 12px-wide box at the left edge that catches `mouseenter`. Simpler
mechanism, same result.

### `_isTabBeingDragged` flag
Zen sets this flag in their custom `ZenDragAndDrop.js` drag handler. We can't
hook into Firefox's native drag system this way, so we use
`querySelector(".tabbrowser-tab[multiselected]")` in `isGuarded()` instead.
Functionally equivalent — catches the same tab drag state.

### `addPopupTrackingAttribute` / `has-popup-menu` attribute
Zen tracks popup open/close via `popupshowing`/`popuphidden` events on the sidebar
and toolbar, setting `has-popup-menu` attribute. CSS uses this to keep sidebar
visible. We handle this in `isGuarded()` with `querySelector("toolbarbutton[open]")`
instead.

### `keepHoverDuration` as pref
Zen's sidebar linger duration is a pref (`zen.view.compact.sidebar-keep-hover.duration`).
We hardcode 300ms. Could be made configurable later via `pfx.sidebar.compact.linger`.

### `hideAfterHoverDuration` / screen edge flash duration
Used with screen edge detection (which we skip). Not applicable with hover strip.

### `COMPACT_MODE_FLASH_DURATION` / `flashSidebarIfNecessary`
Zen flashes the sidebar after exiting DOM fullscreen. Not implemented. Could add
later if fullscreen exit feels disorienting.

### Multiple hoverable elements
Zen manages hover state for three elements: sidebar, toolbar wrapper, and window
buttons. Each has its own screen edge and `keepHoverDuration`. We only manage the
sidebar.

### `_removeOpenStateOnUnifiedExtensions` (ZenCompactMode.mjs:611)
Workaround for Zen-specific bug where extension buttons retain `open` attribute.
Not applicable.

### Context menu submenu (hide sidebar / hide toolbar / hide both)
Zen offers granular control over what to hide in compact mode. We hide the sidebar
only. Could expand later.

### `getAndApplySidebarWidth` (ZenCompactMode.mjs:379)
Zen captures sidebar width into CSS custom properties (`--zen-sidebar-width`,
`--actual-zen-sidebar-width`) for use in transition calculations. We let the
sidebar keep its inline `width` style from Firefox's drag-resize, and CSS
transitions handle the rest.

## Not Yet Ported — May Want Later

| Feature | Zen Reference | Why we might want it |
|---------|---------------|---------------------|
| Pin sidebar open (`zen-user-show`) | mjs:634 | Users may want sidebar to stay open without hover |
| Flash on fullscreen exit | mjs:211 | Sidebar disappears in fullscreen — flash reminds user it exists |
| Configurable linger duration | pref-based | Power users may want faster/slower hide |
| Animation spam guard | `zen-compact-animating` | Prevents weird states from rapid toggling |
| Popup tracking via MutationObserver | `ZenHasPolyfill` | More reliable than querySelector for detecting open popups |
| `dragover`/`dragleave` listeners | mjs:849-853 | Keep sidebar visible during drag-and-drop onto tabs |
