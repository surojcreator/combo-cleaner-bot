<#
.SYNOPSIS
    One-paste installer for a blank/fresh Windows host (RDP) that pulls this
    repo from GitHub and hands off to scripts/deploy-rdp.ps1.

.DESCRIPTION
    Use this when the target box only exposes RDP (3389) - no SMB, no WinRM -
    so nothing can be copied to it from the outside.

    Paste this INSIDE the RDP session (PowerShell, one line):

        $u='https://raw.githubusercontent.com/surojcreator/combo-cleaner-bot/main/scripts/bootstrap-rdp.ps1'; $f="$env:TEMP\bootstrap.ps1"; irm $u -OutFile $f; & $f -Start

    With secrets, add -EnvBase64 (a base64 of your .env - generated for you):

        & $f -Start -EnvBase64 "<paste>"

.PARAMETER Repo
    Public GitHub owner/repo to download.

.PARAMETER Branch
    Branch to install. Default main.

.PARAMETER TargetPath
    Install directory on this host.

.PARAMETER EnvBase64
    Base64-encoded .env content. When present it is written to .env verbatim
    (nothing is echoed to the console).

.PARAMETER EnvFileUrl
    Instead of a blob, download .env from this URL.

.PARAMETER KeepDownload
    Keep the downloaded zip in %TEMP%.

.EXAMPLE
    $f="$env:TEMP\bootstrap.ps1"; irm 'https://raw.githubusercontent.com/surojcreator/combo-cleaner-bot/main/scripts/bootstrap-rdp.ps1' -OutFile $f; & $f -Start -Force
#>

[CmdletBinding()]
param(
    [string]$Repo = "surojcreator/combo-cleaner-bot",
    [string]$Branch = "main",
    [string]$TargetPath = "C:\htzone\combo-cleaner-bot",
    [string]$EnvBase64 = "",
    [string]$EnvFileUrl = "",
    [switch]$KeepDownload,
    [switch]$SkipDeps,
    [switch]$NoTask,
    [switch]$Start,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say  ([string]$m) { Write-Host "  $m" }
function Step ([string]$m) { Write-Host ""; Write-Host "== $m ==" -ForegroundColor Cyan }
function Good ([string]$m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn ([string]$m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
) -or ([Security.Principal.WindowsIdentity]::GetCurrent().Name -match "Administrator$")
if (-not $isAdmin) { Warn "not running as Administrator - the scheduled task may fail to register" }

Step "Downloading $Repo@$Branch"
$zip = Join-Path $env:TEMP "combo-cleaner-$Branch.zip"
$url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Good "$([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB"

Step "Extracting"
$stage = Join-Path $env:TEMP "combo-cleaner-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $stage -Force
$root = Get-ChildItem $stage -Directory | Select-Object -First 1
if (-not $root) { throw "extracted archive has no root folder" }
if (-not (Test-Path (Join-Path $root.FullName "src\index.js"))) {
    throw "src\index.js missing from the archive - wrong repo/branch?"
}
if (-not $KeepDownload) { Remove-Item $zip -Force }

if (-not (Test-Path $TargetPath)) { New-Item -ItemType Directory -Force -Path $TargetPath | Out-Null }
& robocopy $root.FullName $TargetPath /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Good "code in $TargetPath"

# ---- secrets -------------------------------------------------------------
Step "Environment"
$envFile = Join-Path $TargetPath ".env"
if ($EnvBase64) {
    $bytes = [Convert]::FromBase64String($EnvBase64)
    [IO.File]::WriteAllBytes($envFile, $bytes)
    Good "wrote .env from -EnvBase64 ($($bytes.Length) bytes)"
} elseif ($EnvFileUrl) {
    Invoke-WebRequest -Uri $EnvFileUrl -OutFile $envFile -UseBasicParsing
    Good "wrote .env from $EnvFileUrl"
} elseif (Test-Path $envFile) {
    Good ".env already present - keeping it"
} else {
    Warn "no .env - the bot will run in standby until BOT_TOKEN and TELEGRAM_* are set"
    Say  "fix later: notepad `"$envFile`", then: npm run doctor -- --ping"
}

# ---- hand off ------------------------------------------------------------
Step "Installing"
$deploy = Join-Path $TargetPath "scripts\deploy-rdp.ps1"
if (-not (Test-Path $deploy)) { throw "scripts\deploy-rdp.ps1 not found after extract" }
& $deploy -TargetPath $TargetPath -SkipDeps:$SkipDeps -NoTask:$NoTask -Start:$Start -Force:$Force

Step "Verify the account transport"
Say "Run this before trusting /ulp:"
Say "  cd `"$TargetPath`"; npm run doctor -- --ping"
Say ""
Say "Watch it live:"
Say "  cd `"$TargetPath`"; node src\index.js"
