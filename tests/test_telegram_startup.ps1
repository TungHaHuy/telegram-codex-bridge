# Integration check: run after installing startup; it does not register or stop tasks.
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$testTask = Get-ScheduledTask -TaskName 'Codex Telegram Bridge' -ErrorAction Stop
$testLauncher = Join-Path $testRoot 'scripts\start_telegram_codex.ps1'
$testBridge = Join-Path $testRoot 'scripts\telegram_codex.mjs'
if (!$testTask.Settings.Enabled) { throw 'Startup task disabled.' }
if (!$testTask.Triggers -or !$testTask.Triggers[0].Enabled -or !$testTask.Triggers[0].CimClass.CimClassName.EndsWith('LogonTrigger')) {
    throw 'Missing enabled logon trigger.'
}
if ($testTask.Principal.LogonType -ne 'Interactive' -or $testTask.Principal.RunLevel -ne 'Limited') {
    throw 'Task must run interactively without elevated rights.'
}
if ($testTask.Actions.Count -ne 1 -or $testTask.Actions[0].Arguments -notlike ('*"' + $testLauncher + '" -Background') -or
    $testTask.Actions[0].Arguments -notlike '*-WindowStyle Hidden*' -or $testTask.Actions[0].WorkingDirectory -ne $testRoot) {
    throw 'Wrong startup action.'
}
if ($testTask.Settings.ExecutionTimeLimit -ne 'PT0S' -or !$testTask.Settings.RestartCount -or
    $testTask.Settings.RestartInterval -ne 'PT1M' -or $testTask.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'Missing restart or single-instance settings.'
}
$testProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like ('*"' + $testBridge + '"*') -or $_.CommandLine -like ('* ' + $testBridge)
})
if ($testTask.State -ne 'Running' -or $testProcesses.Count -ne 1) { throw 'Expected one bot process under the running task.' }
$testPid = [int](Get-Content -LiteralPath (Join-Path $testRoot '.telegram-codex\bridge.pid'))
if ($testPid -ne $testProcesses[0].ProcessId) { throw 'PID lock does not match the running bot.' }
$testLog = Get-Content -LiteralPath (Join-Path $testRoot '.telegram-codex\stdout.log') -Raw -Encoding UTF8
if ($testLog -notmatch 'Ctrl\+C') { throw 'Bot has not confirmed readiness.' }
Write-Output 'telegram_startup: logon, hidden launch, retry, single process and readiness checks passed.'
