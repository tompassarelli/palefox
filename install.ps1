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

    # Backup root: every install creates ONE palefox-backup-<timestamp>\ dir
    # containing snapshots of everything we modify. User can restore individual
    # files or the whole set. README.txt inside explains contents + restore.
    $ts = Get-Date -Format "yyyy-MM-dd-HHmmss"
    $backupDir = Join-Path $profile.FullName "palefox-backup-$ts"
    if (-not $noBackup) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        if (Test-Path $chromeDir) {
            try {
                Copy-Item -Path $chromeDir -Destination (Join-Path $backupDir "chrome") -Recurse
            } catch {
                Write-Error "Failed to back up chrome folder."
                exit 1
            }
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
    $cssDir = Join-Path $chromeDir "CSS"
    if (-not (Test-Path $cssDir)) {
        New-Item -ItemType Directory -Path $cssDir | Out-Null
    }

    # Migration: previous palefox versions wrote palefox*.css and userChrome.css
    # at chrome\ root. The hash-pinned loader scans chrome\CSS\ instead, so
    # those files now sit unloaded — clean them up to avoid confusion.
    foreach ($stale in @("palefox.css", "palefox-tabs.css", "palefox-which-key.css", "palefox-legacy.css", "userChrome.css", "user.css")) {
        $stalePath = Join-Path $chromeDir $stale
        if (Test-Path $stalePath) {
            Remove-Item -Path $stalePath -Force
        }
    }

    # fx-autoconfig loader — always overwrite. Files here are HASHED by the
    # bootstrap, so they must match exactly what palefox shipped.
    $utilsSource = Join-Path $chromeSource "utils"
    if (Test-Path $utilsSource) {
        Get-ChildItem -Path $utilsDir -File | Remove-Item -Force
        Copy-Item -Path (Join-Path $utilsSource "*") -Destination $utilsDir -Force
    }

    # JS scripts — always overwrite (hashed by bootstrap; managed by palefox).
    $jsSource = Join-Path $chromeSource "JS"
    if (Test-Path $jsSource) {
        Get-ChildItem -Path $jsDir -File | Remove-Item -Force
        foreach ($file in (Get-ChildItem -Path $jsSource -File)) {
            Copy-Item -Path $file.FullName -Destination (Join-Path $jsDir $file.Name) -Force
        }
    }

    # CSS files — always overwrite (hashed by bootstrap; managed by palefox).
    $cssSource = Join-Path $chromeSource "CSS"
    if (Test-Path $cssSource) {
        Get-ChildItem -Path $cssDir -File | Remove-Item -Force
        foreach ($file in (Get-ChildItem -Path $cssSource -File)) {
            Copy-Item -Path $file.FullName -Destination (Join-Path $cssDir $file.Name) -Force
        }
    }

    # Install fx-autoconfig to Firefox application directory
    if ($env:PALEFOX_LOCAL) {
        $programSource = Join-Path $env:PALEFOX_LOCAL "program"
    } else {
        $programSource = Join-Path (Split-Path $chromeSource) "program"
    }

    if (Test-Path $programSource) {
        # The HASH-PINNED bootstrap is at config.generated.js (built by
        # `bun run build` from program\config.template.js with chrome\ file
        # hashes baked in). Falls back to config.js for tarball installs that
        # ship the pre-generated file.
        $bootstrapSrc = Join-Path $programSource "config.generated.js"
        if (-not (Test-Path $bootstrapSrc)) {
            $bootstrapSrc = Join-Path $programSource "config.js"
        }
        if (-not (Test-Path $bootstrapSrc)) {
            Write-Error "bootstrap not found at $bootstrapSrc. If installing from source, run `bun run build` first."
            exit 1
        }

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
            # Notice users upgrading from vanilla fx-autoconfig that we're
            # tightening their security boundary. No prompt — they ran install,
            # they're opting in. Ctrl-C if they object.
            $existingConfig = Join-Path $appDir "config.js"
            if ((Test-Path $existingConfig) -and -not (Select-String -Path $existingConfig -Pattern "PALEFOX_PINNED" -Quiet -ErrorAction SilentlyContinue)) {
                Write-Host ""
                Write-Host "Detected vanilla fx-autoconfig bootstrap — upgrading to palefox hash-pinned variant."
                Write-Host "This tightens palefox's security boundary:"
                Write-Host "  - Chrome JS/CSS files are SHA-256 verified at startup"
                Write-Host "  - Local-mode malware can no longer drop a .uc.js into your profile"
                Write-Host "    and have it execute with browser privileges"
                Write-Host "  - Any non-palefox .uc.js you had in chrome\JS\ will be rejected"
                Write-Host "    post-upgrade (backed up under chrome.bak.<timestamp>\JS\)"
                Write-Host "See docs\dev\sandbox-research.md for the threat-model writeup."
                Write-Host ""
            }
            Write-Host "Installing palefox hash-pinned loader to $appDir..."
            try {
                Copy-Item -Path $bootstrapSrc -Destination (Join-Path $appDir "config.js") -Force
                $prefDir = Join-Path $appDir "defaults\pref"
                if (-not (Test-Path $prefDir)) {
                    New-Item -ItemType Directory -Path $prefDir | Out-Null
                }
                Copy-Item -Path (Join-Path $programSource "defaults\pref\config-prefs.js") -Destination (Join-Path $prefDir "config-prefs.js") -Force
            } catch {
                Write-Host "Elevated privileges may be required. Retrying..."
                Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
                    "-Command",
                    "Copy-Item '$bootstrapSrc' '$(Join-Path $appDir "config.js")' -Force; " +
                    "New-Item -ItemType Directory -Path '$(Join-Path $appDir "defaults\pref")' -Force | Out-Null; " +
                    "Copy-Item '$(Join-Path $programSource "defaults\pref\config-prefs.js")' '$(Join-Path $appDir "defaults\pref\config-prefs.js")' -Force"
                )
            }
        } else {
            Write-Host "Warning: Could not locate $browserName install directory at $appDir"
            Write-Host "Manually copy program\config.generated.js and program\defaults\pref\config-prefs.js"
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
    $prefsJs = Join-Path $profile.FullName "prefs.js"

    # Back up user.js + prefs.js into the same palefox-backup-<ts>\ dir
    # as the chrome snapshot. Either may be absent on a fresh profile.
    if (-not $noBackup) {
        if (Test-Path $userJs) {
            Copy-Item -Path $userJs -Destination (Join-Path $backupDir "user.js")
        }
        if (Test-Path $prefsJs) {
            Copy-Item -Path $prefsJs -Destination (Join-Path $backupDir "prefs.js")
        }
    }

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

    # Force-overwrite a pref. Set-BrowserPref preserves existing values, which
    # is correct for user-customizable prefs but wrong for prefs whose value
    # changed across palefox versions (e.g. legacy stylesheets flipping
    # true → false when the loader stopped depending on it).
    function Force-SetBrowserPref {
        param([string]$Key, [string]$Value)
        $line = "user_pref(`"$Key`", $Value);"
        if (Test-Path $userJs) {
            $existing = Get-Content $userJs | Where-Object { $_ -notmatch [regex]::Escape("`"$Key`"") }
            Set-Content -Path $userJs -Value $existing
        }
        Write-Host "Setting $Key in user.js"
        Add-Content -Path $userJs -Value $line
    }

    # Legacy stylesheets pref OFF — palefox CSS now loads via the hash-pinned
    # loader's chrome:// CSS registration, NOT through Firefox's direct
    # userChrome.css load. Force-overrides any pre-existing `true` from
    # older palefox installs.
    Force-SetBrowserPref "toolkit.legacyUserProfileCustomizations.stylesheets" "false"
    # fx-autoconfig loader gate — required for the autoconfig bootstrap chain
    # to actually load palefox JS and CSS.
    Force-SetBrowserPref "userChromeJS.enabled" "true"
    Set-BrowserPref "sidebar.verticalTabs" "true"
    Set-BrowserPref "sidebar.revamp" "true"
    Set-BrowserPref "sidebar.position_start" "true"
    Set-BrowserPref "browser.toolbars.bookmarks.visibility" "`"never`""
    Set-BrowserPref "pfx.sidebar.width" "300"

    # Default toolbar layout
    Set-BrowserPref "browser.uiCustomization.state" "'{`"placements`":{`"widget-overflow-fixed-list`":[`"fxa-toolbar-menu-button`",`"home-button`",`"alltabs-button`",`"firefox-view-button`"],`"unified-extensions-area`":[],`"nav-bar`":[`"sidebar-button`",`"back-button`",`"forward-button`",`"stop-reload-button`",`"customizableui-special-spring1`",`"vertical-spacer`",`"urlbar-container`",`"customizableui-special-spring2`",`"downloads-button`",`"unified-extensions-button`"],`"toolbar-menubar`":[`"menubar-items`"],`"TabsToolbar`":[`"tabbrowser-tabs`",`"new-tab-button`"],`"vertical-tabs`":[],`"PersonalToolbar`":[`"import-button`",`"personal-bookmarks`"]},`"seen`":[],`"dirtyAreaCache`":[],`"currentVersion`":23,`"newElementCount`":0}'"

    # Write README explaining backup contents + restore steps.
    if ((-not $noBackup) -and (Test-Path $backupDir) -and (Get-ChildItem $backupDir -Force | Measure-Object).Count -gt 0) {
        $readme = @"
palefox install backup — $ts
Created by: install.ps1

Snapshot of files palefox modified (or caused Firefox to modify) on this
install run. Restore individually or all at once.

Contents (only present if it existed before install):
  chrome\    Snapshot of <profile>\chrome\ before palefox replaced
             utils\, JS\, CSS\. Includes any custom userChrome.css,
             user.css, or other userscripts you had.
  user.js    Snapshot of <profile>\user.js (Firefox force-apply prefs)
             before palefox modified it.
  prefs.js   Snapshot of <profile>\prefs.js (Firefox's persistent pref
             storage) before this install. We don't write prefs.js
             directly, but Firefox writes our user.js values into it on
             startup, so this captures the genuinely-pre-palefox state.

Restore individually:
  Copy-Item .\user.js     '$($profile.FullName)\user.js'
  Copy-Item .\prefs.js    '$($profile.FullName)\prefs.js'
  Copy-Item .\chrome\* '$chromeDir\' -Recurse -Force

Restore everything:
  Copy-Item .\* '$($profile.FullName)\' -Recurse -Force

SECURITY NOTE — read before restoring:
This install upgraded palefox to a hash-pinned loader, closing a known
fx-autoconfig vulnerability where any user-mode process could inject
privileged JS by dropping a .uc.js file into your profile.

Restoring this backup rolls you back to your prior palefox state. If that
state used vanilla fx-autoconfig (palefox versions before safer-js-loader),
restoring reintroduces the vulnerability. To roll back AND keep the
security upgrade, restore from this backup, then run
uninstall-fx-autoconfig.ps1 to remove the legacy loader entirely.
"@
        Set-Content -Path (Join-Path $backupDir "README.txt") -Value $readme
        Write-Host ""
        Write-Host "Backup: $backupDir\"
    }

    Write-Host "Done. Restart $browserName for changes to take effect."
} finally {
    if (Test-Path $tmpDir) {
        Remove-Item -Path $tmpDir -Recurse -Force
    }
}
