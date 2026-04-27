#!/usr/bin/env bash
set -euo pipefail

REPO="tompassarelli/palefox"

# --- Argument parsing ---
FORCE=false
NO_BACKUP=false
USE_LIBREWOLF=false
REF=""
REF_TYPE=""

print_usage() {
    echo "Usage: install.sh [options]"
    echo ""
    echo "Version targeting (default: latest release):"
    echo "  --branch NAME      Install from a branch (e.g. main, css-legacy)"
    echo "  --tag NAME         Install from a tag (e.g. v0.36.4)"
    echo "  --commit SHA       Install from a specific commit"
    echo "  --latest-commit    Install from the latest commit on main"
    echo "  --release VERSION  Install a specific release (e.g. v0.36.4)"
    echo ""
    echo "Options:"
    echo "  --librewolf        Target LibreWolf instead of Firefox"
    echo "  --force            Overwrite user-customized files"
    echo "  --no-backup        Skip backing up existing chrome folder"
    echo "  --help             Show this help"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=true ;;
        --no-backup) NO_BACKUP=true ;;
        --librewolf) USE_LIBREWOLF=true ;;
        --branch) REF_TYPE="branch"; REF="${2:?--branch requires a name}"; shift ;;
        --tag) REF_TYPE="tag"; REF="${2:?--tag requires a name}"; shift ;;
        --commit) REF_TYPE="commit"; REF="${2:?--commit requires a SHA}"; shift ;;
        --latest-commit) REF_TYPE="branch"; REF="main" ;;
        --release) REF_TYPE="tag"; REF="${2:?--release requires a version}"; shift ;;
        --help) print_usage; exit 0 ;;
        *) echo "Unknown option: $1"; print_usage; exit 1 ;;
    esac
    shift
done

# Default: latest release
if [ -z "$REF_TYPE" ] && [ -z "${PALEFOX_LOCAL:-}" ]; then
    REF=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
    if [ -z "$REF" ]; then
        echo "Warning: could not fetch latest release tag, falling back to main"
        REF="main"
        REF_TYPE="branch"
    else
        REF_TYPE="tag"
    fi
fi

# Build archive URL
case "$REF_TYPE" in
    branch) ARCHIVE_URL="https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" ;;
    tag)    ARCHIVE_URL="https://github.com/$REPO/archive/refs/tags/$REF.tar.gz" ;;
    commit) ARCHIVE_URL="https://github.com/$REPO/archive/$REF.tar.gz" ;;
esac

# Browser selection
if [ "$USE_LIBREWOLF" = true ]; then
    BROWSER_NAME="LibreWolf"
    BROWSER_PROCESS="librewolf"
    PROFILE_PATTERN="*.default-default"
elif [ -z "${PALEFOX_LOCAL:-}" ] && [ -t 0 ]; then
    echo "Select browser:"
    echo "  1) Firefox (default)"
    echo "  2) LibreWolf"
    read -rp "Choice [1]: " browser_choice
    if [ "${browser_choice:-1}" = "2" ]; then
        BROWSER_NAME="LibreWolf"
        BROWSER_PROCESS="librewolf"
        PROFILE_PATTERN="*.default-default"
    else
        BROWSER_NAME="Firefox"
        BROWSER_PROCESS="firefox"
        PROFILE_PATTERN="*.default-release"
    fi
else
    BROWSER_NAME="Firefox"
    BROWSER_PROCESS="firefox"
    PROFILE_PATTERN="*.default-release"
fi

tmp_dir=""
cleanup() { if [ -n "$tmp_dir" ]; then rm -rf "$tmp_dir"; fi; }
trap cleanup EXIT

# Check if browser is running (skip in CI)
if [ -z "${PALEFOX_LOCAL:-}" ]; then
    if pgrep -x "$BROWSER_PROCESS" >/dev/null 2>&1; then
        echo "$BROWSER_NAME is currently running. Please close it before continuing."
        read -rp "Press Enter to continue after closing $BROWSER_NAME..."
    fi
fi

