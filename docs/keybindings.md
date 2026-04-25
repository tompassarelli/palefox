# Keybindings reference

Every key Palefox listens for, organized by what you're doing. Bindings
are active when the **tree panel** has focus (vim normal mode). Press
`i` to focus the page content; click on the panel or any tree row to
return.

---

## Navigation

| Key                  | Action                                                            |
| -------------------- | ----------------------------------------------------------------- |
| `j` / `↓`            | Move cursor down (skips hidden rows; crosses pinned ↔ panel)      |
| `k` / `↑`            | Move cursor up                                                    |
| `h` / `←`            | Vertical: outdent the cursored row; Horizontal: previous column   |
| `l` / `→`            | Vertical: indent under previous sibling; Horizontal: next column  |
| `gg`                 | Jump to top                                                       |
| `G`                  | Jump to bottom                                                    |

In horizontal mode, `h`/`l` step between top-level trees (columns) and
`j`/`k` move within the cursored tree's expanded popout.

---

## Activate / focus

| Key       | Action                                                          |
| --------- | --------------------------------------------------------------- |
| `Enter`   | Activate cursored tab and focus the content (or toggle a group) |
| `Tab`     | Toggle collapse on the cursored row                             |
| `i`       | Focus the page content (panel keeps DOM focus until reactivated)|
| `Escape`  | Cancel a pending refile (otherwise no-op)                       |

Clicking a tab in a horizontal popout is treated as a "commit" — it
activates the tab and lets the popout close naturally.

---

## Tree manipulation

| Key             | Action                                                     |
| --------------- | ---------------------------------------------------------- |
| `Alt+h` / `Alt+←` | Move cursor to the row's tree root                       |
| `Alt+l` / `Alt+→` | Make the cursored row a child of the row immediately above |
| `Alt+j` / `Alt+↓` | Swap the cursored subtree with its next sibling          |
| `Alt+k` / `Alt+↑` | Swap the cursored subtree with its previous sibling      |
| `r`             | Rename cursored tab/group inline                           |
| `gC`            | Duplicate the cursored tab as a sibling (same parent)      |

Drag-and-drop also works:
- **Vertical mode** — drop on the top/bottom thirds of a row for
  before/after siblings, middle third for child.
- **Horizontal mode** — drop on the left/right half for siblings, the
  bottom third for child.
- A tab dragged onto a group row becomes a child of that group.

Double-clicking a tab row also runs `cloneAsSibling` (matching `gC`).

---

## Multi-select

| Key       | Action                                                          |
| --------- | --------------------------------------------------------------- |
| `J`       | Extend selection down by one (first press anchors at cursor)    |
| `K`       | Extend selection up by one                                      |
| `Shift+click` | Range-select from the cursor to the clicked row             |

Selected rows show a subtle highlight. Most commands operate on the
selection when one is active (e.g., closing closes the whole range).

---

## Search & refile

| Key       | Action                                                          |
| --------- | --------------------------------------------------------------- |
| `/`       | Open search prompt in the modeline                              |
| `n`       | Next match                                                      |
| `N`       | Previous match                                                  |
| `Enter`   | Commit search (or commit refile target if `:re` was active)     |

**Refile** = move the cursored row (and subtree) into the matched target.
Start with `:re` (or `:refile`, `:rf`); a single match auto-commits on
`Enter` without needing to step through.

---

## Closing tabs

| Action                | Method                                                  |
| --------------------- | ------------------------------------------------------- |
| Close cursored tab    | `x` (vim normal mode)                                   |
| Close any tab via mouse | **Middle-click** the row, or **right-click → Close Tab** |
| Close children        | Right-click → Close Children                            |
| Close all tabs in group | Right-click on group → Close Tabs in Group            |
| Close group itself    | Right-click on group → Close Group                      |

> The previously-rendered `X` close button on every row was removed in
> v0.37.1 — it duplicated three already-abundant close paths.

---

## Ex command mode (`:`)

Press `:` to open the ex prompt in the modeline. Available commands:

| Command                  | Action                                                    |
| ------------------------ | --------------------------------------------------------- |
| `:group <name>`          | Insert a new group row at the cursor's level              |
| `:grp <name>`, `:folder <name>` | Aliases for `:group`                                |
| `:re`, `:refile`, `:rf`  | Refile cursored row into search target (then `/...Enter`) |
| `:pin`                   | Pin the cursored tab                                      |
| `:unpin`                 | Unpin the cursored tab                                    |

---

## Pane switching (`Ctrl+W`, `SPC w`)

Both follow vim convention. When inside a tab grid (e.g., split views),
chord with `h`/`l` for left/right pane:

| Chord       | Action                                                        |
| ----------- | ------------------------------------------------------------- |
| `Ctrl+W h`  | Focus pane to the left                                        |
| `Ctrl+W l`  | Focus pane to the right                                       |
| `Ctrl+W w`  | Cycle to the next pane                                        |
| `SPC w h/l/w` | Same as Ctrl+W chord; `Space` is the leader, `w` enters chord|

---

## Right-click context menus

In addition to the listed keys, right-clicking any row opens a contextual
menu — see [getting-started.md](getting-started.md#what-else) for a
quick overview, or just try it.
