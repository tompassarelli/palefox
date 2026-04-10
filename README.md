<div align="center">
  <img src="https://github.com/user-attachments/assets/7ebd8f20-2846-4e0e-9d9f-de563a589805" alt="Palefox logo" width="96" />

# Palefox

Minimal, customizable Firefox/LibreWolf setup built, bringing a Zen Browser sidebar workflow to stock Firefox or LibreWolf — no fork, no build.

</div>

<p align="center"><strong>Default</strong></p>
<p align="center"><img src="https://github.com/user-attachments/assets/9fc9691d-8e5e-4864-bdd8-0aa696955d86" alt="Palefox default view" /></p>
<p align="center"><strong>Zen Mode</strong></p>
<p align="center"><img src="https://github.com/user-attachments/assets/7db86916-8c1c-4feb-91de-0f62d5fab209" alt="Palefox zen mode" /></p>

## Features

🧩 **Enhanced Sidebery Integration** - Urlbar in the sidebar, expands on focus; optional `sidebery.css` for native-style larger tab icons

🧘 **Zen Mode** - Toggle the sidebar to hide the UI and maximize focus

✨ **Minimal Chrome** - Only the essentials, coherent with a keyboard-driven UX

🤝 **Built to Customize** - Clean code and detailed docs to support customization and contribution

🎨 **Theme Support** - System themes (light/dark) and user-created Firefox themes supported

## Why Palefox?

Palefox is for people who want the Zen-style sidebar workflow while staying on stock Firefox or LibreWolf.

- No browser fork — CSS + JS via [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)
- Update-safe customizations — your tweaks survive Palefox updates
- Works on Firefox and LibreWolf

## Quick Install

> Please see [security considerations](#security) before installing

Install [Sideberry](https://addons.mozilla.org/en-US/firefox/addon/sidebery/), then run:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/palefox/main/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/palefox/main/install.ps1 | iex
```

**LibreWolf:** add `--librewolf` to either command.

See the [full installation guide](docs/install.md) for manual install, flags, and details.

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
- Palefox is a UI customization, not a security tool — use it with normal caution

## Status

Actively maintained with recent releases and ongoing improvements. If something isn't working, check [open issues](https://github.com/tompassarelli/palefox/issues) or file a new one.
## Acknowledgments

Palefox draws inspiration from:

- [Zen Browser](https://zen-browser.app/) — sidebar design
- [GWfox](https://github.com/akkva/gwfox) — CSS theming techniques
- [FF-ULTIMA](https://github.com/soulhotel/FF-ULTIMA) — feature and layout ideas
- [parfait](https://github.com/reizumii/parfait) — findbar and accessibility
