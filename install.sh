#!/usr/bin/env bash
set -euo pipefail

REPO="tompassarelli/palefox"
BRANCH="stable-pure-css"

FORCE=false
NO_BACKUP=false
USE_LIBREWOLF=false
for arg in "$@"; do
    case $arg in
        --force) FORCE=true ;;
        --no-backup) NO_BACKUP=true ;;
        --librewolf) USE_LIBREWOLF=true ;;
    esac
done

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
            flatpak_dir="$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"
            xdg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox"
            native_dir="$HOME/.mozilla/firefox"
        fi
        if [ -d "$flatpak_dir" ]; then
            profiles_dir="$flatpak_dir"
        elif [ -n "${xdg_dir:-}" ] && [ -d "$xdg_dir" ]; then
            profiles_dir="$xdg_dir"
        elif [ -d "$native_dir" ]; then
            profiles_dir="$native_dir"
        else
            echo "Error: No $BROWSER_NAME profile directory found."
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
    echo "Error: No $BROWSER_NAME profiles found in $profiles_dir"
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
    # Download stable branch
    tmp_dir="$(mktemp -d)"
    echo "Downloading Palefox ($BRANCH)..."
    archive_url="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    if ! curl -fsSL "$archive_url" | tar -xz -C "$tmp_dir"; then
        echo "Error: Failed to download archive. Check your internet connection."
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

# Core files — always overwrite
for file in palefox.css; do
    if [ -f "$extracted/$file" ]; then
        cp "$extracted/$file" "$chrome_dir/$file"
    fi
done

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
set_pref "sidebar.verticalTabs" "false"
set_pref "sidebar.revamp" "false"
set_pref "sidebar.position_start" "true"
set_pref "pfx.drawer.autohide" "false"
set_pref "pfx.urlbar.float" "false"

# GTK may send spurious leave events that break autohide
if [ "$(uname -s)" = "Linux" ]; then
    set_pref "widget.gtk.ignore-bogus-leave-notify" 1
fi

echo "Done. Restart $BROWSER_NAME for changes to take effect."
