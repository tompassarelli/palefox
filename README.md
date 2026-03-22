<div align="center">
  <img src="https://github.com/user-attachments/assets/7ebd8f20-2846-4e0e-9d9f-de563a589805" alt="Fennec logo" width="96" />

# Fennec

Minimal, customizable Firefox/LibreWolf setup built with userChrome.css, bringing a Zen-style sidebar workflow to stock Firefox or LibreWolf — no fork, no build.

</div>

| Sidebar Open | Zen Mode |
|:---:|:---:|
| ![Fennec with sidebar](https://github.com/user-attachments/assets/9fc9691d-8e5e-4864-bdd8-0aa696955d86) | ![Fennec without sidebar](https://github.com/user-attachments/assets/7db86916-8c1c-4feb-91de-0f62d5fab209) |

## Features

🧩 **Enhanced Sidebery Integration** - Urlbar in the sidebar, expands on focus

🧘 **Zen Mode** - Toggle the sidebar to hide the UI and maximize focus

✨ **Minimal Chrome** - Only the essentials, coherent with a keyboard-driven UX

🤝 **Built to Customize** - Clean code and detailed docs to support customization and contribution

🎨 **Theme Support** - System themes (light/dark) and user-created Firefox themes supported

## Why Fennec?

Fennec is for people who want the Zen-style sidebar workflow while staying on stock Firefox or LibreWolf.

- No browser fork — just CSS
- Update-safe customizations — your tweaks survive Fennec updates
- Works on Firefox and LibreWolf

## Quick Install

> Please see [security considerations](#security) before installing

Install [Sideberry](https://addons.mozilla.org/en-US/firefox/addon/sidebery/), then run:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/fennec/main/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/fennec/main/install.ps1 | iex
```

**LibreWolf:** add `--librewolf` to either command.

See the [full installation guide](docs/INSTALL.md) for manual install, flags, and details.

## Docs

- [Full installation guide](docs/INSTALL.md)
- [Nix / Home Manager](docs/NIX.md)
- [Features & options](docs/FEATURES.md)
- [Customization](docs/CUSTOMIZATION.md)
- [Contributing](CONTRIBUTING.md)

## Security

- Extensions are privileged software — install only ones you trust
- Zen Mode can hide browser security indicators; verify pages before browsing with the UI hidden
- Review install scripts before piping them into your shell
- Fennec is a UI customization, not a security tool — use it with normal caution

## Status

Actively maintained with recent releases and ongoing improvements. If something isn't working, check [open issues](https://github.com/tompassarelli/fennec/issues) or file a new one.

## Star History

<a href="https://www.star-history.com/?repos=tompassarelli%2Ffennec&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=tompassarelli/fennec&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=tompassarelli/fennec&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=tompassarelli/fennec&type=date&legend=top-left" />
 </picture>
</a>
