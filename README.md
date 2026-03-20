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

## Installation

> Please see [security considerations](#security) before installing

### 1. Install the Sideberry Extension

Install [Sideberry](https://addons.mozilla.org/en-US/firefox/addon/sidebery/) from Firefox Add-ons.

### 2. Install CSS

#### Option A: Automated (recommended)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/fennec/main/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/fennec/main/install.ps1 | iex
```

**LibreWolf:** add `--librewolf` to either command, or select LibreWolf when prompted interactively.

The script does the following:
- Detects Firefox or LibreWolf profile directories (including Flatpak and XDG paths on Linux)
- Copies core files (`fennec/fennec.css`) into your profile — always updated
- Creates `userChrome.css` (entry point) and `user/user.css` (your customizations) if they don't exist — preserved on update
- Writes prefs to `user.js`: disables vertical tabs, disables the sidebar revamp, enables custom stylesheets, sets `fennec.*` defaults
- Use `--force` to overwrite all files (e.g. clean reinstall)
- Use `--no-backup` to skip the backup

The entry point wires everything together:
```css
@import url("fennec/fennec.css");
@import url("user/user.css");
```
Fennec updates `chrome/fennec/`. Your tweaks live in `chrome/user/`. `userChrome.css` just wires them together — advanced users can edit it to add extra imports. Toggle features in `about:config` by typing `fennec.` to see all options.

> **To uninstall:** delete the `chrome` folder and remove the Fennec lines from `user.js` in your profile directory (or delete `user.js` entirely if Fennec created it).

#### Option B: Manual

**Enable required Firefox settings:**

> Note: only `toolkit.legacyUserProfileCustomizations.stylesheets` requires `about:config`; the rest can be changed in Settings.

1. Go to `about:config` in the address bar
2. Set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true`
3. Set `sidebar.verticalTabs` to `false` (or turn on **Horizontal tabs** in Settings)
4. Set `sidebar.revamp` to `false` (or turn off **Show Sidebar** in Settings)

**Locate your profile directory:**
1. Go to `about:support` in the address bar
2. Under "Application Basics", click **Open Profile Folder**
   - **Flatpak:** `~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>`
   - **LibreWolf:** `~/.librewolf/` or `~/.config/librewolf/librewolf/`

**Copy the CSS files:**
1. Inside the profile folder, create a `chrome` directory if it doesn't already exist
2. Copy `userChrome.css`, the `fennec/` folder, and the `user/` folder from this repo's `chrome/` directory into your profile's `chrome/` directory
3. Put your personal customizations in `user/user.css` — it won't be overwritten when fennec is updated

> **Upgrading from an older version?** If you had a monolithic `userChrome.css`, the install script will back it up to `userChrome.css.legacy` and install the new modular entry point. Move personal tweaks into `user/user.css`.

### 3. Restart your browser
   - Note: if the sidebar is invisible, you might have it toggled off. Try `Ctrl+H` to toggle history, then activate the Sideberry tabs menu from there by clicking on the extension icon.

### Alternative: Nix / Home Manager

Fennec can also be installed declaratively via a Home Manager module — this handles CSS, prefs, and Sideberry in one step.

1. Add fennec to your flake inputs:
```nix
inputs.fennec.url = "github:tompassarelli/fennec";
```

2. Import the module in your Home Manager config:
```nix
imports = [ inputs.fennec.homeManagerModules.default ];
```

3. Enable it:
```nix
programs.fennec = {
  enable = true;
  profile = "your-profile-name";  # optional, defaults to "default-release"
  autohide = false;               # optional
  extraConfig = ''                # optional, appended to user/user.css
    :root { --fen-gap-x: 12px; }
  '';
};
```

4. Rebuild with `nixos-rebuild switch` or `home-manager switch`

> Note: Sideberry is installed automatically via [NUR](https://github.com/nix-community/NUR). Ensure NUR is in your flake inputs and overlays. Set `sideberry = false` if you manage extensions separately.

## Optional Features

### Autohide (off by default)

Sidebar must be enabled (not toggled off). When enabled, the drawer auto-collapses when the mouse leaves and reappears when hovering the left edge of the window.

To enable:
1. Go to `about:config` in the address bar
2. Set `fennec.drawer.autohide` to `true`
3. Restart Firefox

### Floating Urlbar (off by default)

When enabled, the urlbar detaches from the sidebar and floats centered on the viewport when focused — like a spotlight/command palette. A "Searching..." placeholder stays in the sidebar.

To enable:
1. Go to `about:config` in the address bar
2. Set `fennec.urlbar.float` to `true`
3. Restart Firefox

### Accessibility

Fennec respects your OS "reduce motion" setting — all transitions become instant. On Linux you can also set `ui.prefersReducedMotion` to `1` in `about:config`.

### Recommended Extensions

- **Fennec Update Notifier** (coming soon) - Get notified when a new version of Fennec is available
- **[Vimium](https://addons.mozilla.org/en-US/firefox/addon/vimium-ff/)** - Keyboard-driven navigation that complements the minimal, distraction-free interface

## Customization

Your tweaks live in `chrome/user/user.css` — this file is never overwritten by updates.

```css
/* example: increase sidebar gap */
:root {
  --fen-gap-x: 12px;
}
```

## Contributing

Contributions welcome — especially bug fixes, docs improvements, and focused CSS refinements. For larger changes, please open an issue first. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

- Extensions are privileged software — install only ones you trust
- Zen Mode can hide browser security indicators; verify pages before browsing with the UI hidden
- Review install scripts before piping them into your shell
- Fennec is a UI customization, not a security tool — use it with normal caution

## Status

Actively maintained with recent releases and ongoing improvements. If something isn't working, check [open issues](https://github.com/tompassarelli/fennec/issues) or file a new one.
