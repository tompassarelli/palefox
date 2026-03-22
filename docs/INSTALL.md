# Installation

> Please see [security considerations](../README.md#security) before installing

## 1. Install the Sideberry Extension

Install [Sideberry](https://addons.mozilla.org/en-US/firefox/addon/sidebery/) from Firefox Add-ons.

## 2. Install CSS

### Option A: Automated (recommended)

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

### Option B: Manual

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

## 3. Restart your browser

Note: if the sidebar is invisible, you might have it toggled off. Try `Ctrl+H` to toggle history, then activate the Sideberry tabs menu from there by clicking on the extension icon.

## Upgrading

If you had a monolithic `userChrome.css`, the install script will back it up to `userChrome.css.legacy` and install the new modular entry point. Move personal tweaks into `user/user.css`.

## Uninstalling

Delete the `chrome` folder and remove the Fennec lines from `user.js` in your profile directory (or delete `user.js` entirely if Fennec created it).
