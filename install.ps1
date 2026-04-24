#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$repo = "tompassarelli/palefox"

# --- Argument parsing ---
$force = $false
$noBackup = $false
$useLibrewolf = $false
$ref = ""
$refType = ""

function Print-Usage {
    Write-Host "Usage: install.ps1 [options]"
    Write-Host ""
    Write-Host "Version targeting (default: latest release):"
    Write-Host "  --branch NAME      Install from a branch (e.g. main, css-legacy)"
    Write-Host "  --tag NAME         Install from a tag (e.g. v0.36.4)"
    Write-Host "  --commit SHA       Install from a specific commit"
    Write-Host "  --latest-commit    Install from the latest commit on main"
    Write-Host "  --release VERSION  Install a specific release (e.g. v0.36.4)"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  --librewolf        Target LibreWolf instead of Firefox"
    Write-Host "  --force            Overwrite user-customized files"
    Write-Host "  --no-backup        Skip backing up existing chrome folder"
    Write-Host "  --help             Show this help"
}

$i = 0
while ($i -lt $args.Count) {
    switch ($args[$i]) {
        "--force" { $force = $true }
        "--no-backup" { $noBackup = $true }
        "--librewolf" { $useLibrewolf = $true }
        "--branch" {
            $i++
            if ($i -ge $args.Count) { Write-Error "--branch requires a name"; exit 1 }
            $refType = "branch"; $ref = $args[$i]
        }
        "--tag" {
            $i++
            if ($i -ge $args.Count) { Write-Error "--tag requires a name"; exit 1 }
            $refType = "tag"; $ref = $args[$i]
        }
        "--commit" {
            $i++
            if ($i -ge $args.Count) { Write-Error "--commit requires a SHA"; exit 1 }
            $refType = "commit"; $ref = $args[$i]
        }
        "--latest-commit" { $refType = "branch"; $ref = "main" }
        "--release" {
            $i++
            if ($i -ge $args.Count) { Write-Error "--release requires a version"; exit 1 }
            $refType = "tag"; $ref = $args[$i]
        }
        "--help" { Print-Usage; exit 0 }
        default { Write-Error "Unknown option: $($args[$i])"; Print-Usage; exit 1 }
    }
    $i++
}

# Default: latest release
if (-not $refType -and -not $env:PALEFOX_LOCAL) {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
        $ref = $release.tag_name
        $refType = "tag"
    } catch {
        Write-Host "Warning: could not fetch latest release tag, falling back to main"
        $ref = "main"
        $refType = "branch"
    }
}

# Build archive URL
switch ($refType) {
    "branch" { $archiveUrl = "https://github.com/$repo/archive/refs/heads/$ref.zip" }
    "tag"    { $archiveUrl = "https://github.com/$repo/archive/refs/tags/$ref.zip" }
    "commit" { $archiveUrl = "https://github.com/$repo/archive/$ref.zip" }
}

