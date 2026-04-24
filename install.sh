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

# Backup existing chrome folder
if [ -d "$chrome_dir" ] && [ "$NO_BACKUP" = false ]; then
    backup_dir="$profile/chrome.bak.$(date +%Y-%m-%d-%H%M%S)"
    echo "Backing up existing chrome folder to $(basename "$backup_dir")"
    if ! cp -r "$chrome_dir" "$backup_dir"; then
        echo "Error: Failed to back up chrome folder."
        exit 1
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

# Core files — always overwrite
for file in palefox.css palefox-tabs.css; do
    if [ -f "$extracted/$file" ]; then
        cp "$extracted/$file" "$chrome_dir/$file"
    fi
done

# fx-autoconfig loader — always overwrite
if [ -d "$extracted/utils" ]; then
    cp "$extracted/utils/"* "$chrome_dir/utils/"
fi

# JS scripts — always overwrite (managed by palefox)
if [ -d "$extracted/JS" ]; then
    for file in "$extracted/JS/"*; do
        [ -f "$file" ] || continue
        cp "$file" "$chrome_dir/JS/"
    done
fi

# User files — preserve if present, create if missing
for file in userChrome.css user.css; do
    if [ -f "$extracted/$file" ]; then
        if [ ! -f "$chrome_dir/$file" ] || [ "$FORCE" = true ]; then
            cp "$extracted/$file" "$chrome_dir/$file"
        else
            echo "Preserved: $file"
        fi
    fi
done

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

    if [ -n "${app_dir:-}" ] && [ -d "$app_dir" ]; then
        echo "Installing fx-autoconfig loader to $app_dir..."
        if [ -w "$app_dir" ]; then
            cp "$program_source/config.js" "$app_dir/config.js"
            mkdir -p "$app_dir/defaults/pref"
            cp "$program_source/defaults/pref/config-prefs.js" "$app_dir/defaults/pref/config-prefs.js"
        else
            echo "Elevated privileges required to install loader to $app_dir"
            sudo cp "$program_source/config.js" "$app_dir/config.js"
            sudo mkdir -p "$app_dir/defaults/pref"
            sudo cp "$program_source/defaults/pref/config-prefs.js" "$app_dir/defaults/pref/config-prefs.js"
        fi
    else
        echo "Warning: Could not locate $BROWSER_NAME install directory."
        echo "Manually copy program/config.js and program/defaults/pref/config-prefs.js"
        echo "to your $BROWSER_NAME application directory for JavaScript support."
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

set_pref() {
    local key="$1" value="$2"
    local pref="user_pref(\"$key\", $value);"
    if [ ! -f "$user_js" ] || ! grep -q "$key" "$user_js"; then
        echo "Setting $key in user.js"
        echo "$pref" >> "$user_js"
    fi
}

set_pref "toolkit.legacyUserProfileCustomizations.stylesheets" "true"
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

echo "Done. Restart $BROWSER_NAME for changes to take effect."
