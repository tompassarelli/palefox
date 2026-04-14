<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.png" />
    <img src="docs/logo.png" alt="Palefox logo" width="200" />
  </picture>

# Palefox

A developer-focused alternative to Zen Browser on upstream Firefox

</div>

<figure>
  <img src="https://github.com/user-attachments/assets/8a9e2552-6c91-412f-ad2b-e41274e2e2ac" alt="Tiled in compact (zen) mode" />
  <figcaption>Tiled in compact (zen) mode</figcaption>
</figure>

<figure>
  <img src="https://github.com/user-attachments/assets/9d89d845-e5c4-4fb4-ae9a-eb36da9ddde8" alt="Default mode — vertical tabs, expanded layout" />
  <figcaption>Vertical tabs, expanded layout</figcaption>
</figure>

<figure>
  <img src="https://github.com/user-attachments/assets/a5e4bc4c-f239-4b8d-8435-3150d4e7252e" alt="Vertical tabs — collapsed layout" />
  <figcaption>Vertical tabs, collapsed layout</figcaption>
</figure>


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

- **Compact mode** — sidebar autohides off-screen, revealed on left-edge hover with spring animation
- **Collapse layout** — sidebar shrinks to icons-only strip, toolbox returns to horizontal bar
- **Sidebar button** — left-click toggles compact mode, right-click opens layout options (compact, collapse, tab orientation)
- **Urlbar breakout** — expands past the sidebar when focused
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
