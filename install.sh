#!/usr/bin/env bash
set -euo pipefail

REPO="tompassarelli/fennec"
LATEST_URL="https://api.github.com/repos/$REPO/releases/latest"

tmp_dir=""
cleanup() { if [ -n "$tmp_dir" ]; then rm -rf "$tmp_dir"; fi; }
trap cleanup EXIT

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
if [ -d "$chrome_dir" ]; then
    backup_dir="$profile/chrome.bak.$(date +%Y-%m-%d-%H%M%S)"
    echo "Backing up existing chrome folder to $(basename "$backup_dir")"
    if ! cp -r "$chrome_dir" "$backup_dir"; then
        echo "Error: Failed to back up chrome folder."
        exit 1
    fi
fi

# Copy downloaded chrome folder
echo "Installing chrome folder..."
mkdir -p "$chrome_dir"
cp -r "$extracted"/* "$chrome_dir/"

# Enable custom stylesheets in user.js if not already set
user_js="$profile/user.js"
pref='user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);'
if [ ! -f "$user_js" ] || ! grep -q 'toolkit.legacyUserProfileCustomizations.stylesheets' "$user_js"; then
    echo "Enabling toolkit.legacyUserProfileCustomizations.stylesheets in user.js"
    echo "$pref" >> "$user_js"
fi

echo "Done. Restart Firefox for changes to take effect."
