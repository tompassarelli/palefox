#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# Removes the fx-autoconfig setup that previous palefox versions left in place.
# See uninstall-fx-autoconfig.sh header for full rationale.
#
# What it does:
#   1. Backs up user.js to user.js.bak.<timestamp>
#   2. Backs up <profile>\chrome\utils\ to chrome.utils.bak.<timestamp>\
#   3. Removes <install-root>\config.js + defaults\pref\config-prefs.js (admin)
#   4. Removes <profile>\chrome\utils\
#   5. Strips userChromeJS.enabled line from user.js
#
# What it does NOT touch:
#   - chrome\JS\, chrome\CSS\, userChrome.css, etc. — your files, your call.
#   - Other prefs in user.js — strip manually if desired.

$useLibrewolf = $false
foreach ($arg in $args) {
    switch ($arg) {
        "--librewolf" { $useLibrewolf = $true }
        "--help" {
            Get-Content $PSCommandPath | Select-Object -First 18 | Select-Object -Skip 2
            exit 0
        }
        default { Write-Error "Unknown option: $arg"; exit 1 }
    }
}

if ($useLibrewolf) {
    $browserName = "LibreWolf"
    $browserProcess = "librewolf"
    $profilePattern = "*.default-default"
    $profilesDir = Join-Path $env:APPDATA "librewolf\Profiles"
    $appDir = (Get-ItemProperty "HKLM:\SOFTWARE\LibreWolf" -ErrorAction SilentlyContinue).InstallDirectory
    if (-not $appDir) { $appDir = "${env:ProgramFiles}\LibreWolf" }
} else {
    $browserName = "Firefox"
    $browserProcess = "firefox"
    $profilePattern = "*.default-release"
    $profilesDir = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    $appDir = (Get-ItemProperty "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox" -ErrorAction SilentlyContinue).InstallDirectory
    if (-not $appDir) { $appDir = "${env:ProgramFiles}\Mozilla Firefox" }
}

if (Get-Process $browserProcess -ErrorAction SilentlyContinue) {
    Write-Host "$browserName is currently running. Please close it before continuing."
    Read-Host "Press Enter to continue after closing $browserName"
}

if (-not (Test-Path $profilesDir)) {
    Write-Error "$browserName profile directory not found at $profilesDir"; exit 1
}

$profiles = Get-ChildItem -Path $profilesDir -Directory -Filter $profilePattern 2>$null
if (-not $profiles) {
    Write-Error "No $browserName profile matching $profilePattern"; exit 1
}

if ($profiles.Count -eq 1) {
    $profile = $profiles[0]
} else {
    Write-Host "Multiple profiles found:"
    for ($i = 0; $i -lt $profiles.Count; $i++) {
        Write-Host "  $($i + 1)) $($profiles[$i].Name)"
    }
    $choice = Read-Host "Select [1-$($profiles.Count)]"
    $profile = $profiles[[int]$choice - 1]
}

Write-Host "Profile: $($profile.Name)"
$chromeDir = Join-Path $profile.FullName "chrome"
$userJs = Join-Path $profile.FullName "user.js"
$prefsJs = Join-Path $profile.FullName "prefs.js"
$utilsDir = Join-Path $chromeDir "utils"
$ts = Get-Date -Format "yyyy-MM-dd-HHmmss"

# --- 1. Backup root: one palefox-backup-<ts>\ dir, all snapshots inside ---
$backupDir = Join-Path $profile.FullName "palefox-backup-$ts"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (Test-Path $userJs)  { Copy-Item -Path $userJs  -Destination (Join-Path $backupDir "user.js") }
if (Test-Path $prefsJs) { Copy-Item -Path $prefsJs -Destination (Join-Path $backupDir "prefs.js") }
if (Test-Path $utilsDir) { Copy-Item -Path $utilsDir -Destination (Join-Path $backupDir "utils") -Recurse }

