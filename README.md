# Fennec

Fennec is a minimal Firefox setup built with userChrome.css, designed around vertical tabs, zen mode, and keyboard-driven browsing. One CSS file, no fork, no build — the sidebar-first workflow of Zen Browser without leaving Firefox.

| Sidebar Open | Zen Mode |
|:---:|:---:|
| ![Fennec with sidebar](fennec.webp) | ![Fennec without sidebar](fennec-no-sidebar.webp) |

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

The script does the following:
- Backs up your existing `chrome` folder (if any) to `chrome.bak.<timestamp>`
- Copies Fennec's `chrome/` files into your Firefox profile
- Writes prefs to `user.js`: disables vertical tabs, disables the sidebar revamp, enables custom stylesheets

> **To uninstall:** delete the `chrome` folder and remove the Fennec lines from `user.js` in your profile directory (or delete `user.js` entirely if Fennec created it). Your backup is in `chrome.bak.*`.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/tompassarelli/fennec/main/install.sh | bash
```

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/tompassarelli/fennec/main/install.ps1 | iex
```

#### Option B: Manual

**Enable required Firefox settings:**

> Note: only `toolkit.legacyUserProfileCustomizations.stylesheets` requires `about:config`. The rest are defaults historically and can also be changed in Settings.

1. Go to `about:config` in the address bar
2. Set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true`
3. Set `sidebar.verticalTabs` to `false` (or turn on **Horizontal tabs** in Settings)
4. Set `sidebar.revamp` to `false` (or turn off **Show Sidebar** in Settings)

**Locate your Firefox profile directory:**
1. Go to `about:support` in the address bar
2. Under "Application Basics", click **Open Profile Folder**
   - Flatpak users: the profile directory is at `~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>`

**Copy the CSS files:**
1. Inside the profile folder, create a `chrome` directory if it doesn't already exist
2. Copy `userChrome.css` from this repo's `chrome/` folder into that `chrome` directory
3. Copy `autohide.css` into the same `chrome` directory (needed if you want [autohide](#autohide-off-by-default))

### 3. Restart Firefox
   - Note: if the sidebar is invisible, you might have it toggled off. Try `Ctrl+H` to toggle history, then activate the Sideberry tabs menu from there by clicking on the extension icon.

## Optional Features

### Autohide (off by default)

Sidebar must be enabled (not toggled off). When enabled, the drawer auto-collapses when the mouse leaves and reappears when hovering the left edge of the window.

To enable:
1. Ensure `autohide.css` is in the same `chrome` directory as `userChrome.css` (see [installation step 2](#2-install-css))
2. Uncomment `@import url("autohide.css");` in `userChrome.css`
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
