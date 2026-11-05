<#
.SYNOPSIS
    Deploy the combo-cleaner-bot to a Windows host (RDP) and run it as a
    scheduled task that starts at logon, hidden, and restarts on crash.

.DESCRIPTION
    Three modes, one script:

      1) Local install (run ON the RDP):
           .\scripts\deploy-rdp.ps1 -Start

      2) Copy this folder to another Windows box over the admin share:
           .\scripts\deploy-rdp.ps1 -RdpHost 1.2.3.4 -RdpUser Administrator

      3) Copy AND install over WinRM (needs WinRM enabled on the target):
           .\scripts\deploy-rdp.ps1 -RdpHost srv -RdpUser Administrator -UseWinRM -Start

    It never invents secrets: .env is copied as-is (or from .env.example as a
    template), then `npm run doctor` is the thing that tells you if the account
    transport is ready.

.PARAMETER TargetPath
    Where the bot ends up on the target machine.

.PARAMETER RdpHost
    Remote host name / IP. Omit to install on this machine.

.PARAMETER RdpUser
    Account used for the SMB admin share (and WinRM when -UseWinRM).

.PARAMETER AdminShare
    Admin share to copy through. Default C$ (requires local admin).

.PARAMETER UseWinRM
    After copying, run the install step on the remote host through WinRM.

.PARAMETER SkipDeps
    Do not run npm install (use when node_modules is already present).

.PARAMETER NoTask
    Copy + install, but do not register the scheduled task.

.PARAMETER Start
    Start the task immediately and wait for /healthz.

.PARAMETER Force
    Replace an existing scheduled task without asking.

.EXAMPLE
    .\scripts\deploy-rdp.ps1 -Start -Force
#>

[CmdletBinding()]
param(
    [string]$TargetPath = "C:\htzone\combo-cleaner-bot",
    [string]$RdpHost = "",
    [string]$RdpUser = "",
    [string]$AdminShare = "C$",
    [switch]$UseWinRM,
    [switch]$SkipDeps,
    [switch]$NoTask,
    [switch]$Start,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$TaskName = "ComboCleanerBot"
$NodeVersion = "22.14.0"
$Source = Split-Path -Parent $PSScriptRoot

function Say  ([string]$m) { Write-Host "  $m" }
function Step ([string]$m) { Write-Host ""; Write-Host "== $m ==" -ForegroundColor Cyan }
function Good ([string]$m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn ([string]$m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Fail ([string]$m) { Write-Host "  [fail] $m" -ForegroundColor Red }

function Get-EnvValue([string]$File, [string]$Key) {
    if (-not (Test-Path $File)) { return $null }
    $line = Select-String -Path $File -Pattern "^$Key=(.*)$" -Encoding UTF8 |
        Select-Object -First 1
    if (-not $line) { return $null }
    return $line.Matches[0].Groups[1].Value.Trim()
}

function Set-EnvValue([string]$File, [string]$Key, [string]$Value) {
    if (-not (Test-Path $File)) { return }
    for ($i = 1; $i -le 6; $i++) {
        try {
            $text = [IO.File]::ReadAllText($File)
            $pattern = "(?m)^$Key=.*$"
            if ($text -match $pattern) {
                $text = [regex]::Replace($text, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{
                    param($m) "$Key=$Value"
                })
            } else {
                $text = $text.TrimEnd() + "`r`n$Key=$Value`r`n"
            }
            [IO.File]::WriteAllText($File, $text)
            return
        } catch {
            # Defender / AV can hold a fresh handle for a moment after a copy.
            if ($i -eq 6) { Warn "could not update $Key in .env: $($_.Exception.Message)"; return }
            Start-Sleep -Milliseconds 250
        }
    }
}

# .env.example ships POSIX roots for the Linux hosts; a POSIX path on Windows
# silently turns into C:\var\data, so those get replaced with a real folder.
function Resolve-StorageRoot([string]$Value, [string]$Fallback) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Fallback }
    if ($Value.StartsWith("/")) { return $Fallback }
    if ($Value -notmatch "^[A-Za-z]:\\" -and -not $Value.StartsWith("\\")) { return $Fallback }
    # A Windows path copied from another machine (or from a .env blob) usually
    # does not exist here - fall back to a folder this host actually owns.
    if (-not (Test-Path $Value)) { return $Fallback }
    return $Value
}

function Resolve-Node {
    param([string]$InstallDir = "C:\nodejs")

    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $ver = (& $cmd.Source -v) 2>$null
        Good "node $ver ($($cmd.Source))"
        return $cmd.Source
    }
    $local = Join-Path $InstallDir "node.exe"
    if (Test-Path $local) {
        Good "node found at $local"
        return $local
    }

    Warn "node.exe not found - installing portable Node $NodeVersion to $InstallDir"
    $zip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
    $url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP "node-extract-$NodeVersion"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") $InstallDir
    Remove-Item $zip -Force

    # Persist on PATH for future shells (current session too).
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$machinePath;$InstallDir", "Machine")
    }
    $env:Path = "$env:Path;$InstallDir"
    Good "installed $(Join-Path $InstallDir 'node.exe')"
    return (Join-Path $InstallDir "node.exe")
}

function Copy-Project([string]$Destination) {
    $excludeDirs = @("node_modules", ".git", ".tmp", "solver-upstream", (Join-Path "data" "var-data"))
    $args = @(
        $Source, $Destination,
        "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np",
        "/XD"
    ) + $excludeDirs + @("/XF", "*.log")
    & robocopy @args | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) { throw "robocopy failed with exit code $code" }
    Good "copied $Source -> $Destination"
}