# --- 3. Remove install-root bootstrap ---
if (Test-Path $appDir) {
    $bootstrap = Join-Path $appDir "config.js"
    $configPrefs = Join-Path $appDir "defaults\pref\config-prefs.js"
    foreach ($f in @($bootstrap, $configPrefs)) {
        if (Test-Path $f) {
            Write-Host "Removing $f..."
            try {
                Remove-Item -Path $f -Force
            } catch {
                Write-Host "Elevated privileges required. Retrying..."
                Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
                    "-Command", "Remove-Item -Path '$f' -Force"
                )
            }
        }
    }
}

# --- 4. Remove profile-side loader machinery ---
if (Test-Path $utilsDir) {
    Remove-Item -Path $utilsDir -Recurse -Force
    Write-Host "Removed $utilsDir"
}

# --- 5. Strip userChromeJS.enabled from user.js ---
if ((Test-Path $userJs) -and (Select-String -Path $userJs -Pattern '"userChromeJS\.enabled"' -Quiet)) {
    $kept = Get-Content $userJs | Where-Object { $_ -notmatch '"userChromeJS\.enabled"' }
    Set-Content -Path $userJs -Value $kept
    Write-Host "Stripped userChromeJS.enabled from user.js"
}

# Write README explaining backup contents + restore steps.
if ((Get-ChildItem $backupDir -Force | Measure-Object).Count -gt 0) {
    $readme = @"
palefox uninstall-fx-autoconfig backup — $ts
Created by: uninstall-fx-autoconfig.ps1

Snapshot of files this script modified or removed. Restore individually
or all at once.

Contents (only present if it existed before uninstall):
  user.js    Snapshot of <profile>\user.js before we stripped the
             userChromeJS.enabled line.
  prefs.js   Snapshot of <profile>\prefs.js before this uninstall run.
             We don't write prefs.js directly, but it contains
             palefox-set values Firefox persisted from past user.js
             applications. After uninstall, those values linger in
             prefs.js until you reset them via about:config — this
             snapshot is your pre-uninstall pref state if you need it.
  utils\     Snapshot of <profile>\chrome\utils\ before we removed it
             (the fx-autoconfig loader machinery).

Restore individually:
  Copy-Item .\user.js  '$userJs'
  Copy-Item .\prefs.js '$prefsJs'
  Copy-Item .\utils    '$chromeDir\' -Recurse

Restore everything:
  Copy-Item .\user.js  '$userJs'
  Copy-Item .\prefs.js '$prefsJs'
  if (Test-Path .\utils) { Copy-Item .\utils '$chromeDir\' -Recurse }

To also restore the install-root bootstrap (if you want fx-autoconfig back):
  re-run the palefox install.ps1 from the version you uninstalled from.

SECURITY NOTE — read before restoring:
This script removed the fx-autoconfig backdoor by removing three pieces
in concert. EACH piece is inert without the others — restoring just one
is safe — but together they form the loader chain that lets any
user-mode process inject privileged JS into Firefox:

  1. <install-root>\config.js   — autoconfig bootstrap (already removed)
  2. <profile>\chrome\utils\    — loader machinery (snapshotted as utils\)
  3. userChromeJS.enabled=true  — loader gate (in your user.js snapshot)

Restoring utils\ alone: inert. No bootstrap to chain into it.
Restoring user.js alone: inert. The pref does nothing without a loader.

If you restore utils\ AND later install any palefox version OR
independent fx-autoconfig (which provides piece 1), the chain reconnects
and the backdoor is active again. Restore individual pieces only if you
understand what you're putting back.
"@
    Set-Content -Path (Join-Path $backupDir "README.txt") -Value $readme
}

Write-Host ""
Write-Host "Done. fx-autoconfig has been removed."
Write-Host ""
Write-Host "Backup: $backupDir\"
Write-Host ""
Write-Host "Verify:"
Write-Host "  if (-not (Test-Path '$appDir\config.js')) { Write-Host OK_bootstrap }"
Write-Host "  if (-not (Test-Path '$utilsDir')) { Write-Host OK_loader }"
Write-Host "  if (-not (Select-String -Path '$userJs' -Pattern 'userChromeJS.enabled' -Quiet)) { Write-Host OK_pref }"
