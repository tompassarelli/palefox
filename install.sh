#!/usr/bin/env bash
set -euo pipefail

# ==========================================================================
# FENNEC INSTALLER — Modular Structure Support
# ==========================================================================
# Features:
# - Preserves userChrome.css and userOverrides.css on update
# - Always updates core files: fennec.css, autohide.css
# - Supports --force flag to overwrite everything
# - Works with native and Flatpak Firefox
# ==========================================================================

REPO="tompassarelli/fennec"
LATEST_URL="https://api.github.com/repos/$REPO/releases/latest"

# Parse arguments
FORCE=false
for arg in "$@"; do
    case $arg in
        --force)
            FORCE=true
            shift
            ;;
    esac
done

tmp_dir=""
cleanup() { if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then rm -rf "$tmp_dir"; fi; }
trap cleanup EXIT

# Check if Firefox is running (skip in CI or with env var)
if [ -z "${FENNEC_LOCAL:-}" ] && [ -z "${FENNEC_SKIP_FIREFOX_CHECK:-}" ]; then
    if pgrep -x firefox >/dev/null 2>&1 || pgrep -x "firefox-bin" >/dev/null 2>&1; then
        echo "⚠️  Firefox is currently running."
        echo "   Changes may not apply until Firefox is restarted."
        read -rp "   Press Enter to continue anyway, or Ctrl+C to cancel... "
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
            echo "🐧 Detected Flatpak Firefox"
        elif [ -d "$native_dir" ]; then
            profiles_dir="$native_dir"
        else
            echo "❌ Error: No Firefox profile directory found."
            echo "   Please install Firefox or create a profile first."
            exit 1
        fi
        ;;
    *)
        echo "❌ Error: Unsupported OS: $(uname -s)"
        exit 1
        ;;
esac

# Find profile directories (*.default-release is the typical active profile)
profiles=()
while IFS= read -r dir; do
    profiles+=("$dir")
done < <(find "$profiles_dir" -maxdepth 1 -type d -name '*.default-release' 2>/dev/null || true)

