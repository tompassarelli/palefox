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

## Backups & restoring

Every install or uninstall run creates ONE timestamped backup directory
in your profile, containing snapshots of everything that was modified.
Each directory has a `README.txt` explaining its contents and exact
restore commands for that snapshot.

```
<profile>/palefox-backup-<timestamp>/
  README.txt    What's here, how to restore (specific to this snapshot)
  chrome/       Pre-install snapshot of <profile>/chrome/ (only on install)
  utils/        Pre-uninstall snapshot of chrome/utils/ (only on uninstall)
  user.js       Pre-modification snapshot of user.js
  prefs.js      Pre-modification snapshot of prefs.js
```

Why both `user.js` and `prefs.js` are backed up: we modify `user.js`
directly (it's Firefox's force-apply layer), but Firefox writes our
`user.js` values into `prefs.js` (its persistent pref storage) on
startup. Backing up both gives you the full pre-palefox state.

To diff your current prefs against the pre-install state:
```bash
diff <profile>/palefox-backup-<timestamp>/user.js <profile>/user.js
```

To restore everything from a backup, follow the README.txt inside that
specific snapshot — paths and commands are pre-filled for your profile.

**Read the README.txt before restoring uninstall backups specifically.**
The fx-autoconfig backdoor that `uninstall-fx-autoconfig.sh` removes is
formed by three pieces in concert — install-root `config.js`, profile
`chrome/utils/`, and `userChromeJS.enabled=true` in `user.js`. Each
piece is inert alone, but if you restore `chrome/utils/` from an
uninstall backup AND later reinstall any palefox version or independent
fx-autoconfig, the chain reconnects and the backdoor is active again.
The README.txt inside each backup spells this out explicitly.

## Removing the legacy fx-autoconfig setup

If you installed palefox before the safer-js-loader switch, your Firefox
has a vanilla fx-autoconfig bootstrap that allows any process with write
access to your profile to drop a `.uc.js` and have it execute with browser
privileges. The hash-pinned loader closes this gap, but you may want to
just remove fx-autoconfig entirely instead of upgrading.

Run the uninstall script (does NOT remove your custom `chrome/JS/`,
`chrome/CSS/`, `userChrome.css`, etc. — those are preserved as your files):

```bash
./uninstall-fx-autoconfig.sh             # Linux / macOS Firefox
./uninstall-fx-autoconfig.sh --librewolf # LibreWolf
```

```powershell
.\uninstall-fx-autoconfig.ps1            # Windows Firefox
.\uninstall-fx-autoconfig.ps1 --librewolf
```

The script backs up `user.js` and `chrome/utils/` before removing them.
Verify with:
```bash
test ! -f /usr/lib/firefox/config.js && echo "✓ bootstrap removed"
test ! -d <profile>/chrome/utils && echo "✓ loader machinery removed"
! grep -q userChromeJS.enabled <profile>/user.js && echo "✓ pref forcing removed"
```

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
