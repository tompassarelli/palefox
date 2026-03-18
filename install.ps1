#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# ==========================================================================
# FENNEC INSTALLER — Modular Structure Support (Windows PowerShell)
# ==========================================================================
# Features:
# - Preserves userChrome.css and user-overrides.css on update
# - Always updates core files: fennec.css, autohide.css
# - Supports -Force flag to overwrite everything
# - Works with native Firefox on Windows
# ==========================================================================

$repo = "tompassarelli/fennec"
$latestUrl = "https://api.github.com/repos/$repo/releases/latest"

# Parse arguments
$force = $false
if ($args -contains "--force" -or $args -contains "-Force") {
    $force = $true
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "fennec-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

function Write-Info    { param([string]$msg) Write-Host "✅ $msg" }
function Write-Warn    { param([string]$msg) Write-Host "⚠️  $msg" -ForegroundColor Yellow }
function Write-Error   { param([string]$msg) Write-Host "❌ $msg" -ForegroundColor Red }
function Write-Step    { param([string]$msg) Write-Host "📦 $msg" -ForegroundColor Cyan }

try {
    # Check if Firefox is running (skip in CI)
    if (-not $env:FENNEC_LOCAL) {
        $firefox = Get-Process firefox -ErrorAction SilentlyContinue
        if ($firefox) {
            Write-Warn "Firefox is currently running."
            Write-Host "   Changes may not apply until Firefox is restarted."
            Read-Host "   Press Enter to continue anyway, or Ctrl+C to cancel"
        }
    }

    # Locate Firefox profiles directory
    $profilesDir = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    if (-not (Test-Path $profilesDir)) {
        Write-Error "No Firefox profile directory found at $profilesDir"
        Write-Host "   Please install Firefox or create a profile first."
        exit 1
    }

    # Find profile directories (*.default-release is typical active profile)
    $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter "*.default-release" -ErrorAction SilentlyContinue
    if (-not $profiles) {
        # Fall back to any profile with plausible name
        $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter "*.*" -ErrorAction SilentlyContinue
    }
    if (-not $profiles) {
        Write-Error "No Firefox profiles found in $profilesDir"
        Write-Host "   Please launch Firefox at least once to create a profile."
        exit 1
    }

    # Let user pick if multiple profiles exist
    if ($profiles.Count -eq 1) {
        $profile = $profiles[0]
    } else {
        Write-Host "📋 Multiple Firefox profiles found:"
        for ($i = 0; $i -lt $profiles.Count; $i++) {
            Write-Host "   $($i + 1)) $($profiles[$i].Name)"
        }
        Write-Host ""
        $choice = Read-Host "Select a profile [1-$($profiles.Count)]"
        if ($choice -notmatch '^\d+$' -or [int]$choice -lt 1 -or [int]$choice -gt $profiles.Count) {
            Write-Error "Invalid selection."
            exit 1
        }
        $profile = $profiles[[int]$choice - 1]
    }

    Write-Info "Using profile: $($profile.Name)"
    $chromeDir = Join-Path $profile.FullName "chrome"

    # Locate chrome source files
    if ($env:FENNEC_LOCAL) {
        # Use local checkout instead of downloading (for development)
        $chromeSource = Join-Path $env:FENNEC_LOCAL "chrome"
        if (-not (Test-Path $chromeSource)) {
            Write-Error "chrome folder not found at $chromeSource"
            Write-Host "   Set `$env:FENNEC_LOCAL to a valid Fennec repo checkout."
            exit 1
        }
        Write-Step "Using local source: $chromeSource"
    } else {
        # Download latest release from GitHub
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        Write-Step "Fetching latest release..."

        try {
            $release = Invoke-RestMethod -Uri $latestUrl -TimeoutSec 30
            $tag = $release.tag_name
        } catch {
            Write-Error "Failed to fetch latest release. Check your internet connection."
            Write-Host "   Error: $($_.Exception.Message)"
            exit 1
        }

        if (-not $tag) {
            Write-Error "Could not determine latest release tag."
            exit 1
        }

        Write-Step "Downloading Fennec $tag..."
        $archiveUrl = "https://github.com/$repo/archive/refs/tags/$tag.zip"
        $zipPath = Join-Path $tmpDir "fennec.zip"

        try {
            Invoke-WebRequest -Uri $archiveUrl -OutFile $zipPath -TimeoutSec 60 -UseBasicParsing
        } catch {
            Write-Error "Failed to download release archive."
            Write-Host "   Error: $($_.Exception.Message)"
            Write-Host "   Try: Invoke-WebRequest -Uri '$archiveUrl' -UseBasicParsing"
            exit 1
        }

        Write-Step "Extracting archive..."
        Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

        $extracted = Get-ChildItem -Path $tmpDir -Directory -Filter "fennec-*" | Select-Object -First 1
        if (-not $extracted) {
            Write-Error "Could not find extracted fennec folder."
            exit 1
        }

        $chromeSource = Join-Path $extracted.FullName "chrome"
        if (-not (Test-Path $chromeSource)) {
            Write-Error "chrome folder not found in downloaded archive."
            exit 1
        }
    }

    # Create chrome directory if it doesn't exist
    if (-not (Test-Path $chromeDir)) {
        New-Item -ItemType Directory -Path $chromeDir -Force | Out-Null
    }

    # Backup existing chrome folder (only if --force and has content)
    if ((Test-Path $chromeDir) -and (Get-ChildItem $chromeDir -ErrorAction SilentlyContinue) -and $force) {
        $timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
        $backupDir = Join-Path $profile.FullName "chrome.bak.$timestamp"
        Write-Info "Backing up existing chrome folder to chrome.bak.$timestamp"
        try {
            Copy-Item -Path $chromeDir -Destination $backupDir -Recurse -Force
        } catch {
            Write-Warn "Failed to back up chrome folder (continuing anyway)"
        }
    }

    # Copy files with preservation logic
    Write-Step "Installing Fennec files..."

    # Core files (always copy/overwrite)
    $coreFiles = @("fennec.css", "autohide.css")
    foreach ($file in $coreFiles) {
        $source = Join-Path $chromeSource $file
        $dest = Join-Path $chromeDir $file
        if (Test-Path $source) {
            Copy-Item -Path $source -Destination $dest -Force
            Write-Host "   ✅ Updated: $file" -ForegroundColor Green
        }
    }

    # User-configurable files (only copy if they don't exist, or if --force)
    $userFiles = @("userChrome.css", "user-overrides.css")
    foreach ($file in $userFiles) {
        $source = Join-Path $chromeSource $file
        $dest = Join-Path $chromeDir $file
        if (Test-Path $source) {
            if (-not (Test-Path $dest) -or $force) {
                Copy-Item -Path $source -Destination $dest -Force
                if ($force) {
                    Write-Host "   ✅ Overwritten: $file (--force)" -ForegroundColor Green
                } else {
                    Write-Host "   ✅ Created: $file" -ForegroundColor Green
                }
            } else {
                Write-Host "   🔒 Preserved: $file (your customizations)" -ForegroundColor Yellow
            }
        }
    }

    # Copy any additional directories (e.g., img/) if present
    $extraDirs = Get-ChildItem -Path $chromeSource -Directory -ErrorAction SilentlyContinue
    foreach ($dir in $extraDirs) {
        $dest = Join-Path $chromeDir $dir.Name
        Copy-Item -Path $dir.FullName -Destination $dest -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "   📁 Copied: $($dir.Name)/" -ForegroundColor Cyan
    }

    # Configure Firefox preferences in user.js
    $userJs = Join-Path $profile.FullName "user.js"

    function Set-FirefoxPref {
        param([string]$Key, [string]$Value)
        $line = "user_pref(`"$Key`", $Value);"
        $needsPref = $true

        if (Test-Path $userJs) {
            $content = Get-Content $userJs -Raw -ErrorAction SilentlyContinue
            if ($content -and $content -match [regex]::Escape($Key)) {
                $needsPref = $false
            }
        }

        if ($needsPref) {
            Write-Host "   ⚙️  Setting: $Key" -ForegroundColor Magenta
            Add-Content -Path $userJs -Value $line
        }
    }

    Write-Step "Configuring Firefox preferences..."
    Set-FirefoxPref "toolkit.legacyUserProfileCustomizations.stylesheets" "true"
    Set-FirefoxPref "sidebar.verticalTabs" "false"
    Set-FirefoxPref "sidebar.revamp" "false"

    # Final summary
    Write-Host ""
    Write-Host "🎉 Fennec installed successfully!" -ForegroundColor Green
    Write-Host ""

    Write-Host "📁 Files in your chrome folder:" -ForegroundColor Cyan
    if (Test-Path $chromeDir) {
        Get-ChildItem -Path $chromeDir -Name | ForEach-Object { Write-Host "   • $_" }
    }

    Write-Host ""
    Write-Host "⚡ Next steps:" -ForegroundColor Cyan
    Write-Host "   1. Restart Firefox completely"
    Write-Host "   2. If sidebar is invisible: press Ctrl+H, then activate Sideberry"
    Write-Host "   3. Edit chrome\userChrome.css to enable optional modules"
    Write-Host "   4. Put your custom CSS in chrome\user-overrides.css"
    Write-Host ""

    if ($force) {
        Write-Warn "You used --force: all files were overwritten."
        Write-Host "   Your previous customizations may be lost."
        Write-Host "   Check chrome.bak.* for backups."
        Write-Host ""
    }

    Write-Host "🔗 Docs: https://github.com/$repo"
    Write-Host "🐛 Issues: https://github.com/$repo/issues"

} catch {
    Write-Error "Installation failed: $($_.Exception.Message)"
    if ($_.ScriptStackTrace) {
        Write-Host "   at $($_.ScriptStackTrace)" -ForegroundColor DarkGray
    }
    exit 1
} finally {
    # Clean up temp directory
    if (Test-Path $tmpDir) {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
