<div align="center">

<img src="docs/palefox.png?v=2" alt="Palefox logo" width="160" />

<h1 align="center" style="border-bottom: 0">Palefox</h1>

</div>

<div align="center">

<img src="https://github.com/user-attachments/assets/fdefa78a-7847-4769-a532-f40172332ba7" alt="Palefox screenshot" />

</div>

## Features

- ⌨️ **Vim & Emacs keys** — modal navigation, refile, search, no mouse needed
- 🌳 **Tree tabs** — deep nesting, groups, multi-select, drag-and-drop
- ↔️ **Horizontal mode** — same tree, laid across the top instead
- 👻 **Compact mode** — sidebar autohides offscreen, springs out on left-edge hover
- 📐 **Collapse layout** — icons-only strip, toolbox returns to horizontal
- 🎛️ **Sidebar button** — left-click toggles compact, right-click for layout menu
- 🎯 **Floating urlbar** — expands past the sidebar when focused
- ⚠️ **HTTP warning** — delayed banner avoids false alarms on redirects
- 🪟 **Draggable sidebar** — grab the window from empty sidebar space (floating WMs)
- 🎨 **Theme-respecting** — uses Firefox's native CSS variables, works with any theme

## Quick Install

> ⚠️ Palefox is chrome-privileged — its scripts run with Firefox's own authority (no sandbox, full access to tabs, cookies, passwords). The hash-pinned loader closes the local-write attack vector vanilla [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) leaves open, but you're still trusting palefox itself. Review `chrome/JS/` and the install script before running. Full architecture + threat model: [docs/dev/loader-pipeline.md](docs/dev/loader-pipeline.md).

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
