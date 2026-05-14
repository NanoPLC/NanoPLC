# Bootstrap ESP-IDF into the user's profile (see repo docs/BOOTSTRAP_TOOLCHAIN.md).
# Requires: Git on PATH. install.bat will download Python and toolchains (slow, requires network).

param(
    [string]$InstallRoot = $(Join-Path $env:USERPROFILE ".nanoplc"),
    [string]$IdfTag = "v5.3.3",
    [string]$Target = "esp32s3"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not on PATH. Install Git for Windows and retry."
    exit 1
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$idfPath = Join-Path $InstallRoot "esp-idf"

if (Test-Path (Join-Path $idfPath ".git")) {
    Write-Host "esp-idf already present at $idfPath - skip clone."
    Write-Host "Remove folder esp-idf for a clean reinstall, or git pull manually."
}
else {
    if (Test-Path $idfPath) {
        Write-Host "Removing incomplete folder: $idfPath"
        Remove-Item -Recurse -Force $idfPath
    }
    Write-Host "Cloning esp-idf tag $IdfTag (depth 1)..."
    git clone --depth 1 --branch $IdfTag "https://github.com/espressif/esp-idf.git" $idfPath
}

Write-Host "Running install.bat for target $Target (may take 15-40+ minutes)..."
$installBat = Join-Path $idfPath "install.bat"
if (-not (Test-Path -LiteralPath $installBat)) {
    Write-Error "install.bat not found at $installBat - clone may have failed or esp-idf layout changed."
    exit 1
}
$proc = Start-Process `
    -FilePath $installBat `
    -ArgumentList $Target `
    -WorkingDirectory $idfPath `
    -NoNewWindow `
    -Wait `
    -PassThru
if ($proc.ExitCode -ne 0) {
    throw "install.bat exited with code $($proc.ExitCode)"
}

$exportPs1 = Join-Path $idfPath "export.ps1"
Write-Host ""
Write-Host "--- Done ---"
Write-Host "In VS Code User/Workspace settings, set for example:"
Write-Host ('  nanoplc-idf.distRoot: {0}' -f $InstallRoot)
Write-Host ('  nanoplc-idf.idfRelease: {0}' -f $IdfTag)
Write-Host ('  nanoplc-idf.idfSetupScript: {0}' -f $exportPs1)
Write-Host ""
Write-Host ('Before idf.py, in a new PowerShell session run: . "{0}"' -f $exportPs1)
Write-Host ""
Write-Host 'Optional: Command Palette -> "NanoPLC: Add ESP-IDF export to PowerShell profile(s)" for new terminals'
