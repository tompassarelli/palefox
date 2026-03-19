# Fennec

Fennec is a minimal Firefox/Librewolf setup built with userChrome.css, designed around vertical tabs, zen mode, and keyboard-driven browsing. No fork, no build — the sidebar-first workflow of Zen Browser without leaving Firefox.

| Sidebar Open | Zen Mode |
|:---:|:---:|
| ![Fennec with sidebar](https://github.com/user-attachments/assets/9fc9691d-8e5e-4864-bdd8-0aa696955d86) | ![Fennec without sidebar](https://github.com/user-attachments/assets/7db86916-8c1c-4feb-91de-0f62d5fab209) |

## Features

🔗 **Enhanced Sideberry Integration** - Urlbar inside the sidebar-box, tracks sidebar width, and expands when focused

🧘 **Zen Mode** - Toggling the sidebar hides the UI, maximizing screen space and aiding focus when tiled or maximized

✨ **Minimal Chrome** - Only essential objects exposed, coherent with a keyboard driven UX

🛠️ **Community Minded** - Clean code and detailed docs to support customization and contribution

🎨 **Theme Support** - System themes (light-dark) supported. User created Firefox themes are also supported.

## Installation

> Please see [security considerations](#security-considerations) before installing

### 1. Install the Sideberry Extension

Install [Sideberry](https://addons.mozilla.org/en-US/firefox/addon/sidebery/) from Firefox Add-ons.

### 2. Install CSS

Choose **one** of the two methods below:

#### Option A: Automated (recommended)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/fennec/main/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/fennec/main/install.ps1 | iex
```

**Librewolf:** add `--librewolf` to either command, or select Librewolf when prompted interactively.

The script does the following:
- Detects Firefox or Librewolf profile directories (including Flatpak and XDG paths on Linux)
- Copies core files (`fennec/fennec.css`, `fennec/autohide.css`) into your profile — always updated
- Creates `userChrome.css` (entry point) and `user/user.css` (your customizations) if they don't exist — preserved on update
- Writes prefs to `user.js`: disables vertical tabs, disables the sidebar revamp, enables custom stylesheets
- Use `--force` to overwrite all files (e.g. clean reinstall)
- Use `--no-backup` to skip the backup

The entry point wires everything together:
```css
@import url("fennec/fennec.css");
/* @import url("fennec/autohide.css"); */
@import url("user/user.css");
```
Fennec updates `chrome/fennec/`. Your tweaks live in `chrome/user/`. `userChrome.css` just wires them together — advanced users can edit it to add extra imports.

> **To uninstall:** delete the `chrome` folder and remove the Fennec lines from `user.js` in your profile directory (or delete `user.js` entirely if Fennec created it).

#### Option B: Manual

**Enable required Firefox settings:**

> Note: only `toolkit.legacyUserProfileCustomizations.stylesheets` requires `about:config`. The rest are defaults historically and can also be changed in Settings.

1. Go to `about:config` in the address bar
2. Set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true`
3. Set `sidebar.verticalTabs` to `false` (or turn on **Horizontal tabs** in Settings)
4. Set `sidebar.revamp` to `false` (or turn off **Show Sidebar** in Settings)

**Locate your profile directory:**
1. Go to `about:support` in the address bar
2. Under "Application Basics", click **Open Profile Folder**
   - Flatpak users: the profile directory is at `~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>`
   - Librewolf users: check `~/.librewolf/` or `~/.config/librewolf/librewolf/` on Linux

**Copy the CSS files:**
1. Inside the profile folder, create a `chrome` directory if it doesn't already exist
2. Copy `userChrome.css`, the `fennec/` folder, and the `user/` folder from this repo's `chrome/` directory into your profile's `chrome/` directory
3. Put your personal customizations in `user/user.css` — it won't be overwritten when fennec is updated

> **Upgrading from an older version?** If you previously had a monolithic `userChrome.css` with all CSS inline, the install script will detect this, back up your old file to `userChrome.css.legacy`, and install the new modular entry point. Move any personal tweaks from the legacy file into `user/user.css`.

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
    :root { --fen-gap-x: 15px; }
  '';
};
```

4. Rebuild with `nixos-rebuild switch` or `home-manager switch`

> Note: Sideberry is installed automatically via [NUR](https://github.com/nix-community/NUR). Ensure NUR is in your flake inputs and overlays. Set `sideberry = false` if you manage extensions separately.

## Optional Features

### Autohide (off by default)

Sidebar must be enabled (not toggled off). When enabled, the drawer auto-collapses when the mouse leaves and reappears when hovering the left edge of the window.

To enable:
1. Ensure `fennec/autohide.css` is in your `chrome/fennec/` directory (see [installation step 2](#2-install-css))
2. Uncomment `@import url("fennec/autohide.css");` in `userChrome.css`
3. Restart Firefox

### Recommended Extensions

- **[Vimium](https://addons.mozilla.org/en-US/firefox/addon/vimium-ff/)** - Keyboard-driven navigation that complements the minimal, distraction-free interface

## Help 

If something isn't working, check [open issues](https://github.com/tompassarelli/fennec/issues) or file a new one.

## Security Considerations

- The install guide directs users to download Firefox extensions. Firefox extensions can introduce security vulnerabilities and/or take direct hostile actions against users.
- Zen Mode hides the UI which obviously suppresses security signals like padlock warnings. In appreciation of this concern, Fennec will still attempt to surface a custom HTTP Not Secure security warning prepended to page content as a header alert. Not a solution against phishing and other attacks/vulnerabilities, only toggle the UI after the page has been verified as secure and trustworthy.
- **Use at your own risk** - The author is not liable for any security issues, data breaches, or other damages of usage of this repository or mentioned extensions.
- **You are responsible** for verifying the security of websites, code, and extensions used
- Always keep Firefox updated

**By using this theme and mentioned Firefox extensions, you acknowledge these risks and agree that the author bears no responsibility for any consequences.**
