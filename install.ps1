#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$repo = "tompassarelli/fennec"
$latestUrl = "https://api.github.com/repos/$repo/releases/latest"

$force = $args -contains "--force" -or $args -contains "-Force"
$noBackup = $args -contains "--no-backup"
$useLibrewolf = $args -contains "--librewolf"

# Browser selection
if ($useLibrewolf) {
    $browserName = "LibreWolf"
    $browserProcess = "librewolf"
    $profilePattern = "*.default-default"
} elseif (-not $env:FENNEC_LOCAL -and [Environment]::UserInteractive) {
    Write-Host "Select browser:"
    Write-Host "  1) Firefox (default)"
    Write-Host "  2) LibreWolf"
    $browserChoice = Read-Host "Choice [1]"
    if ($browserChoice -eq "2") {
        $browserName = "LibreWolf"
        $browserProcess = "librewolf"
        $profilePattern = "*.default-default"
    } else {
        $browserName = "Firefox"
        $browserProcess = "firefox"
        $profilePattern = "*.default-release"
    }
} else {
    $browserName = "Firefox"
    $browserProcess = "firefox"
    $profilePattern = "*.default-release"
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "fennec-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

try {
    # Check if browser is running (skip in CI)
    if (-not $env:FENNEC_LOCAL) {
        if (Get-Process $browserProcess -ErrorAction SilentlyContinue) {
            Write-Host "$browserName is currently running. Please close it before continuing."
            Read-Host "Press Enter to continue after closing $browserName"
        }
    }

    # Locate profiles directory
    if ($browserName -eq "LibreWolf") {
        $profilesDir = Join-Path $env:APPDATA "librewolf\Profiles"
    } else {
        $profilesDir = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    }
    if (-not (Test-Path $profilesDir)) {
        Write-Error "No $browserName profile directory found at $profilesDir"
        exit 1
    }

    # Find profile directories
    $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter $profilePattern 2>$null
    if (-not $profiles) {
        $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter "*.*" 2>$null
    }
    if (-not $profiles) {
        Write-Error "No $browserName profiles found in $profilesDir"
        exit 1
    }

    # Let user pick if multiple profiles exist
    if ($profiles.Count -eq 1) {
        $profile = $profiles[0]
    } else {
        Write-Host "Multiple $browserName profiles found:"
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
    if ((Test-Path $chromeDir) -and -not $noBackup) {
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

    # Legacy migration gate: detect old monolithic userChrome.css
    # Positive detection — these markers only exist in the old inline format
    $legacyMigrated = $false
    $userChromeFile = Join-Path $chromeDir "userChrome.css"
    if (Test-Path $userChromeFile) {
        $content = Get-Content $userChromeFile -Raw
        if ($content -match '#region dev-docs' -and $content -match '--fen-') {
            Copy-Item -Path $userChromeFile -Destination (Join-Path $chromeDir "userChrome.css.legacy")
            Remove-Item -Path $userChromeFile
            $legacyMigrated = $true
        }
    }

    # Install files
    Write-Host "Installing fennec..."
    $fennecDir = Join-Path $chromeDir "fennec"
    $userDir = Join-Path $chromeDir "user"
    if (-not (Test-Path $chromeDir)) {
        New-Item -ItemType Directory -Path $chromeDir | Out-Null
    }
    if (-not (Test-Path $fennecDir)) {
        New-Item -ItemType Directory -Path $fennecDir | Out-Null
    }
    if (-not (Test-Path $userDir)) {
        New-Item -ItemType Directory -Path $userDir | Out-Null
    }

    # Core files — always overwrite
    foreach ($file in @("fennec\fennec.css")) {
        $source = Join-Path $chromeSource $file
        $dest = Join-Path $chromeDir $file
        if (Test-Path $source) {
            Copy-Item -Path $source -Destination $dest -Force
        }
    }

    # User files — preserve if present, create if missing
    foreach ($file in @("userChrome.css", "user\user.css")) {
        $source = Join-Path $chromeSource $file
        $dest = Join-Path $chromeDir $file
        if (Test-Path $source) {
            if (-not (Test-Path $dest) -or $force) {
                Copy-Item -Path $source -Destination $dest -Force
            } else {
                Write-Host "Preserved: $file"
            }
        }
    }

    # Print legacy migration notice
    if ($legacyMigrated) {
        Write-Host ""
        Write-Host "Note: Your previous userChrome.css used the legacy monolithic layout."
        Write-Host "It has been backed up to: chrome\userChrome.css.legacy"
        Write-Host "Move any personal tweaks from that file into chrome\user\user.css"
    }

    # Configure browser preferences in user.js
    $userJs = Join-Path $profile.FullName "user.js"

    function Set-BrowserPref {
        param([string]$Key, [string]$Value)
        $line = "user_pref(`"$Key`", $Value);"
        $needsPref = $true
        if (Test-Path $userJs) {
            $content = Get-Content $userJs -Raw
            if ($content -match [regex]::Escape($Key)) {
                $needsPref = $false
            }
        }
        if ($needsPref) {
            Write-Host "Setting $Key in user.js"
            Add-Content -Path $userJs -Value $line
        }
    }

    Set-BrowserPref "toolkit.legacyUserProfileCustomizations.stylesheets" "true"
    Set-BrowserPref "sidebar.verticalTabs" "false"
    Set-BrowserPref "sidebar.revamp" "false"
    Set-BrowserPref "sidebar.position_start" "true"
    Set-BrowserPref "fennec.autohide" "false"
    Set-BrowserPref "fennec.urlbar.float" "false"

    Write-Host "Done. Restart $browserName for changes to take effect."
} finally {
    # Clean up temp directory
    if (Test-Path $tmpDir) {
        Remove-Item -Path $tmpDir -Recurse -Force
    }
}