# Locate the profiles directory
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
            flatpak_dir="$HOME/.var/app/io.gitlab.librewolf-community.LibreWolf/.librewolf"
            xdg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/librewolf/librewolf"
            native_dir="$HOME/.librewolf"
        else
            snap_dir="$HOME/snap/firefox/common/.mozilla/firefox"
            flatpak_dir="$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"
            xdg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox"
            native_dir="$HOME/.mozilla/firefox"
        fi
        # Snap Firefox mounts its app directory read-only — fx-autoconfig can't be installed
        if [ "$BROWSER_NAME" = "Firefox" ] && [ -d "/snap/firefox" ]; then
            echo "Error: Snap Firefox detected."
            echo "Palefox requires writing to the Firefox application directory, which"
            echo "snap packages mount as read-only. CSS-only theming is available on"
            echo "the css-legacy branch, but the full JS experience requires native Firefox."
            echo ""
            echo "Switch to the Mozilla PPA:"
            echo "  sudo add-apt-repository ppa:mozillateam/ppa"
            echo "  sudo apt install -t 'o=LP-PPA-mozillateam' firefox"
            exit 1
        fi
        # Pick the first directory that actually contains profiles
        profiles_dir=""
        for candidate_dir in "${flatpak_dir:-}" "${xdg_dir:-}" "$native_dir"; do
            [ -n "$candidate_dir" ] && [ -d "$candidate_dir" ] || continue
            if find "$candidate_dir" -maxdepth 1 -type d -name '*.*' 2>/dev/null | grep -q .; then
                profiles_dir="$candidate_dir"
                break
            fi
        done
        if [ -z "$profiles_dir" ]; then
            echo "Error: No $BROWSER_NAME profile directory found. Make sure you've launched $BROWSER_NAME at least once."
            exit 1
        fi
        ;;
    *)
        echo "Error: Unsupported OS."
        exit 1
        ;;
esac

# Find profile directories (browser-specific pattern first, then fallback)
profiles=()
while IFS= read -r dir; do
    profiles+=("$dir")
done < <(find "$profiles_dir" -maxdepth 1 -type d -name "$PROFILE_PATTERN" 2>/dev/null)

