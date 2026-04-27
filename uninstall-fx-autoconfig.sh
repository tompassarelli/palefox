#!/usr/bin/env bash
# Removes the fx-autoconfig setup that previous palefox versions left in place.
#
# Why this script exists:
#   palefox versions before the safer-js-loader switch installed vanilla
#   fx-autoconfig as the chrome JS loader. That loader has a known
#   user-write attack surface: any process with write access to your
#   Firefox profile can drop a .uc.js into <profile>/chrome/JS/ and have
#   it execute with full browser privileges. This script removes that
#   loader, restoring Firefox to its vanilla autoconfig-less state.
#
# What it does:
#   1. Backs up user.js to user.js.bak.<timestamp>
#   2. Backs up <profile>/chrome/utils/ to chrome.utils.bak.<timestamp>/
#   3. Removes <install-root>/config.js + defaults/pref/config-prefs.js (sudo)
#   4. Removes <profile>/chrome/utils/
#   5. Strips the userChromeJS.enabled line from user.js (returns the pref
#      to Firefox's default; about:config can manage from there)
#
# What it does NOT touch (your files, your call):
#   - <profile>/chrome/JS/, chrome/CSS/, chrome/userChrome.css, etc.
#     These are inert without the loader. Delete manually if you want.
#   - Other prefs in user.js (toolkit.legacyUserProfileCustomizations.stylesheets,
#     pfx.*, sidebar.*). Strip from user.js manually if desired.
#
# Verification (run after this script):
#   test ! -f /usr/lib/firefox/config.js && echo "✓ bootstrap removed"
#   test ! -d <profile>/chrome/utils && echo "✓ loader machinery removed"
#   ! grep -q userChromeJS.enabled <profile>/user.js && echo "✓ pref forcing removed"

set -euo pipefail

USE_LIBREWOLF=false
while [ $# -gt 0 ]; do
    case "$1" in
        --librewolf) USE_LIBREWOLF=true ;;
        --help)
            sed -n '2,32p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

if [ "$USE_LIBREWOLF" = true ]; then
    BROWSER_NAME="LibreWolf"
    BROWSER_PROCESS="librewolf"
    PROFILE_PATTERN="*.default-default"
else
    BROWSER_NAME="Firefox"
    BROWSER_PROCESS="firefox"
    PROFILE_PATTERN="*.default-release"
fi

if pgrep -x "$BROWSER_PROCESS" >/dev/null 2>&1; then
    echo "$BROWSER_NAME is currently running. Please close it before continuing."
    read -rp "Press Enter to continue after closing $BROWSER_NAME..."
fi

# Locate profile (mirrors install.sh logic)
case "$(uname -s)" in
    Darwin)
        if [ "$BROWSER_NAME" = "LibreWolf" ]; then
            profiles_dir="$HOME/Library/Application Support/librewolf/Profiles"
        else
            profiles_dir="$HOME/Library/Application Support/Firefox/Profiles"
        fi
        ;;
    Linux)
        if [ "$BROWSER_NAME" = "LibreWolf" ]; then
            for d in "$HOME/.var/app/io.gitlab.librewolf-community.LibreWolf/.librewolf" \
                     "${XDG_CONFIG_HOME:-$HOME/.config}/librewolf/librewolf" \
                     "$HOME/.librewolf"; do
                [ -d "$d" ] && profiles_dir="$d" && break
            done
        else
            for d in "$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox" \
                     "${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox" \
                     "$HOME/.mozilla/firefox"; do
                [ -d "$d" ] && profiles_dir="$d" && break
            done
        fi
        ;;
    *) echo "Unsupported OS"; exit 1 ;;
esac

if [ -z "${profiles_dir:-}" ] || [ ! -d "$profiles_dir" ]; then
    echo "Error: $BROWSER_NAME profile directory not found."
    exit 1
fi

profiles=()
while IFS= read -r dir; do profiles+=("$dir"); done \
    < <(find "$profiles_dir" -maxdepth 1 -type d -name "$PROFILE_PATTERN" 2>/dev/null)