if [ ${#profiles[@]} -eq 0 ]; then
    # Fall back to any profile directory with a plausible name
    while IFS= read -r dir; do
        profiles+=("$dir")
    done < <(find "$profiles_dir" -maxdepth 1 -type d -name '*.*' 2>/dev/null || true)
fi

if [ ${#profiles[@]} -eq 0 ]; then
    echo "❌ Error: No Firefox profiles found in $profiles_dir"
    echo "   Please launch Firefox at least once to create a profile."
    exit 1
fi

# Let user pick if multiple profiles exist
if [ ${#profiles[@]} -eq 1 ]; then
    profile="${profiles[0]}"
else
    echo "📋 Multiple Firefox profiles found:"
    for i in "${!profiles[@]}"; do
        echo "   $((i + 1))) $(basename "${profiles[$i]}")"
    done
    echo ""
    read -rp "Select a profile [1-${#profiles[@]}]: " choice
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#profiles[@]}" ]; then
        echo "❌ Invalid selection."
        exit 1
    fi
    profile="${profiles[$((choice - 1))]}"
fi

echo "✅ Using profile: $(basename "$profile")"
chrome_dir="$profile/chrome"

# Locate chrome source files
if [ -n "${FENNEC_LOCAL:-}" ]; then
    # Use local checkout instead of downloading (for development)
    extracted="$FENNEC_LOCAL/chrome"
    if [ ! -d "$extracted" ]; then
        echo "❌ Error: chrome folder not found at $extracted"
        echo "   Set FENNEC_LOCAL to a valid Fennec repo checkout."
        exit 1
    fi
    echo "📦 Using local source: $extracted"
else
    # Download latest release from GitHub
    tmp_dir="$(mktemp -d)"
    echo "🔍 Fetching latest release..."

    tag="$(curl -fsSL "$LATEST_URL" 2>/dev/null | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//' | head -1)" \
        || { echo "❌ Error: Failed to fetch latest release. Check your internet connection."; exit 1; }

    if [ -z "$tag" ]; then
        echo "❌ Error: Could not determine latest release tag."
        exit 1
    fi

    echo "⬇️  Downloading Fennec $tag..."
    archive_url="https://github.com/$REPO/archive/refs/tags/$tag.tar.gz"

    if ! curl -fsSL "$archive_url" 2>/dev/null | tar -xz -C "$tmp_dir"; then
        echo "❌ Error: Failed to download release archive."
        echo "   Check your internet connection or try: curl -I $archive_url"
        exit 1
    fi

    # The archive extracts to fennec-<tag> (with leading 'v' stripped by GitHub)
    extracted="$(find "$tmp_dir" -type d -name 'chrome' | head -1)"
    if [ -z "$extracted" ] || [ ! -d "$extracted" ]; then
        echo "❌ Error: chrome folder not found in downloaded archive."
        exit 1
    fi
fi

# Create chrome directory if it doesn't exist
mkdir -p "$chrome_dir"

# Backup existing chrome folder (only on first install or if --force)
if [ -d "$chrome_dir" ] && [ "$(ls -A "$chrome_dir" 2>/dev/null)" ] && [ "$FORCE" = true ]; then
    backup_dir="$profile/chrome.bak.$(date +%Y-%m-%d-%H%M%S)"
    echo "💾 Backing up existing chrome folder to $(basename "$backup_dir")"
    if ! cp -r "$chrome_dir" "$backup_dir" 2>/dev/null; then
        echo "⚠️  Warning: Failed to back up chrome folder (continuing anyway)"
    fi
fi

# Copy files with preservation logic
echo "📦 Installing Fennec files..."

# Core files (always copy/overwrite)
for file in fennec.css autohide.css; do
    if [ -f "$extracted/$file" ]; then
        cp "$extracted/$file" "$chrome_dir/$file"
        echo "   ✅ Updated: $file"
    fi
done

# User-configurable files (only copy if they don't exist)
for file in userChrome.css userOverrides.css; do
    if [ -f "$extracted/$file" ]; then
        if [ ! -f "$chrome_dir/$file" ] || [ "$FORCE" = true ]; then
            cp "$extracted/$file" "$chrome_dir/$file"
            if [ "$FORCE" = true ]; then
                echo "   ✅ Overwritten: $file (--force)"
            else
                echo "   ✅ Created: $file"
            fi
        else
            echo "   🔒 Preserved: $file (your customizations)"
        fi
    fi
done

# Copy any additional files (e.g., img/, docs) if present
for item in "$extracted"/*; do
    item_name="$(basename "$item")"
    # Skip files we already handled
    if [[ "$item_name" =~ \.css$ ]] || [ -d "$item" ]; then
        if [ -d "$item" ] && [ "$item_name" != "chrome" ]; then
            # Copy directories like img/
            cp -r "$item" "$chrome_dir/" 2>/dev/null || true
            echo "   📁 Copied: $item_name/"
        fi
    fi
done

# Configure Firefox preferences in user.js
user_js="$profile/user.js"

set_pref() {
    local key="$1" value="$2"
    local pref="user_pref(\"$key\", $value);"
    if [ ! -f "$user_js" ] || ! grep -q "\"$key\"" "$user_js" 2>/dev/null; then
        echo "   ⚙️  Setting: $key"
        echo "$pref" >> "$user_js"
    fi
}

echo "⚙️  Configuring Firefox preferences..."
set_pref "toolkit.legacyUserProfileCustomizations.stylesheets" "true"
set_pref "sidebar.verticalTabs" "false"
set_pref "sidebar.revamp" "false"

# Final summary
echo ""
echo "🎉 Fennec installed successfully!"
echo ""
echo "📁 Files in your chrome folder:"
ls -1 "$chrome_dir" 2>/dev/null | sed 's/^/   • /' || true
echo ""
echo "⚡ Next steps:"
echo "   1. Restart Firefox completely"
echo "   2. If sidebar is invisible: press Ctrl+H, then activate Sideberry"
echo "   3. Edit chrome/userChrome.css to enable optional modules"
echo "   4. Put your custom CSS in chrome/userOverrides.css"
echo ""
if [ "$FORCE" = true ]; then
    echo "⚠️  You used --force: all files were overwritten."
    echo "   Your previous customizations may be lost."
    echo "   Check chrome.bak.* for backups."
    echo ""
fi
echo "🔗 Docs: https://github.com/$REPO"
echo "🐛 Issues: https://github.com/$REPO/issues"