if [ ${#profiles[@]} -eq 0 ]; then
    # Fall back to any profile directory
    while IFS= read -r dir; do
        profiles+=("$dir")
    done < <(find "$profiles_dir" -maxdepth 1 -type d -name '*.*' 2>/dev/null)
fi

if [ ${#profiles[@]} -eq 0 ]; then
    echo "Error: No $BROWSER_NAME profiles found in $profiles_dir. Make sure you've launched $BROWSER_NAME at least once."
    exit 1
fi

# Let user pick if multiple profiles exist
if [ ${#profiles[@]} -eq 1 ]; then
    profile="${profiles[0]}"
else
    echo "Multiple $BROWSER_NAME profiles found:"
    for i in "${!profiles[@]}"; do
        echo "  $((i + 1))) $(basename "${profiles[$i]}")"
    done
    read -rp "Select a profile [1-${#profiles[@]}]: " choice
    profile="${profiles[$((choice - 1))]}"
fi

echo "Using profile: $(basename "$profile")"

chrome_dir="$profile/chrome"

# Locate chrome source files
if [ -n "${PALEFOX_LOCAL:-}" ]; then
    # Use local checkout instead of downloading
    extracted="$PALEFOX_LOCAL/chrome"
    if [ ! -d "$extracted" ]; then
        echo "Error: chrome folder not found at $extracted"
        exit 1
    fi
else
    # Download specified ref
    tmp_dir="$(mktemp -d)"
    echo "Downloading Palefox ($REF)..."
    if ! curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$tmp_dir"; then
        echo "Error: Failed to download archive for ref '$REF'. Check that it exists."
        exit 1
    fi

    extracted="$(ls -d "$tmp_dir"/palefox-*/chrome 2>/dev/null | head -1)"
    if [ -z "$extracted" ] || [ ! -d "$extracted" ]; then
        echo "Error: chrome folder not found in downloaded archive."
        exit 1
    fi
fi

# Backup root: every install creates ONE palefox-backup-<timestamp>/ dir
# containing snapshots of everything we modify. User can restore individual
# files or the whole set. README.txt inside explains contents + restore.
TS="$(date +%Y-%m-%d-%H%M%S)"
BACKUP_DIR="$profile/palefox-backup-${TS}"
if [ "$NO_BACKUP" = false ]; then
    mkdir -p "$BACKUP_DIR"
    if [ -d "$chrome_dir" ]; then
        if ! cp -r "$chrome_dir" "$BACKUP_DIR/chrome"; then
            echo "Error: Failed to back up chrome folder."
            exit 1
        fi
    fi
fi

# Legacy migration gate: detect old monolithic userChrome.css
# Positive detection — these markers only exist in the old inline format
LEGACY_MIGRATED=false
if [ -f "$chrome_dir/userChrome.css" ]; then
    if grep -q '#region dev-docs' "$chrome_dir/userChrome.css" && grep -q -- '--pfx-' "$chrome_dir/userChrome.css"; then
        cp "$chrome_dir/userChrome.css" "$chrome_dir/userChrome.css.legacy"
        rm "$chrome_dir/userChrome.css"
        LEGACY_MIGRATED=true
    fi
fi

# Install files
echo "Installing palefox..."
mkdir -p "$chrome_dir"
mkdir -p "$chrome_dir/utils"
mkdir -p "$chrome_dir/JS"
mkdir -p "$chrome_dir/CSS"

# Migration: previous palefox versions wrote palefox*.css and userChrome.css
# at chrome/ root. The hash-pinned loader scans chrome/CSS/ instead, so
# those files now sit unloaded — clean them up to avoid confusion.
for stale in palefox.css palefox-tabs.css palefox-which-key.css palefox-legacy.css userChrome.css user.css; do
    if [ -f "$chrome_dir/$stale" ]; then
        rm -f "$chrome_dir/$stale"
    fi
done

# fx-autoconfig loader — always overwrite. Files here are HASHED by the
# bootstrap, so they must match exactly what palefox shipped.
if [ -d "$extracted/utils" ]; then
    rm -f "$chrome_dir/utils/"*
    cp "$extracted/utils/"* "$chrome_dir/utils/"
fi

# JS scripts — always overwrite (hashed by bootstrap; managed by palefox).
if [ -d "$extracted/JS" ]; then
    rm -f "$chrome_dir/JS/"*
    for file in "$extracted/JS/"*; do
        [ -f "$file" ] || continue
        cp "$file" "$chrome_dir/JS/"
    done
fi

# CSS files — always overwrite (hashed by bootstrap; managed by palefox).
if [ -d "$extracted/CSS" ]; then
    rm -f "$chrome_dir/CSS/"*
    for file in "$extracted/CSS/"*; do
        [ -f "$file" ] || continue
        cp "$file" "$chrome_dir/CSS/"
    done
fi

# Install fx-autoconfig to Firefox application directory
if [ -n "${PALEFOX_LOCAL:-}" ]; then
    program_source="$PALEFOX_LOCAL/program"
else
    program_source="$(dirname "$extracted")/program"
fi

if [ -d "$program_source" ]; then
    # Locate Firefox install directory
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
            # which may resolve to a wrapper in /usr/bin — fall back to known paths
            if [ "$app_dir" = "/usr/bin" ] || [ ! -f "$app_dir/application.ini" ]; then
                for candidate in /usr/lib/"$BROWSER_PROCESS" /usr/lib64/"$BROWSER_PROCESS" /opt/"$BROWSER_PROCESS" /snap/"$BROWSER_PROCESS"/current/usr/lib/"$BROWSER_PROCESS"; do
                    if [ -f "$candidate/application.ini" ]; then
                        app_dir="$candidate"
                        break
                    fi
                done
            fi
            ;;
    esac

    # The HASH-PINNED bootstrap is at config.generated.js (built by
    # `bun run build` from program/config.template.js with chrome/ file
    # hashes baked in). It refuses to load any chrome JS or CSS whose
    # hash doesn't match the manifest baked into this file at build time.
    # See docs/dev/sandbox-research.md for the threat-model rationale.
    bootstrap_src="$program_source/config.generated.js"
    if [ ! -f "$bootstrap_src" ]; then
        # Fallback for tarball installs that include the generated file.
        bootstrap_src="$program_source/config.js"
    fi
    if [ ! -f "$bootstrap_src" ]; then
        echo "Error: bootstrap not found at $bootstrap_src."
        echo "If installing from source, run \`bun run build\` first."
        exit 1
    fi

    if [ -n "${app_dir:-}" ] && [ -d "$app_dir" ]; then
        # Notice users upgrading from vanilla fx-autoconfig that we're
        # tightening their security boundary. No prompt — they ran install.sh,
        # they're opting in to the current palefox model. Ctrl-C if they object.
        if [ -f "$app_dir/config.js" ] && ! grep -q PALEFOX_PINNED "$app_dir/config.js" 2>/dev/null; then
            echo ""
            echo "Detected vanilla fx-autoconfig bootstrap — upgrading to palefox hash-pinned variant."
            echo "This tightens palefox's security boundary:"
            echo "  • Chrome JS/CSS files are SHA-256 verified at startup"
            echo "  • Local-mode malware can no longer drop a .uc.js into your profile"
            echo "    and have it execute with browser privileges"
            echo "  • Any non-palefox .uc.js you had in chrome/JS/ will be rejected"
            echo "    post-upgrade (backed up under chrome.bak.<timestamp>/JS/)"
            echo "See docs/dev/sandbox-research.md for the threat-model writeup."
            echo ""
        fi
        echo "Installing palefox hash-pinned loader to $app_dir..."
        if [ -w "$app_dir" ]; then
            cp "$bootstrap_src" "$app_dir/config.js"
            mkdir -p "$app_dir/defaults/pref"
            cp "$program_source/defaults/pref/config-prefs.js" "$app_dir/defaults/pref/config-prefs.js"
        else
            echo "Elevated privileges required to install loader to $app_dir"
            sudo cp "$bootstrap_src" "$app_dir/config.js"
            sudo mkdir -p "$app_dir/defaults/pref"
            sudo cp "$program_source/defaults/pref/config-prefs.js" "$app_dir/defaults/pref/config-prefs.js"
        fi
    else
        echo "Warning: Could not locate $BROWSER_NAME install directory."
        echo "Manually copy program/config.generated.js → <install-root>/config.js"
        echo "and program/defaults/pref/config-prefs.js → <install-root>/defaults/pref/"
        echo "for JavaScript support."
    fi
fi

# Print legacy migration notice
if [ "$LEGACY_MIGRATED" = true ]; then
    echo ""
    echo "Note: Your previous userChrome.css used the legacy monolithic layout."
    echo "It has been backed up to: chrome/userChrome.css.legacy"
    echo "Move any personal tweaks from that file into chrome/user.css"
fi

# Configure browser preferences in user.js
user_js="$profile/user.js"
prefs_js="$profile/prefs.js"

# Back up user.js + prefs.js into the same palefox-backup-<TS>/ dir
# as the chrome snapshot. Either may be absent on a fresh profile.
if [ "$NO_BACKUP" = false ]; then
    [ -f "$user_js" ] && cp "$user_js" "$BACKUP_DIR/user.js"
    [ -f "$prefs_js" ] && cp "$prefs_js" "$BACKUP_DIR/prefs.js"
fi

set_pref() {
    local key="$1" value="$2"
    local pref="user_pref(\"$key\", $value);"
    if [ ! -f "$user_js" ] || ! grep -q "$key" "$user_js"; then
        echo "Setting $key in user.js"
        echo "$pref" >> "$user_js"
    fi
}

# Force-overwrite a pref. set_pref() preserves existing values, which is
# correct for user-customizable prefs but wrong for prefs whose value
# changed across palefox versions (e.g. legacy stylesheets flipping
# true → false when the loader stopped depending on it).
force_set_pref() {
    local key="$1" value="$2"
    local pref="user_pref(\"$key\", $value);"
    if [ -f "$user_js" ] && grep -q "\"$key\"" "$user_js"; then
        # Strip the existing line; we'll re-append below.
        local tmp="${user_js}.tmp.$$"
        grep -v "\"$key\"" "$user_js" > "$tmp"
        mv "$tmp" "$user_js"
    fi
    echo "Setting $key in user.js"
    echo "$pref" >> "$user_js"
}

# Legacy stylesheets pref OFF — palefox CSS now loads via the hash-pinned
# loader's chrome:// CSS registration, NOT via Firefox's userChrome.css
# direct-load path. Leaving the pref true would leave the (unhashed) old
# userChrome.css path open as an attack surface. force_set_pref overrides
# any pre-existing `true` from older palefox installs.
force_set_pref "toolkit.legacyUserProfileCustomizations.stylesheets" "false"
# fx-autoconfig loader gate — required for the autoconfig bootstrap chain
# to actually load palefox JS and CSS.
force_set_pref "userChromeJS.enabled" "true"
set_pref "sidebar.verticalTabs" "true"
set_pref "sidebar.revamp" "true"
set_pref "sidebar.position_start" "true"
set_pref "browser.toolbars.bookmarks.visibility" "\"never\""
set_pref "pfx.sidebar.width" 300

# Default toolbar layout: core buttons in nav-bar, extras in overflow menu
set_pref "browser.uiCustomization.state" "'{\"placements\":{\"widget-overflow-fixed-list\":[\"fxa-toolbar-menu-button\",\"home-button\",\"alltabs-button\",\"firefox-view-button\"],\"unified-extensions-area\":[],\"nav-bar\":[\"sidebar-button\",\"back-button\",\"forward-button\",\"stop-reload-button\",\"customizableui-special-spring1\",\"vertical-spacer\",\"urlbar-container\",\"customizableui-special-spring2\",\"downloads-button\",\"unified-extensions-button\"],\"toolbar-menubar\":[\"menubar-items\"],\"TabsToolbar\":[\"tabbrowser-tabs\",\"new-tab-button\"],\"vertical-tabs\":[],\"PersonalToolbar\":[\"import-button\",\"personal-bookmarks\"]},\"seen\":[],\"dirtyAreaCache\":[],\"currentVersion\":23,\"newElementCount\":0}'"

# GTK may send spurious leave events that break autohide
if [ "$(uname -s)" = "Linux" ]; then
    set_pref "widget.gtk.ignore-bogus-leave-notify" 1
fi

# Write README explaining backup contents + restore steps. Only if backups
# were made (NO_BACKUP not set, and there was something to back up).
if [ "$NO_BACKUP" = false ] && [ -d "$BACKUP_DIR" ] && [ -n "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    cat > "$BACKUP_DIR/README.txt" << EOF
palefox install backup — ${TS}
Created by: install.sh

Snapshot of files palefox modified (or caused Firefox to modify) on this
install run. Restore individually or all at once.

Contents (only present if it existed before install):
  chrome/    Snapshot of <profile>/chrome/ before palefox replaced
             utils/, JS/, CSS/. Includes any custom userChrome.css,
             user.css, or other userscripts you had.
  user.js    Snapshot of <profile>/user.js (Firefox force-apply prefs)
             before palefox modified it.
  prefs.js   Snapshot of <profile>/prefs.js (Firefox's persistent pref
             storage) before this install. We don't write prefs.js
             directly, but Firefox writes our user.js values into it on
             startup, so this captures the genuinely-pre-palefox state.

Restore individually:
  cp ./user.js     "$profile/user.js"
  cp ./prefs.js    "$profile/prefs.js"
  cp -r ./chrome/* "$chrome_dir/"

Restore everything:
  cp -r ./* "$profile/"

SECURITY NOTE — read before restoring:
This install upgraded palefox to a hash-pinned loader, closing a known
fx-autoconfig vulnerability where any user-mode process could inject
privileged JS by dropping a .uc.js file into your profile.

Restoring this backup rolls you back to your prior palefox state. If that
state used vanilla fx-autoconfig (palefox versions before safer-js-loader),
restoring reintroduces the vulnerability. To roll back AND keep the
security upgrade, restore from this backup, then run
uninstall-fx-autoconfig.sh to remove the legacy loader entirely.
EOF
    echo ""
    echo "Backup: $BACKUP_DIR/"
fi

echo "Done. Restart $BROWSER_NAME for changes to take effect."
