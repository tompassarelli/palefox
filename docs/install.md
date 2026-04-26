# Installation

> Palefox runs chrome-privileged JS and CSS in your browser via a
> **hash-pinned loader** that refuses to execute any script or stylesheet
> whose SHA-256 doesn't match the manifest baked in at install time. See
> [docs/dev/sandbox-research.md](dev/sandbox-research.md) for context.

The README's [Quick Install](../README.md#quick-install) covers the common
case (latest tagged release). This guide covers everything else: targeting
a specific branch / tag / commit / release, manual install, dev workflows,
and uninstall.

## What gets installed

The install script copies these files into your browser profile's `chrome/`
directory and writes a few prefs to `user.js`:

| File | Owner | On update |
|------|-------|-----------|
| `chrome/CSS/palefox*.uc.css` | palefox | overwritten (hashed by loader) |
| `chrome/JS/palefox-*.uc.js` | palefox | overwritten (hashed by loader) |
| `chrome/utils/*` | palefox | overwritten (loader machinery, hashed) |

Personal customization without rebuilding palefox is **not supported on
this branch** — the bootstrap rejects unknown files in the watched
directories. Drop your own scripts or styles by either: (a) checking out
palefox source, adding your files, running `bun run build`, then
`./install.sh`; or (b) using the [`css-legacy`](https://github.com/tompassarelli/palefox/tree/css-legacy)
branch (CSS-only, no loader, no hash gate).

Plus, in your Firefox application directory (requires sudo, root-owned):

| File | Purpose |
|------|---------|
| `config.js` | palefox hash-pinned bootstrap (built from `program/config.template.js`) |
| `defaults/pref/config-prefs.js` | autoconfig prefs that point Firefox at `config.js` |

## Version targeting

By default the install script grabs the latest tagged release. You can override:

| Flag | What it installs |
|------|------------------|
| (none) | Latest tagged release (recommended) |
| `--branch <name>` | Tip of a branch (e.g. `--branch main` for latest dev) |
| `--tag <name>` | A specific tag (e.g. `--tag v0.36.4`) |
| `--release <name>` | Same as `--tag`, alias for clarity |
| `--commit <sha>` | A specific commit |
| `--latest-commit` | Latest commit on `main` |

**Examples — macOS / Linux:**
```bash
# Latest dev (tip of main)
curl -fsSL https://raw.githubusercontent.com/tompassarelli/palefox/main/install.sh -o /tmp/palefox-install.sh \
  && bash /tmp/palefox-install.sh --branch main

# A specific release
bash /tmp/palefox-install.sh --release v0.36.4

# A specific commit
bash /tmp/palefox-install.sh --commit 6c9b7dd
```

**Examples — Windows (PowerShell):**
```powershell
# Latest dev
irm https://raw.githubusercontent.com/tompassarelli/palefox/main/install.ps1 -OutFile $env:TEMP\palefox-install.ps1
& $env:TEMP\palefox-install.ps1 --branch main

# A specific release
& $env:TEMP\palefox-install.ps1 --release v0.36.4
```

## Other flags

| Flag | Effect |
|------|--------|
| `--librewolf` | Install into LibreWolf profile instead of Firefox |
| `--force` | Overwrite user-customized files (`userChrome.css`, `user.css`) |
| `--no-backup` | Skip backing up the existing `chrome/` folder before install |
| `--help` | Show usage summary |

When more than one Firefox / LibreWolf profile exists, the script prompts
you to pick (interactive) or picks `*.default-release` automatically.

## Manual install

If you'd rather not pipe a script, the manual flow is:

1. **Locate your profile.** Open `about:support` and click "Open Profile
   Folder" under Application Basics.
   - Flatpak: `~/.var/app/org.mozilla.firefox/.mozilla/firefox/<profile>`
   - LibreWolf: `~/.librewolf/` or `~/.config/librewolf/librewolf/`
2. **Enable user JS / CSS prefs.** Open `about:config`:
   - `toolkit.legacyUserProfileCustomizations.stylesheets` → `true`
   - `sidebar.verticalTabs` → `true`
   - `sidebar.revamp` → `true`
   - `sidebar.position_start` → `true`
   - `browser.toolbars.bookmarks.visibility` → `"never"`
3. **Copy the chrome files.** From this repo's `chrome/` directory, copy
   into your profile's `chrome/` directory:
   - `userChrome.css`, `palefox.css`, `palefox-tabs.css`, `user.css`
   - The `JS/` folder
   - The `utils/` folder (fx-autoconfig loader)
4. **Copy the fx-autoconfig bootstrap.** From this repo's `program/`,
   copy into your Firefox application directory (where `firefox` lives):
   - `config.js`
   - `defaults/pref/config-prefs.js`

   *macOS:* `/Applications/Firefox.app/Contents/Resources/`
   *Linux (typical):* `/usr/lib/firefox/` or wherever `firefox` is installed
   *Windows:* `C:\Program Files\Mozilla Firefox\`

5. **Restart the browser.**

## Dev workflow (PALEFOX_LOCAL)

If you're hacking on palefox locally, set `PALEFOX_LOCAL` to your repo
checkout to install from there instead of downloading:

```bash
PALEFOX_LOCAL=/home/me/code/palefox bash install.sh
```

This skips the network fetch and skips the interactive browser prompt.

## Upgrading

Re-run the install script. It backs up `chrome/` to `chrome.bak.<timestamp>`
before overwriting (skip with `--no-backup`). Your `user.css` and
`user.js` prefs are preserved.

If you have an old monolithic `userChrome.css` from a pre-modular palefox,
the install script saves it as `userChrome.css.legacy` and installs the
new entry point. Move any personal tweaks from there into `user.css`.

## Uninstalling

1. Delete the `chrome/` folder in your profile directory.
2. Remove the palefox lines from `user.js` (or delete `user.js` entirely
   if palefox created it).
3. Optionally remove `config.js` and `defaults/pref/config-prefs.js` from
   your Firefox application directory to disable the fx-autoconfig loader.

## Nix / Home Manager

See [docs/nix.md](nix.md) for declarative install on Nix-based systems.
