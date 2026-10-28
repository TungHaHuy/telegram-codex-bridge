# Integration check: run after installing startup; it does not register or stop tasks.
param([switch]$LauncherOnly)
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$testLauncher = Join-Path $testRoot 'scripts\start_telegram_codex.ps1'
$testBridge = Join-Path $testRoot 'scripts\telegram_codex.mjs'
if (!$LauncherOnly) {
$testTask = Get-ScheduledTask -TaskName 'Codex Telegram Bridge' -ErrorAction Stop
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
}

# Reproduce Codex being unavailable initially without closing the user's Codex App.
$testRetryRoot = Join-Path ([IO.Path]::GetTempPath()) ('telegram startup retry-' + [Guid]::NewGuid().ToString('N'))
$testRetryScript = Join-Path $testRetryRoot 'scripts'
$testRetryLocal = Join-Path $testRetryRoot '.telegram-codex'
$testRetryProcess = $null
try {
    New-Item -ItemType Directory -Path $testRetryScript,$testRetryLocal -Force | Out-Null
    Copy-Item -LiteralPath $testLauncher -Destination (Join-Path $testRetryScript 'start_telegram_codex.ps1')
    Set-Content -LiteralPath (Join-Path $testRetryLocal 'config.json') -Value '{}' -Encoding ASCII
    @'
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const local = new URL('../.telegram-codex/', import.meta.url);
const file = new URL('attempts.txt', local);
const attempt = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(new URL('test.pid', local), String(process.pid));
fs.writeFileSync(file, String(attempt));
if (attempt === 1) {
  const child=spawn(process.execPath,['-e','/* TELEGRAM_STARTUP_DESCENDANT */ setTimeout(()=>{},60000)'],{detached:true,stdio:'inherit',windowsHide:true});
  fs.writeFileSync(new URL('descendant.pid',local),String(child.pid));child.unref();
  console.error('Codex unavailable (test)');process.exit(1);
}
console.log('READY_AFTER_RETRY');
setInterval(() => {}, 1000);
'@ | Set-Content -LiteralPath (Join-Path $testRetryScript 'telegram_codex.mjs') -Encoding ASCII
    $testRetryLauncher = Join-Path $testRetryScript 'start_telegram_codex.ps1'
    $testRetryProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $testRetryLauncher + '" -Background') `
        -WindowStyle Hidden -PassThru
    $testRetryReady = $false
    for ($attempt = 0; $attempt -lt 160; $attempt++) {
        $testRetryLog = Join-Path $testRetryLocal 'stdout.log'
        if ((Test-Path -LiteralPath $testRetryLog) -and
            (Get-Content -LiteralPath $testRetryLog -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) -match 'READY_AFTER_RETRY') {
            $testRetryReady = $true; break
        }
        if ($testRetryProcess.HasExited) { throw 'Launcher exited instead of waiting for Codex.' }
        Start-Sleep -Milliseconds 250
    }
    if (!$testRetryReady -or [int](Get-Content -LiteralPath (Join-Path $testRetryLocal 'attempts.txt')) -ne 2) {
        throw 'Bot did not recover after the initial startup failure.'
    }
    $testDescendantPid = [int](Get-Content -LiteralPath (Join-Path $testRetryLocal 'descendant.pid'))
    if (!(Get-Process -Id $testDescendantPid -ErrorAction SilentlyContinue)) { throw 'Recovery must not wait for the surviving descendant.' }
} finally {
    if ($testRetryProcess -and !$testRetryProcess.HasExited) { Stop-Process -Id $testRetryProcess.Id -Force; $testRetryProcess.WaitForExit() }
    $testRetryPidFile = Join-Path $testRetryLocal 'test.pid'
    if (Test-Path -LiteralPath $testRetryPidFile) {
        $testRetryPid = [int](Get-Content -LiteralPath $testRetryPidFile)
        $testRetryChild = Get-CimInstance Win32_Process -Filter "ProcessId=$testRetryPid"
        if ($testRetryChild -and $testRetryChild.Name -eq 'node.exe' -and
            $testRetryChild.CommandLine -like ('*' + (Join-Path $testRetryScript 'telegram_codex.mjs') + '*')) {
            Stop-Process -Id $testRetryPid -Force
            Wait-Process -Id $testRetryPid -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    $testDescendantFile = Join-Path $testRetryLocal 'descendant.pid'
    if (Test-Path -LiteralPath $testDescendantFile) {
        $testDescendantPid = [int](Get-Content -LiteralPath $testDescendantFile)
        $testDescendant = Get-CimInstance Win32_Process -Filter "ProcessId=$testDescendantPid"
        if ($testDescendant.Name -eq 'node.exe' -and $testDescendant.CommandLine -like '*TELEGRAM_STARTUP_DESCENDANT*') { Stop-Process -Id $testDescendantPid -Force }
    }
    $testRetryPath = [IO.Path]::GetFullPath($testRetryRoot)
    $testTempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\telegram startup retry-'
    if (!$testRetryPath.StartsWith($testTempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $testRetryPath -Recurse -Force
}
Write-Output 'telegram_startup: selected startup checks and recovery while a descendant retains stdout passed.'
