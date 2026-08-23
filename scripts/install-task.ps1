# Registers the nightly scrape as a Windows Scheduled Task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Remove
#
# Runs at 00:05 local time. This machine is on Singapore Standard Time, so that
# is 00:05 SGT — check with Get-TimeZone if you ever travel with the laptop.
#
# The task is deliberately forgiving about the laptop being asleep or off:
#   - StartWhenAvailable  : if 00:05 was missed, run as soon as possible after
#   - WakeToRun           : wake the machine if it is only sleeping
#   - RunOnlyIfNetworkAvailable
# It does NOT require admin, and runs only while you are logged on.

[CmdletBinding()]
param(
    [switch]$Remove,
    [string]$TaskName = 'SIM Timetable nightly scrape',
    [string]$At = '00:05'
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node was not found on PATH.' }

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName'."
    }
    return
}

$config = Join-Path $repo 'scripts\scrape.config.json'
if (-not (Test-Path $config)) {
    throw "Missing $config — copy scripts\scrape.config.example.json to it and set scheduleUrl first."
}

$profileDir = Join-Path $repo '.scrape-profile'
if (-not (Test-Path $profileDir)) {
    Write-Warning "No browser profile at $profileDir yet."
    Write-Warning "Run this first, and sign in when the window opens:"
    Write-Warning "  node scripts\auto-scrape.mjs --login"
}

$action = New-ScheduledTaskAction -Execute $node `
    -Argument 'scripts\auto-scrape.mjs --publish' `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -RunOnlyIfNetworkAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'Scrapes the SIM campus schedule and publishes data/latest.json to GitHub.' | Out-Null

Write-Host "Registered '$TaskName' — runs daily at $At local time ($((Get-TimeZone).Id))."
Write-Host ""
Write-Host "Try it now without waiting for midnight:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check the result:"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName' | Select LastRunTime, LastTaskResult"
Write-Host "(LastTaskResult 0 = success, 1 = the scrape failed and left the old data alone.)"
