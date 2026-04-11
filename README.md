<div align="center">
  <img src="https://github.com/user-attachments/assets/7ebd8f20-2846-4e0e-9d9f-de563a589805" alt="Palefox logo" width="96" />

# Palefox

Minimal, customizable Firefox/LibreWolf chrome — keyboard-first, no fork, no build.

</div>

> **This branch (`main`) is unstable and under active development.**
> Palefox is evolving toward heavy use of JavaScript (via [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)) for features that CSS alone can't handle cleanly — like proper autohide state management and a keyboard-driven command palette.
>
> **For the stable, CSS-only theme, use the [`stable-pure-css`](https://github.com/tompassarelli/palefox/tree/stable-pure-css) branch.**

## Quick Install (stable)

> Please see [security considerations](#security) before installing

Install [Sideberry](https://addons.mozilla.org/en-US/firefox/addon/sidebery/), then run:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/palefox/stable-pure-css/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/palefox/stable-pure-css/install.ps1 | iex
```

**LibreWolf:** add `--librewolf` to either command.

See the [full installation guide](docs/install.md) for manual install, flags, and details.

## Features (stable-pure-css)

- **Enhanced Sidebery Integration** — urlbar in the sidebar, expands on focus
- **Zen Mode** — toggle sidebar to hide UI and maximize focus
- **Minimal Chrome** — keyboard-driven, only the essentials
- **Theme Support** — system themes (light/dark) and Firefox Color themes

## What's happening on main

The CSS-only approach to features like autohide pushed the stylesheet into increasingly complicated selector chains that are fragile and hard to maintain. JS support opens the door to implementing these behaviors properly — and to ideas like a keyboard-driven centered command palette rather than the current mouse-first sidebar UX.

This branch includes:
- Vendored [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) loader (v0.10.14)
- `chrome/JS/` directory for userChrome scripts
- Updated install scripts and Nix module with `jsLoader` option

## Docs

- [Full installation guide](docs/install.md)
- [Nix / Home Manager](docs/nix.md)
- [Features & options](docs/features.md)
- [Customization](docs/customization.md)
- [Contributing](CONTRIBUTING.md)

## Security

- Extensions are privileged software — install only ones you trust
- Zen Mode can hide browser security indicators; verify pages before browsing with the UI hidden
- Review install scripts before piping them into your shell
- The JS loader on `main` runs chrome-privileged code — review scripts in `chrome/JS/` before use
- Palefox is a UI customization, not a security tool — use it with normal caution

## Acknowledgments

Palefox draws inspiration from:

- [Zen Browser](https://zen-browser.app/) — sidebar design
- [GWfox](https://github.com/akkva/gwfox) — CSS theming techniques
- [FF-ULTIMA](https://github.com/soulhotel/FF-ULTIMA) — feature and layout ideas
- [parfait](https://github.com/reizumii/parfait) — findbar and accessibility
