# about:config reference

Every Palefox knob lives under the `pfx.*` namespace. Set them in
`about:config` (you can search for `pfx.` to filter to just Palefox
prefs). Boolean prefs default to `false` unless noted; CSS-driven prefs
take effect instantly, JS-driven prefs are noted where reload is needed.

---

## Layout & UI

| Pref                              | Type    | Default | What it does                                                                                                  |
| --------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `pfx.sidebar.compact`             | bool    | `false` | Auto-hide the sidebar off-screen; reveal on left-edge hover with a spring animation                           |
| `pfx.toolbar.tabsBelowNavBar`     | bool    | `false` | In horizontal mode, render the tab strip **below** nav-bar (default Firefox order has tabs on top)            |
| `pfx.toolbar.newTabButton`        | bool    | `false` | Show the toolbar's `+` new-tab button (hidden by default since `i` / `gC` / new-tab middle-click cover it)    |
| `pfx.sidebar.menuBar`             | bool    | `false` | Show Firefox's menubar above the sidebar                                                                      |
| `pfx.sidebar.newTab`              | bool    | `false` | Show the new-tab button inside the sidebar                                                                    |
| `pfx.sidebar.width`               | int     | `300`   | Width of the expanded vertical sidebar in pixels                                                              |
| `pfx.urlbar.float`                | bool    | `false` | Float the urlbar as a top-layer overlay when focused (lets it expand past the sidebar)                        |
| `pfx.splitView.outline`           | bool    | `false` | Outline split-view panes for visibility while debugging                                                       |

---

## Drawer (auto-hide chrome)

| Pref                                  | Type | Default | What it does                                                                                  |
| ------------------------------------- | ---- | ------- | --------------------------------------------------------------------------------------------- |
| `pfx.drawer.autohide`                 | bool | `false` | Auto-hide the entire drawer chrome (sidebar + toolbox) when not in use                        |
| `pfx.drawer.autohide.requireFocus`    | bool | `false` | Only auto-hide when content has focus (not just on mouse-out)                                 |
| `pfx.view.draggable-sidebar`          | bool | `true`  | Allow dragging the window from empty sidebar space (useful for floating / stacking WMs)       |

---

## Debugging

| Pref          | Type | Default | What it does                                                                                                       |
| ------------- | ---- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `pfx.debug`   | bool | `false` | Write timestamped event logs to `<profile>/palefox-debug.log` (also mirrors to the Browser Console)                |

The log file lives at `~/.mozilla/firefox/<profile>/palefox-debug.log`
on Linux, or the equivalent profile directory on macOS / Windows.
Coverage spans drag-drop decisions, vim cursor moves, popout placement,
mode transitions, and more — turn this on first when filing a bug.

---

## Adding a new pref

If you're hacking on Palefox itself, the preferred pattern for a CSS-only
toggle is:

```css
@media -moz-pref("pfx.your.knob") {
  /* opt-in styles */
}
```

For JS-driven prefs, read with `Services.prefs.getBoolPref("pfx.your.knob", false)`
and observe with `Services.prefs.addObserver(...)`. See `src/drawer/index.ts`
for a worked example (the compact-mode toggle).
