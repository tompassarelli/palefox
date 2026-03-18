#!/usr/bin/env bash
set -euo pipefail

REPO="tompassarelli/fennec"
LATEST_URL="https://api.github.com/repos/$REPO/releases/latest"

FORCE=false
NO_BACKUP=false
for arg in "$@"; do
    case $arg in
        --force) FORCE=true ;;
        --no-backup) NO_BACKUP=true ;;
    esac
done

tmp_dir=""
cleanup() { if [ -n "$tmp_dir" ]; then rm -rf "$tmp_dir"; fi; }
trap cleanup EXIT

# Check if Firefox is running (skip in CI)
if [ -z "${FENNEC_LOCAL:-}" ]; then
    if pgrep -x firefox >/dev/null 2>&1; then
        echo "Firefox is currently running. Please close it before continuing."
        read -rp "Press Enter to continue after closing Firefox..."
    fi
fi

# Locate the Firefox profiles directory
case "$(uname -s)" in
    Darwin)
        profiles_dir="$HOME/Library/Application Support/Firefox/Profiles"
        ;;
    Linux)
        # Flatpak location takes priority if it exists
        flatpak_dir="$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"
        native_dir="$HOME/.mozilla/firefox"
        if [ -d "$flatpak_dir" ]; then
            profiles_dir="$flatpak_dir"
        elif [ -d "$native_dir" ]; then
            profiles_dir="$native_dir"
        else
            echo "Error: No Firefox profile directory found."
            exit 1
        fi
        ;;
    *)
        echo "Error: Unsupported OS."
        exit 1
        ;;
esac

# Find profile directories (*.default-release is the typical active profile)
profiles=()
while IFS= read -r dir; do
    profiles+=("$dir")
done < <(find "$profiles_dir" -maxdepth 1 -type d -name '*.default-release' 2>/dev/null)

if [ ${#profiles[@]} -eq 0 ]; then
    # Fall back to any profile directory
    while IFS= read -r dir; do
        profiles+=("$dir")
    done < <(find "$profiles_dir" -maxdepth 1 -type d -name '*.*' 2>/dev/null)
fi

if [ ${#profiles[@]} -eq 0 ]; then
    echo "Error: No Firefox profiles found in $profiles_dir"
    exit 1
fi

# Let user pick if multiple profiles exist
if [ ${#profiles[@]} -eq 1 ]; then
    profile="${profiles[0]}"
else
    echo "Multiple Firefox profiles found:"
    for i in "${!profiles[@]}"; do
        echo "  $((i + 1))) $(basename "${profiles[$i]}")"
    done
    read -rp "Select a profile [1-${#profiles[@]}]: " choice
    profile="${profiles[$((choice - 1))]}"
fi

echo "Using profile: $(basename "$profile")"

chrome_dir="$profile/chrome"

# Locate chrome source files
if [ -n "${FENNEC_LOCAL:-}" ]; then
    # Use local checkout instead of downloading
    extracted="$FENNEC_LOCAL/chrome"
    if [ ! -d "$extracted" ]; then
        echo "Error: chrome folder not found at $extracted"
        exit 1
    fi
else
    # Resolve latest release tag
    tmp_dir="$(mktemp -d)"
    echo "Fetching latest release..."
    tag="$(curl -fsSL "$LATEST_URL" | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//')" \
        || { echo "Error: Failed to fetch latest release. Check your internet connection."; exit 1; }

    if [ -z "$tag" ]; then
        echo "Error: Could not determine latest release tag."
        exit 1
    fi

    echo "Downloading Fennec $tag..."
    archive_url="https://github.com/$REPO/archive/refs/tags/$tag.tar.gz"
    if ! curl -fsSL "$archive_url" | tar -xz -C "$tmp_dir"; then
        echo "Error: Failed to download release archive. Check your internet connection."
        exit 1
    fi

    # The archive extracts to fennec-<tag> (with leading 'v' stripped by GitHub)
    extracted="$(ls -d "$tmp_dir"/fennec-*/chrome 2>/dev/null | head -1)"
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
    if grep -q '#region dev-docs' "$chrome_dir/userChrome.css" && grep -q -- '--fen-' "$chrome_dir/userChrome.css"; then
        cp "$chrome_dir/userChrome.css" "$chrome_dir/userChrome.css.legacy"
        rm "$chrome_dir/userChrome.css"
        LEGACY_MIGRATED=true
    fi
fi

# Install files
echo "Installing fennec..."
mkdir -p "$chrome_dir/fennec" "$chrome_dir/user"

# Core files — always overwrite
for file in fennec/fennec.css fennec/autohide.css; do
    if [ -f "$extracted/$file" ]; then
        cp "$extracted/$file" "$chrome_dir/$file"
    fi
done

# User files — preserve if present, create if missing
for file in userChrome.css user/user.css; do
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
    echo "Move any personal tweaks from that file into chrome/user/user.css"
fi

# Configure Firefox preferences in user.js
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

echo "Done. Restart Firefox for changes to take effect."