if [ ${#profiles[@]} -eq 0 ]; then
    echo "Error: No $BROWSER_NAME profile found matching $PROFILE_PATTERN."
    exit 1
fi

if [ ${#profiles[@]} -eq 1 ]; then
    profile="${profiles[0]}"
else
    echo "Multiple profiles found:"
    for i in "${!profiles[@]}"; do
        echo "  $((i + 1))) $(basename "${profiles[$i]}")"
    done
    read -rp "Select [1-${#profiles[@]}]: " choice
    profile="${profiles[$((choice - 1))]}"
fi

echo "Profile: $(basename "$profile")"
chrome_dir="$profile/chrome"
user_js="$profile/user.js"
prefs_js="$profile/prefs.js"
TS="$(date +%Y-%m-%d-%H%M%S)"

# --- 1. Backup root: one palefox-backup-<ts>/ dir, all snapshots inside ---
# user.js: what we modify directly (strip userChromeJS.enabled line)
# prefs.js: not modified, but contains values Firefox persisted from our
#           prior user.js — snapshot so user has full pre-uninstall state
# chrome/utils/: removed entirely; snapshot it before deleting
BACKUP_DIR="$profile/palefox-backup-${TS}"
mkdir -p "$BACKUP_DIR"
[ -f "$user_js" ] && cp "$user_js" "$BACKUP_DIR/user.js"
[ -f "$prefs_js" ] && cp "$prefs_js" "$BACKUP_DIR/prefs.js"
[ -d "$chrome_dir/utils" ] && cp -r "$chrome_dir/utils" "$BACKUP_DIR/utils"

# --- 3. Remove install-root bootstrap (sudo) ---
case "$(uname -s)" in
    Darwin)
        if [ "$BROWSER_NAME" = "LibreWolf" ]; then
            app_dir="/Applications/LibreWolf.app/Contents/Resources"
        else
            app_dir="/Applications/Firefox.app/Contents/Resources"
        fi
        ;;
    Linux)
        app_dir="$(dirname "$(readlink -f "$(which "$BROWSER_PROCESS" 2>/dev/null)")" 2>/dev/null)"
        if [ "$app_dir" = "/usr/bin" ] || [ ! -f "$app_dir/application.ini" ]; then
            for c in /usr/lib/"$BROWSER_PROCESS" /usr/lib64/"$BROWSER_PROCESS" /opt/"$BROWSER_PROCESS"; do
                [ -f "$c/application.ini" ] && app_dir="$c" && break
            done
        fi
        ;;
esac

if [ -n "${app_dir:-}" ] && [ -d "$app_dir" ]; then
    if [ -f "$app_dir/config.js" ]; then
        echo "Removing $app_dir/config.js (may prompt for sudo)..."
        if [ -w "$app_dir/config.js" ]; then
            rm -f "$app_dir/config.js"
        else
            sudo rm -f "$app_dir/config.js"
        fi
    fi
    if [ -f "$app_dir/defaults/pref/config-prefs.js" ]; then
        echo "Removing $app_dir/defaults/pref/config-prefs.js..."
        if [ -w "$app_dir/defaults/pref/config-prefs.js" ]; then
            rm -f "$app_dir/defaults/pref/config-prefs.js"
        else
            sudo rm -f "$app_dir/defaults/pref/config-prefs.js"
        fi
    fi
fi

# --- 4. Remove profile-side loader machinery ---
if [ -d "$chrome_dir/utils" ]; then
    rm -rf "$chrome_dir/utils"
    echo "Removed $chrome_dir/utils/"
fi

# --- 5. Strip userChromeJS.enabled from user.js (don't write a new value) ---
if [ -f "$user_js" ] && grep -q '"userChromeJS\.enabled"' "$user_js"; then
    tmp="${user_js}.tmp.$$"
    grep -v '"userChromeJS\.enabled"' "$user_js" > "$tmp"
    mv "$tmp" "$user_js"
    echo "Stripped userChromeJS.enabled from user.js"
fi

# Write README explaining the backup contents + restore steps.
if [ -n "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    cat > "$BACKUP_DIR/README.txt" << EOF
palefox uninstall-fx-autoconfig backup — ${TS}
Created by: uninstall-fx-autoconfig.sh

Snapshot of files this script modified or removed. Restore individually
or all at once.

Contents (only present if it existed before uninstall):
  user.js    Snapshot of <profile>/user.js before we stripped the
             userChromeJS.enabled line.
  prefs.js   Snapshot of <profile>/prefs.js before this uninstall run.
             We don't write prefs.js directly, but it contains
             palefox-set values Firefox persisted from past user.js
             applications. After uninstall, those values linger in
             prefs.js until you reset them via about:config — this
             snapshot is your pre-uninstall pref state if you need it.
  utils/     Snapshot of <profile>/chrome/utils/ before we removed it
             (the fx-autoconfig loader machinery).

Restore individually:
  cp ./user.js  "$user_js"
  cp ./prefs.js "$prefs_js"
  cp -r ./utils "$chrome_dir/"

Restore everything:
  cp ./user.js "$user_js"
  cp ./prefs.js "$prefs_js"
  [ -d ./utils ] && cp -r ./utils "$chrome_dir/"

To also restore the install-root bootstrap (if you want fx-autoconfig back):
  re-run the palefox install.sh from the version you uninstalled from.

SECURITY NOTE — read before restoring:
This script removed the fx-autoconfig backdoor by removing three pieces
in concert. EACH piece is inert without the others — restoring just one
is safe — but together they form the loader chain that lets any
user-mode process inject privileged JS into Firefox:

  1. <install-root>/config.js   — autoconfig bootstrap (already removed)
  2. <profile>/chrome/utils/    — loader machinery (snapshotted as utils/)
  3. userChromeJS.enabled=true  — loader gate (in your user.js snapshot)

Restoring utils/ alone: inert. No bootstrap to chain into it.
Restoring user.js alone: inert. The pref does nothing without a loader.

If you restore utils/ AND later install any palefox version OR
independent fx-autoconfig (which provides piece 1), the chain reconnects
and the backdoor is active again. Restore individual pieces only if you
understand what you're putting back.
EOF
fi

echo ""
echo "Done. fx-autoconfig has been removed."
echo ""
echo "Backup: $BACKUP_DIR/"
echo ""
echo "Verify:"
echo "  test ! -f \"$app_dir/config.js\" && echo OK_bootstrap"
echo "  test ! -d \"$chrome_dir/utils\" && echo OK_loader"
echo "  ! grep -q userChromeJS.enabled \"$user_js\" && echo OK_pref"