# Browser selection
if ($useLibrewolf) {
    $browserName = "LibreWolf"
    $browserProcess = "librewolf"
    $profilePattern = "*.default-default"
} elseif (-not $env:PALEFOX_LOCAL -and [Environment]::UserInteractive) {
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

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "palefox-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

try {
    # Check if browser is running (skip in CI)
    if (-not $env:PALEFOX_LOCAL) {
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
        Write-Error "No $browserName profile directory found at $profilesDir. Make sure you've launched $browserName at least once."
        exit 1
    }

    # Find profile directories
    $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter $profilePattern 2>$null
    if (-not $profiles) {
        $profiles = Get-ChildItem -Path $profilesDir -Directory -Filter "*.*" 2>$null
    }
    if (-not $profiles) {
        Write-Error "No $browserName profiles found in $profilesDir. Make sure you've launched $browserName at least once."
        exit 1
    }

    # Let user pick if multiple profiles exist
    if ($profiles.Count -eq 1) {
        $profile = $profiles[0]
    } else {
        Write-Host "Multiple $browserName profiles found:"
        for ($idx = 0; $idx -lt $profiles.Count; $idx++) {
            Write-Host "  $($idx + 1)) $($profiles[$idx].Name)"
        }
        $choice = Read-Host "Select a profile [1-$($profiles.Count)]"
        $profile = $profiles[[int]$choice - 1]
    }

    Write-Host "Using profile: $($profile.Name)"

    $chromeDir = Join-Path $profile.FullName "chrome"

    # Locate chrome source files
    if ($env:PALEFOX_LOCAL) {
        $chromeSource = Join-Path $env:PALEFOX_LOCAL "chrome"
        if (-not (Test-Path $chromeSource)) {
            Write-Error "chrome folder not found at $chromeSource"
            exit 1
        }
    } else {
        New-Item -ItemType Directory -Path $tmpDir | Out-Null
        Write-Host "Downloading Palefox ($ref)..."
        $zipPath = Join-Path $tmpDir "palefox.zip"
        try {
            Invoke-RestMethod -Uri $archiveUrl -OutFile $zipPath
        } catch {
            Write-Error "Failed to download archive for ref '$ref'. Check that it exists."
            exit 1
        }

        Expand-Archive -Path $zipPath -DestinationPath $tmpDir
        $extracted = Get-ChildItem -Path $tmpDir -Directory -Filter "palefox-*" | Select-Object -First 1
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
    $legacyMigrated = $false
    $userChromeFile = Join-Path $chromeDir "userChrome.css"
    if (Test-Path $userChromeFile) {
        $content = Get-Content $userChromeFile -Raw
        if ($content -match '#region dev-docs' -and $content -match '--pfx-') {
            Copy-Item -Path $userChromeFile -Destination (Join-Path $chromeDir "userChrome.css.legacy")
            Remove-Item -Path $userChromeFile
            $legacyMigrated = $true
        }
    }

    # Install files
    Write-Host "Installing palefox..."
    if (-not (Test-Path $chromeDir)) {
        New-Item -ItemType Directory -Path $chromeDir | Out-Null
    }
    $utilsDir = Join-Path $chromeDir "utils"
    if (-not (Test-Path $utilsDir)) {
        New-Item -ItemType Directory -Path $utilsDir | Out-Null
    }
    $jsDir = Join-Path $chromeDir "JS"
    if (-not (Test-Path $jsDir)) {
        New-Item -ItemType Directory -Path $jsDir | Out-Null
    }

    # Core files — always overwrite
    foreach ($file in @("palefox.css", "palefox-tabs.css")) {
        $source = Join-Path $chromeSource $file
        $dest = Join-Path $chromeDir $file
        if (Test-Path $source) {
            Copy-Item -Path $source -Destination $dest -Force
        }
    }

    # fx-autoconfig loader — always overwrite
    $utilsSource = Join-Path $chromeSource "utils"
    if (Test-Path $utilsSource) {
        Copy-Item -Path (Join-Path $utilsSource "*") -Destination $utilsDir -Force
    }

    # JS scripts — always overwrite (managed by palefox)
    $jsSource = Join-Path $chromeSource "JS"
    if (Test-Path $jsSource) {
        foreach ($file in (Get-ChildItem -Path $jsSource -File)) {
            Copy-Item -Path $file.FullName -Destination (Join-Path $jsDir $file.Name) -Force
        }
    }

    # User files — preserve if present, create if missing
    foreach ($file in @("userChrome.css", "user.css")) {
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

    # Install fx-autoconfig to Firefox application directory
    if ($env:PALEFOX_LOCAL) {
        $programSource = Join-Path $env:PALEFOX_LOCAL "program"
    } else {
        $programSource = Join-Path (Split-Path $chromeSource) "program"
    }

    if (Test-Path $programSource) {
        if ($browserName -eq "LibreWolf") {
            $appDir = (Get-ItemProperty "HKLM:\SOFTWARE\LibreWolf" -ErrorAction SilentlyContinue).InstallDirectory
            if (-not $appDir) {
                $appDir = "${env:ProgramFiles}\LibreWolf"
            }
        } else {
            $appDir = (Get-ItemProperty "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox" -ErrorAction SilentlyContinue).InstallDirectory
            if (-not $appDir) {
                $appDir = "${env:ProgramFiles}\Mozilla Firefox"
            }
        }

        if (Test-Path $appDir) {
            Write-Host "Installing fx-autoconfig loader to $appDir..."
            try {
                Copy-Item -Path (Join-Path $programSource "config.js") -Destination (Join-Path $appDir "config.js") -Force
                $prefDir = Join-Path $appDir "defaults\pref"
                if (-not (Test-Path $prefDir)) {
                    New-Item -ItemType Directory -Path $prefDir | Out-Null
                }
                Copy-Item -Path (Join-Path $programSource "defaults\pref\config-prefs.js") -Destination (Join-Path $prefDir "config-prefs.js") -Force
            } catch {
                Write-Host "Elevated privileges may be required. Retrying..."
                Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
                    "-Command",
                    "Copy-Item '$(Join-Path $programSource "config.js")' '$(Join-Path $appDir "config.js")' -Force; " +
                    "New-Item -ItemType Directory -Path '$(Join-Path $appDir "defaults\pref")' -Force | Out-Null; " +
                    "Copy-Item '$(Join-Path $programSource "defaults\pref\config-prefs.js")' '$(Join-Path $appDir "defaults\pref\config-prefs.js")' -Force"
                )
            }
        } else {
            Write-Host "Warning: Could not locate $browserName install directory at $appDir"
            Write-Host "Manually copy program\config.js and program\defaults\pref\config-prefs.js"
            Write-Host "to your $browserName application directory for JavaScript support."
        }
    }

    # Print legacy migration notice
    if ($legacyMigrated) {
        Write-Host ""
        Write-Host "Note: Your previous userChrome.css used the legacy monolithic layout."
        Write-Host "It has been backed up to: chrome\userChrome.css.legacy"
        Write-Host "Move any personal tweaks from that file into chrome\user.css"
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
    Set-BrowserPref "sidebar.verticalTabs" "true"
    Set-BrowserPref "sidebar.revamp" "true"
    Set-BrowserPref "sidebar.position_start" "true"
    Set-BrowserPref "browser.toolbars.bookmarks.visibility" "`"never`""
    Set-BrowserPref "pfx.sidebar.width" "300"

    # Default toolbar layout
    Set-BrowserPref "browser.uiCustomization.state" "'{`"placements`":{`"widget-overflow-fixed-list`":[`"fxa-toolbar-menu-button`",`"home-button`",`"alltabs-button`",`"firefox-view-button`"],`"unified-extensions-area`":[],`"nav-bar`":[`"sidebar-button`",`"back-button`",`"forward-button`",`"stop-reload-button`",`"customizableui-special-spring1`",`"vertical-spacer`",`"urlbar-container`",`"customizableui-special-spring2`",`"downloads-button`",`"unified-extensions-button`"],`"toolbar-menubar`":[`"menubar-items`"],`"TabsToolbar`":[`"tabbrowser-tabs`",`"new-tab-button`"],`"vertical-tabs`":[],`"PersonalToolbar`":[`"import-button`",`"personal-bookmarks`"]},`"seen`":[],`"dirtyAreaCache`":[],`"currentVersion`":23,`"newElementCount`":0}'"

    Write-Host "Done. Restart $browserName for changes to take effect."
} finally {
    if (Test-Path $tmpDir) {
        Remove-Item -Path $tmpDir -Recurse -Force
    }
}
