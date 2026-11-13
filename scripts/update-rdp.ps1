<#
.SYNOPSIS
    Update a deployed combo-cleaner-bot in place without touching its data.

.DESCRIPTION
    Compares the deployed commit with the newest one on GitHub and, when they
    differ, overlays the new code. It never deletes anything and never writes to:

        .env
        data\var-data\*          (raw dumps, cleaned output, site saves)
        data\custom-*.json       (your queries and domains)
        node_modules             (unless package-lock.json changed)

    Then it restarts the ComboCleanerBot scheduled task so the new code is live.

.PARAMETER TargetPath
    The deployed folder.

.PARAMETER InstallAutoUpdate
    Also register ComboCleanerBotUpdate, which runs this script every 10 minutes.

.PARAMETER Once
    Run a single update pass (what the scheduled task does).

.PARAMETER Force
    Update even when the deployed commit already matches GitHub.

.PARAMETER NoRestart
    Copy files but do not restart the bot task.

.PARAMETER Quiet
    Only write to the log (used by the scheduled task).

.EXAMPLE
    .\scripts\update-rdp.ps1 -InstallAutoUpdate

.EXAMPLE
    .\scripts\update-rdp.ps1 -Force
#>

[CmdletBinding()]
param(
    [string]$TargetPath = "C:\htzone\combo-cleaner-bot",
    [string]$Repo = "surojcreator/combo-cleaner-bot",
    [string]$Branch = "main",
    [string]$TaskName = "ComboCleanerBot",
    [string]$UpdateTaskName = "ComboCleanerBotUpdate",
    [switch]$InstallAutoUpdate,
    [switch]$Force,
    [switch]$NoRestart,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$ScriptVersion = "2026-11-05.4"
$stampFile = Join-Path $TargetPath ".deployed-commit"
$logFile = Join-Path $TargetPath "update.log"

function Log([string]$message, [string]$level = "info") {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$level] $message"
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
            Move-Item $logFile "$logFile.1" -Force
        }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
    if (-not $Quiet) {
        if ($level -eq "error") { Write-Host "  [fail] $message" -ForegroundColor Red }
        elseif ($level -eq "warn") { Write-Host "  [warn] $message" -ForegroundColor Yellow }
        elseif ($level -eq "ok") { Write-Host "  [ok]   $message" -ForegroundColor Green }
        else { Write-Host "  $message" }
    }
}

function Fail([string]$message) {
    Log $message "error"
    exit 1
}

function Install-UpdateTask {
    $script = Join-Path $TargetPath "scripts\update-rdp.ps1"
    if (-not (Test-Path $script)) { Log "update script missing at $script" "warn"; return }
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Quiet" -WorkingDirectory $TargetPath
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) `
        -RepetitionDuration ([TimeSpan]::MaxValue)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $existing = Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false }
    Register-ScheduledTask -TaskName $UpdateTaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description "Pull bot updates from GitHub every 10 minutes (never touches data)" | Out-Null
    Log "auto-update task registered (every 10 min)" "ok"
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $Quiet) {
    Write-Host "updater v$ScriptVersion | PS $($PSVersionTable.PSVersion) | target=$TargetPath"
}

if (-not (Test-Path $TargetPath)) { Fail "target $TargetPath does not exist - run deploy-rdp.ps1 first" }

# ---- what is deployed vs what is on GitHub --------------------------------
$remoteSha = $null
try {
    $api = "https://api.github.com/repos/$Repo/commits/$Branch"
    $res = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "combo-cleaner-updater" } -TimeoutSec 25
    $remoteSha = [string]$res.sha
} catch {
    $msg = $_.Exception.Message
    if ($msg -match "403|rate limit") {
        Log "GitHub API rate limit - skipping this pass" "warn"
        exit 0
    }
    Fail "cannot reach GitHub: $msg"
}
if ([string]::IsNullOrWhiteSpace($remoteSha)) { Fail "GitHub returned no commit for $Branch" }

$localSha = ""
if (Test-Path $stampFile) { $localSha = (Get-Content $stampFile -Raw).Trim() }
Log "deployed=$($localSha.Substring(0, [Math]::Min(7, $localSha.Length))) remote=$($remoteSha.Substring(0,7))"

if ($localSha -eq $remoteSha -and -not $Force) {
    Log "already up to date" "ok"
    if ($InstallAutoUpdate) { Install-UpdateTask }
    exit 0
}

# ---- fetch the exact commit (pinned URL, no CDN staleness) ----------------
$stage = Join-Path $env:TEMP "ccb-update-$remoteSha"
$zip = Join-Path $env:TEMP "ccb-update-$remoteSha.zip"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
try {
    Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$remoteSha" -OutFile $zip -UseBasicParsing -TimeoutSec 60
    Expand-Archive -Path $zip -DestinationPath $stage -Force
} catch {
    Fail "download failed: $($_.Exception.Message)"
}
$root = Get-ChildItem $stage -Directory | Select-Object -First 1
if (-not $root -or -not (Test-Path (Join-Path $root.FullName "src\index.js"))) {
    Fail "archive does not look like this repo"
}

# ---- overlay code, never touch data ---------------------------------------
$lockChanged = $false
$newLock = Join-Path $root.FullName "package-lock.json"
$oldLock = Join-Path $TargetPath "package-lock.json"
if ((Test-Path $newLock) -and (Test-Path $oldLock)) {
    $a = (Get-FileHash $newLock -Algorithm SHA256).Hash
    $b = (Get-FileHash $oldLock -Algorithm SHA256).Hash
    $lockChanged = ($a -ne $b)
}

$rc = @(
    $root.FullName, $TargetPath,
    "/E", "/IS", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np",
    "/XD", "node_modules", ".git", ".tmp", (Join-Path "data" "var-data"),
    "/XF", ".env", "*.log", "update.log", "custom-domains.json", "custom-queries.json"
)
& robocopy @rc | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "robocopy failed ($LASTEXITCODE)" }
Log "code overlaid (old files kept, data untouched)" "ok"

if ($lockChanged) {
    Log "package-lock.json changed - reinstalling dependencies"
    Push-Location $TargetPath
    try {
        $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
        if (-not $npm) { $npm = Join-Path (Split-Path -Parent (Get-Command node.exe).Source) "npm.cmd" }
        & $npm.Source ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Log $_ }
        if ($LASTEXITCODE -ne 0) { Log "npm ci failed - the bot may still run on the old modules" "warn" }
        else { Log "dependencies installed" "ok" }
    } finally {
        Pop-Location
    }
}

Set-Content -Path $stampFile -Value $remoteSha -Encoding ASCII
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

# ---- restart so the new code is live --------------------------------------
if (-not $NoRestart) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $TaskName
        Log "restarted task $TaskName" "ok"
    } else {
        Log "task $TaskName not found - start the bot yourself" "warn"
    }
}

Log "updated to $($remoteSha.Substring(0,7))" "ok"
if ($InstallAutoUpdate) { Install-UpdateTask }
exit 0
