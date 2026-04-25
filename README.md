<div align="center">

<img src="docs/palefox.png?v=2" alt="Palefox logo" width="160" />

# Palefox

#unfencethefox

</div>

> [!IMPORTANT]
> Palefox is in beta. Suitable for daily driving but expect rough edges as features land.

<div align="center">

<img src="https://github.com/user-attachments/assets/fdefa78a-7847-4769-a532-f40172332ba7" alt="Palefox screenshot" />

</div>

## Features

- **Tree-style tabs** — custom tab panel with deep nesting, groups, drag-and-drop reordering, and multi-select
- **Horizontal Tabs** — custom tab panel that supports trees and complementary UX
- **Vim keybindings** — navigate, refile, search, and manipulate tabs without leaving the keyboard
- **Compact mode** — sidebar autohides off-screen, revealed on left-edge hover with spring animation
- **Collapse layout** — sidebar shrinks to icons-only strip, toolbox returns to horizontal bar
- **Sidebar button** — left-click toggles compact mode, right-click opens layout options (compact, collapse, tab orientation)
- **Urlbar breakout** — expands past the sidebar when focused
- **HTTP warning** — delayed insecure-page banner (avoids false alarms on redirects)
- **Draggable sidebar** — drag the window from empty sidebar space (floating/stacking WMs)
- **Theme-respecting** — uses Firefox's native CSS variables, works with any theme
- Powered by [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) for chrome JS

## Quick Install

> Palefox runs chrome-privileged JS and CSS — review scripts in `chrome/JS/` before use, and review install scripts before piping them into your shell.

Install from the latest tagged release:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/palefox/main/install.sh -o /tmp/palefox-install.sh && bash /tmp/palefox-install.sh
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/palefox/main/install.ps1 -OutFile $env:TEMP\palefox-install.ps1; & $env:TEMP\palefox-install.ps1
```

**LibreWolf:** add `--librewolf` to any command above.

→ Need to install from `main`, a specific branch, a tag, or a single commit? See the [advanced installation guide](docs/install.md) for all flags and options, including manual install and Nix / Home Manager.

## Docs

- [**Getting started**](docs/getting-started.md) — five-minute orientation, hotkey & pref cheatsheets, sidebar-button modes
- [Keybindings reference](docs/keybindings.md) — every key Palefox listens for
- [about:config reference](docs/about-config.md) — every `pfx.*` pref
- [Colors & theming](docs/colors.md) — the `--pfx-*` palette, overriding in `user.css`, opting into system theme
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
