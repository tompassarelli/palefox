# Features & Options

## Custom Tree-Style Tabs

Palefox replaces Firefox's native tab strip with a custom tree-style tab panel featuring vim keybindings, deep nesting, groups, and mouse interactions.

### Mouse Controls

| Action | Effect |
|--------|--------|
| Left click | Select tab |
| Middle click | Close tab |
| Double click | Clone tab as child |
| Shift+click | Range select (from cursor to clicked tab) |
| Drag & drop | Reorder tabs in the tree |
| Right click | Context menu (rename, collapse, group, close) |

### Vim Keybindings (Normal Mode)

Focus the tab panel to enter normal mode. Keys are only intercepted when the panel is focused.

**Navigation**

| Key | Action |
|-----|--------|
| `j` / `k` | Move cursor down / up |
| `h` / `l` | Outdent / indent tab (vertical mode) |
| `h` / `l` | Move between columns (horizontal mode) |
| `gg` | Jump to first tab |
| `G` | Jump to last tab |
| `/` | Search tabs by name or URL |
| `n` / `N` | Next / previous search match |

**Actions**

| Key | Action |
|-----|--------|
| `Enter` | Activate tab and focus content (or toggle collapse on group) |
| `Tab` | Toggle collapse / expand |
| `x` | Close tab (or all selected tabs) |
| `r` | Rename tab / group |
| `i` | Focus content (enter insert mode) |

**Tree Manipulation**

| Key | Action |
|-----|--------|
| `Alt+h` / `Alt+l` | Outdent / indent subtree |
| `Alt+j` / `Alt+k` | Swap with next / previous sibling |

**Pane Switching**

| Key | Action |
|-----|--------|
| `Ctrl+w, h` | Focus sidebar |
| `Ctrl+w, l` | Focus content |
| `Ctrl+w, w` | Toggle focus between sidebar and content |
| `SPC, w, h/l/w` | Same as Ctrl+w chords |

**Ex Commands** (press `:`)

| Command | Action |
|---------|--------|
| `:group <name>` | Create a named group after cursor |
| `:refile` | Refile current tab — search for a target, then press Enter to move it as a child |

### Multi-Select

Shift+click to select a range of tabs. Selected tabs are highlighted. Actions apply to the full selection:
- `x` closes all selected tabs
- Drag moves all selected tabs together

### Drag & Drop

Drag a tab to reorder it in the tree. Drop zones are divided into thirds:
- **Top third** — insert before the target
- **Middle third** — insert as child of the target
- **Bottom third** — insert after the target's subtree

## Sidebar Button (right-click menu)

Right-click the sidebar button (bottom of the sidebar) to access:

- **Enable/Disable Compact** — autohide sidebar off-screen, revealed on left-edge hover with spring animation
- **Expand/Collapse Layout** — toggle between full sidebar and icons-only strip
- **Horizontal/Vertical Tabs** — switch tab orientation
- **Customize Sidebar** — open Firefox's native sidebar settings

Left-click the sidebar button toggles compact mode directly.

## Compact Mode

When enabled, the sidebar slides off-screen and reappears when you hover the left edge. Popup menus and context menus keep the sidebar visible while open. The urlbar breakout still works — focus the urlbar and it expands past the sidebar.

Can also be toggled via `pfx.sidebar.compact` in `about:config`.

> **Linux users:** Set `widget.gtk.ignore-bogus-leave-notify` to `1` in `about:config`. Without this, GTK can send spurious leave events that cause the sidebar to collapse unexpectedly.

## HTTP Insecure Warning

When browsing an insecure HTTP page, a warning banner appears after a 2-second delay. The delay prevents false alarms on HTTP-to-HTTPS redirects.

## about:config Options

| Pref | Default | Description |
|------|---------|-------------|
| `pfx.sidebar.compact` | `false` | Autohide sidebar, reveal on left-edge hover |
| `pfx.sidebar.menuBar` | `false` | Show the menu bar |
| `pfx.sidebar.newTab` | `false` | Show the new tab button in the sidebar |
| `pfx.sidebar.width` | `300` | Sidebar width in pixels (saved automatically on resize) |
| `pfx.view.draggable-sidebar` | `true` | Drag the window from empty sidebar space |

## Accessibility

Palefox respects your OS "reduce motion" setting — all transitions become instant. On Linux you can also set `ui.prefersReducedMotion` to `1` in `about:config`.

## Recommended Extensions

**Vim-motions**
- **[Vimium](https://addons.mozilla.org/en-US/firefox/addon/vimium-ff/)** — old faithful
- **[Tridactyl](https://addons.mozilla.org/en-US/firefox/addon/tridactyl-vim/)** — an ambitious whippersnapper

**Other**
- **[New Tab Override](https://addons.mozilla.org/en-US/firefox/addon/new-tab-override/)** - Replace the default new tab page with a custom URL. Point it at a localhost service serving a barebones HTML page (without autofocus on the URL bar) so Vimium keybindings work immediately on new tabs

To get notified about new Palefox releases, [watch the GitHub repository](https://github.com/tompassarelli/palefox) and select "Releases only" under custom notifications.
