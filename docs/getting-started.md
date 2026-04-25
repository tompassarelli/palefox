# Getting started with Palefox

This is the quick on-ramp. For exhaustive references, follow the links in
each section.

---

## Five-minute orientation

Palefox swaps Firefox's native tab strip for a **tree-tab panel** with vim
keybindings. By default it lives in the vertical sidebar. The browser
chrome is restructured (urlbar, nav-bar, sidebar button) to be denser and
keyboard-driven.

Three layout modes you'll switch between:

- **Vertical (default)** — tree panel in the left sidebar. Your normal
  working mode.
- **Horizontal** — tree panel replaces the native top tab strip; trees
  become collapsible columns with popouts.
- **Compact** — sidebar autohides off-screen; reveal by hovering the
  left edge.

These are toggled from the **sidebar button** (the one in your toolbox
where the native sidebar toggle used to live):

- **Left-click** → toggles compact mode.
- **Right-click** → context menu with **Enable/Disable Compact**,
  **Collapse/Expand Layout** (icons-only strip), **Horizontal/Vertical
  Tabs**, and **Enable/Disable Sidebar**.

The button's tooltip is `Toggle compact mode (right-click for more)`.

---

## Hotkey cheatsheet

The panel is keyboard-first. When the panel has focus, you're in vim
normal mode by default. Press `i` to focus the page content (insert
mode); the panel takes focus back when you click on it or hit a hotkey.

**Essentials:**

| Key            | Action                                                     |
| -------------- | ---------------------------------------------------------- |
| `j` / `k`      | Move cursor down / up (crosses pinned ↔ panel)             |
| `h` / `l`      | Vertical: outdent / indent; Horizontal: prev / next column |
| `gg` / `G`     | Jump to top / bottom                                       |
| `Enter`        | Activate the cursored tab and focus content                |
| `Tab`          | Toggle collapse on the cursored row                        |
| `x`            | Close the cursored tab                                     |
| `r`            | Rename the cursored tab or group inline                    |
| `gC`           | Duplicate the cursored tab as a sibling                    |
| `J` / `K`      | Extend a multi-select range down / up                      |
| `/`            | Search; `n` / `N` step through matches                     |
| `:`            | Ex command line (`:group`, `:re`, `:pin`, `:unpin`, …)     |
| `i`            | Focus the page content                                     |
| `Alt+h`/`l`    | Move-to-root / make-child-of-row-above                     |
| `Alt+j`/`k`    | Swap the cursored subtree with its next/prev sibling       |

→ **Full keybindings reference:** [`docs/keybindings.md`](keybindings.md)

---

## about:config cheatsheet

Every Palefox knob is under `pfx.*`. Set them in `about:config`. They
take effect immediately (or on next reload, where noted in the full
reference).

The ones you're most likely to touch:

| Pref                              | Default | What it does                                                   |
| --------------------------------- | ------- | -------------------------------------------------------------- |
| `pfx.sidebar.compact`             | `false` | Auto-hide the sidebar; reveal on left-edge hover               |
| `pfx.toolbar.tabsBelowNavBar`     | `false` | In horizontal mode, place tabs **below** nav-bar instead of above |
| `pfx.toolbar.newTabButton`        | `false` | Show the toolbar `+` new-tab button (hidden by default)        |
| `pfx.sidebar.menuBar`             | `false` | Show the menubar above the sidebar                             |
| `pfx.urlbar.float`                | `false` | Float the urlbar as a top-layer overlay when focused           |
| `pfx.debug`                       | `false` | Write timestamped event logs to `<profile>/palefox-debug.log`  |

→ **Full pref reference:** [`docs/about-config.md`](about-config.md)

---

## How the sidebar button switches layouts

The button has a single icon but it's the entry point for **all** layout
toggling. Right-click reveals a menu whose items adapt to your current
state:

- **Enable/Disable Compact** — auto-hide the whole sidebar off-screen.
  Reveal by hovering the left edge with a spring animation.
- **Collapse/Expand Layout** — vertical mode only. Sidebar shrinks to an
  icons-only strip; the toolbox returns to a horizontal bar above.
  Pinned tabs and the tree both render as 24×24 icons centered in the
  strip.
- **Horizontal/Vertical Tabs** — flip between the two main panel
  positions. On switch, every tree except the active tab's gets
  collapsed automatically so the destination layout starts tidy.
- **Enable/Disable Sidebar** (horizontal mode only) — toggle Firefox's
  bookmarks/history sidebar via `SidebarController.toggle()`.

In **horizontal mode**, only one tree's popout is open at a time —
whichever contains the active tab. Click a popout child to make it the
active tab; arrow-keys + `Enter` to navigate without collapsing.

---

## Staying up to date

Palefox doesn't auto-update. Re-run the quick-install command from the
[README](../README.md#quick-install) to pull the latest tagged release.

Watch [GitHub Releases](https://github.com/tompassarelli/palefox/releases)
for change summaries. Recent releases have follow-up "what changed" notes
inline in each release; older release-history is in the release list.

To install from a specific branch, tag, or commit (or to use Nix / Home
Manager), see the [advanced installation guide](install.md).

---

## What else?

- **Customize without losing changes:** put your overrides in
  `chrome/user.css`. It is **not** overwritten on update — the rest of
  `chrome/*.css` is. See [`docs/customization.md`](customization.md).
- **Drag-and-drop** also works for tab tree manipulation: drop on a row's
  middle third to nest as a child, top/bottom thirds for siblings. In
  horizontal mode the zones flip to left/right halves for siblings, and
  the bottom third for child.
- **Right-click** any tab or group row for context-menu actions
  (rename, close children, pin, move to new window, etc.).
- **Bug reports / feature requests:** the project ships fast-and-loose
  on `main`; file an issue on GitHub if something breaks or you have an
  idea.