# ---------------------------------------------------------------- remote copy
if ($RdpHost) {
    Step "Copying to \\$RdpHost\$AdminShare"
    if (-not (Test-Path "\\$RdpHost\$AdminShare")) {
        if ($RdpUser) {
            $cred = Get-Credential -UserName $RdpUser -Message "Credentials for \\$RdpHost"
            $plain = $cred.GetNetworkCredential().Password
            & net use "\\$RdpHost\$AdminShare" "/user:$($cred.UserName)" "$plain" | Out-Null
        } else {
            throw "\\$RdpHost\$AdminShare is not reachable. Pass -RdpUser to authenticate."
        }
    }
    $drive, $rest = $TargetPath -split ':', 2
    if (-not $rest) { throw "TargetPath must be an absolute path like C:\htzone\combo-cleaner-bot" }
    $sharePath = "\\$RdpHost\$AdminShare$($rest -replace '/', '\')"
    New-Item -ItemType Directory -Force -Path $sharePath | Out-Null
    Copy-Project $sharePath

    if (-not $UseWinRM) {
        Say ""
        Good "files are on ${RdpHost}:$TargetPath"
        Say "Now run this ON the RDP (PowerShell as Administrator):"
        Say "  cd `"$TargetPath`""
        Say "  .\scripts\deploy-rdp.ps1 -Start -Force"
        exit 0
    }

    Step "Installing over WinRM"
    $scriptPath = Join-Path $sharePath "scripts\deploy-rdp.ps1"
    Invoke-Command -ComputerName $RdpHost -Credential (Get-Credential -UserName $RdpUser) -ScriptBlock {
        param($p, $t, $start, $force, $skipDeps, $noTask)
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p `
            -TargetPath $t -Start:$start -Force:$force -SkipDeps:$skipDeps -NoTask:$noTask
    } -ArgumentList $scriptPath, $TargetPath, [bool]$Start, [bool]$Force, [bool]$SkipDeps, [bool]$NoTask
    exit 0
}

# ------------------------------------------------------------- local install
Step "Installing on this machine"
if (-not (Test-Path $TargetPath)) {
    New-Item -ItemType Directory -Force -Path $TargetPath | Out-Null
}
if ((Resolve-Path $Source).Path -ne (Resolve-Path $TargetPath).Path) {
    Copy-Project $TargetPath
} else {
    Good "already running from $TargetPath"
}

$nodeExe = Resolve-Node

$envFile = Join-Path $TargetPath ".env"
if (-not (Test-Path $envFile)) {
    $example = Join-Path $TargetPath ".env.example"
    if (Test-Path $example) {
        Copy-Item $example $envFile
        Warn "created .env from .env.example - fill BOT_TOKEN and the TELEGRAM_* values"
    } else {
        Warn "no .env present - the bot will boot in standby until BOT_TOKEN is set"
    }
} else {
    Good ".env present"
}

if (-not $SkipDeps) {
    Step "Installing dependencies"
    Push-Location $TargetPath
    try {
        $npm = Join-Path (Split-Path -Parent $nodeExe) "npm.cmd"
        if (Test-Path (Join-Path $TargetPath "package-lock.json")) {
            & $npm ci --omit=dev --no-audit --no-fund
        } else {
            & $npm install --omit=dev --no-audit --no-fund
        }
        if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
        Good "dependencies installed"
    } finally {
        Pop-Location
    }
}

Step "Preparing storage folders"
$baseDir = Join-Path $TargetPath "data\var-data"
$rootDir = Resolve-StorageRoot (Get-EnvValue $envFile "LOCAL_PROCESS_ROOT") $baseDir
$procDir = Resolve-StorageRoot (Get-EnvValue $envFile "LOCAL_PROCESSED_ROOT") (Join-Path $baseDir "processed")
if (Test-Path $envFile) {
    Set-EnvValue $envFile "LOCAL_PROCESS_ROOT" $rootDir
    Set-EnvValue $envFile "LOCAL_PROCESSED_ROOT" $procDir
}
New-Item -ItemType Directory -Force -Path $rootDir | Out-Null
New-Item -ItemType Directory -Force -Path $procDir | Out-Null
Good $rootDir
Good $procDir

if (-not $NoTask) {
    Step "Registering scheduled task '$TaskName'"
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        if (-not $Force) {
            $answer = Read-Host "  Task '$TaskName' exists. Replace it? (y/N)"
            if ($answer -notmatch '^(y|yes)$') { throw "Aborted - task not replaced." }
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Say "removed the old task"
    }

    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument "src\index.js" -WorkingDirectory $TargetPath
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description "Telegram combo cleaner bot" | Out-Null
    Good "task registered (starts at logon, restarts every minute on crash)"
}

if ($Start) {
    Step "Starting"
    if (-not $NoTask) { Start-ScheduledTask -TaskName $TaskName }
    $port = Get-EnvValue $envFile "PORT"
    if (-not $port) { $port = "8080" }
    $url = "http://127.0.0.1:$port/healthz"
    $deadline = (Get-Date).AddSeconds(90)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($res.StatusCode -eq 200) { $healthy = $true; break }
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if ($healthy) {
        Good "healthz answered on $url"
    } else {
        Warn "no answer on $url after 90s - check the log: $TargetPath\bot.log"
        Say "run this to watch it live:"
        Say "  & `"$nodeExe`" src\index.js   (from $TargetPath)"
    }
}

Step "Done"
Say "path      $TargetPath"
Say "node      $nodeExe"
Say "task      $(if ($NoTask) { '(skipped)' } else { $TaskName })"
Say ""
Say "Next: verify the account transport before trusting /ulp:"
Say "  cd `"$TargetPath`"; npm run doctor -- --ping"
Say ""
Say "Task control:"
Say "  Start-ScheduledTask  -TaskName $TaskName"
Say "  Stop-ScheduledTask   -TaskName $TaskName"
Say "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
