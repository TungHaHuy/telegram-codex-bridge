param([ValidateSet('start', 'restart')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (!$package) { throw 'Codex App is not installed for this Windows account.' }
$appExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$processes = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {
    $_.ExecutablePath -eq $appExe
})
if ($Action -eq 'restart') {
    # Only this installed app; do not kill other ChatGPT installations or the bot.
    $appProcessIds = @($processes | ForEach-Object { $_.ProcessId })
    foreach ($item in @($processes | Where-Object { $_.ParentProcessId -notin $appProcessIds })) {
        if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID $item.ProcessId /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not stop the Codex process tree.' }
        }
    }
    foreach ($item in $processes) { Wait-Process -Id $item.ProcessId -Timeout 60 -ErrorAction SilentlyContinue }
} elseif ($processes.Count -gt 0) {
    Write-Output 'Codex is already running.'
    return
}
$appId = $package.PackageFamilyName + '!App'
Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $appId) -WindowStyle Hidden
Write-Output 'Codex launch requested.'
