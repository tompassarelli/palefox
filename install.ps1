#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$repo = "tompassarelli/fennec"
$latestUrl = "https://api.github.com/repos/$repo/releases/latest"

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "fennec-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

try {
    # Locate Firefox profiles directory
    $profilesDir = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    if (-not (Test-Path $profilesDir)) {
        Write-Error "No Firefox profile directory found at $profilesDir"
        exit 1
    }

    # Find profile directories
    $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter "*.default-release" 2>$null
    if (-not $profiles) {
        $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter "*.*" 2>$null
    }
    if (-not $profiles) {
        Write-Error "No Firefox profiles found in $profilesDir"
        exit 1
    }

    # Let user pick if multiple profiles exist
    if ($profiles.Count -eq 1) {
        $profile = $profiles[0]
    } else {
        Write-Host "Multiple Firefox profiles found:"
        for ($i = 0; $i -lt $profiles.Count; $i++) {
            Write-Host "  $($i + 1)) $($profiles[$i].Name)"
        }
        $choice = Read-Host "Select a profile [1-$($profiles.Count)]"
        $profile = $profiles[[int]$choice - 1]
    }

    Write-Host "Using profile: $($profile.Name)"

    $chromeDir = Join-Path $profile.FullName "chrome"

    # Locate chrome source files
    if ($env:FENNEC_LOCAL) {
        # Use local checkout instead of downloading
        $chromeSource = Join-Path $env:FENNEC_LOCAL "chrome"
        if (-not (Test-Path $chromeSource)) {
            Write-Error "chrome folder not found at $chromeSource"
            exit 1
        }
    } else {
        # Resolve latest release tag
        New-Item -ItemType Directory -Path $tmpDir | Out-Null
        Write-Host "Fetching latest release..."
        try {
            $release = Invoke-RestMethod -Uri $latestUrl
            $tag = $release.tag_name
        } catch {
            Write-Error "Failed to fetch latest release. Check your internet connection."
            exit 1
        }

        if (-not $tag) {
            Write-Error "Could not determine latest release tag."
            exit 1
        }

        Write-Host "Downloading Fennec $tag..."
        $archiveUrl = "https://github.com/$repo/archive/refs/tags/$tag.zip"
        $zipPath = Join-Path $tmpDir "fennec.zip"
        try {
            Invoke-RestMethod -Uri $archiveUrl -OutFile $zipPath
        } catch {
            Write-Error "Failed to download release archive. Check your internet connection."
            exit 1
        }

        Expand-Archive -Path $zipPath -DestinationPath $tmpDir
        $extracted = Get-ChildItem -Path $tmpDir -Directory -Filter "fennec-*" | Select-Object -First 1
        $chromeSource = Join-Path $extracted.FullName "chrome"
        if (-not (Test-Path $chromeSource)) {
            Write-Error "chrome folder not found in downloaded archive."
            exit 1
        }
    }

    # Backup existing chrome folder
    if (Test-Path $chromeDir) {
        $timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
        $backupDir = Join-Path $profile.FullName "chrome.bak.$timestamp"
        Write-Host "Backing up existing chrome folder to chrome.bak.$timestamp"
        try {
            Copy-Item -Path $chromeDir -Destination $backupDir -Recurse
        } catch {
            Write-Error "Failed to back up chrome folder."
            exit 1
        }
    }

    # Copy downloaded files into chrome folder
    Write-Host "Installing chrome folder..."
    if (-not (Test-Path $chromeDir)) {
        New-Item -ItemType Directory -Path $chromeDir | Out-Null
    }
    Copy-Item -Path (Join-Path $chromeSource "*") -Destination $chromeDir -Recurse -Force

    # Enable custom stylesheets in user.js if not already set
    $userJs = Join-Path $profile.FullName "user.js"
    $pref = 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);'
    $needsPref = $true
    if (Test-Path $userJs) {
        $content = Get-Content $userJs -Raw
        if ($content -match "toolkit.legacyUserProfileCustomizations.stylesheets") {
            $needsPref = $false
        }
    }
    if ($needsPref) {
        Write-Host "Enabling toolkit.legacyUserProfileCustomizations.stylesheets in user.js"
        Add-Content -Path $userJs -Value $pref
    }

    Write-Host "Done. Restart Firefox for changes to take effect."
} finally {
    # Clean up temp directory
    if (Test-Path $tmpDir) {
        Remove-Item -Path $tmpDir -Recurse -Force
    }
}
