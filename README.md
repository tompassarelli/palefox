<div align="center">

# Palefox

Firefox, unfenced

<img src="docs/demo.gif" alt="Palefox demo" />

</div>


## Quick Install

> Palefox runs chrome-privileged JS and CSS — review scripts in `chrome/JS/` before use, and review install scripts before piping them into your shell.

> **Palefox is in beta.** Stable enough for daily use — install from the latest tagged release on `main`. Features are actively evolving.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/palefox/main/install.sh -o /tmp/palefox-install.sh && bash /tmp/palefox-install.sh
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/palefox/main/install.ps1 | iex
```

**LibreWolf:** add `--librewolf` to either command. See the [full installation guide](docs/install.md) for manual install, flags, and details.

## Features

- **Tree-style tabs** — custom tab panel with deep nesting, groups, drag-and-drop reordering, and multi-select
- **Vim keybindings** — navigate, refile, search, and manipulate tabs without leaving the keyboard
- **Compact mode** — sidebar autohides off-screen, revealed on left-edge hover with spring animation
- **Collapse layout** — sidebar shrinks to icons-only strip, toolbox returns to horizontal bar
- **Sidebar button** — left-click toggles compact mode, right-click opens layout options (compact, collapse, tab orientation)
- **Urlbar breakout** — expands past the sidebar when focused
- **HTTP warning** — delayed insecure-page banner (avoids false alarms on redirects)
- **Draggable sidebar** — drag the window from empty sidebar space (floating/stacking WMs)
- **Theme-respecting** — uses Firefox's native CSS variables, works with any theme
- Powered by [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) for chrome JS

## Docs

- [Full installation guide](docs/install.md)
- [Nix / Home Manager](docs/nix.md)
- [Features & options](docs/features.md)
- [Customization](docs/customization.md)
- [Compact mode audit (Zen Browser comparison)](docs/compact-mode-zen-audit.md)
- [Contributing](CONTRIBUTING.md)

## Acknowledgments

Palefox draws inspiration from:

- [Nyxt](https://nyxt-browser.com/) — keyboard-driven, programmable browser philosophy
- [qutebrowser](https://qutebrowser.org/) — keyboard-first, minimal UI ethos
- [Zen Browser](https://zen-browser.app/) — compact mode state machine and sidebar design
- [GWfox](https://github.com/akkva/gwfox) — CSS theming techniques
- [FF-ULTIMA](https://github.com/soulhotel/FF-ULTIMA) — feature and layout ideas
- [parfait](https://github.com/reizumii/parfait) — findbar and accessibility
