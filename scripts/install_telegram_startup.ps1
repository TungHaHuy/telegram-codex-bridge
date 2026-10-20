$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $taskRoot '.telegram-codex\config.json'
if (!(Test-Path -LiteralPath $taskConfig)) { throw 'Chay start_telegram_codex.ps1 va ghep tai khoan truoc.' }
$taskData = Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json
if (!$taskData.ownerId) { throw 'Ghep tai khoan Telegram truoc khi cai startup.' }
Get-Command node.exe -ErrorAction Stop | Out-Null

$taskName = 'Codex Telegram Bridge'
$taskLauncher = Join-Path $PSScriptRoot 'start_telegram_codex.ps1'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and !($taskExisting.Actions.Arguments -like ('*' + $taskLauncher + '*'))) {
    throw 'Task cung ten dang chay script khac; khong ghi de.'
}
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction = New-ScheduledTaskAction `
    -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskLauncher + '" -Background') `
    -WorkingDirectory $taskRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 255 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger `
    -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Da cai task startup va yeu cau chay bot. Log: .telegram-codex\stdout.log, stderr.log'
