param([switch]$Background)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLocal = Join-Path $taskRoot '.telegram-codex'
$taskConfig = Join-Path $taskLocal 'config.json'
if (!(Test-Path -LiteralPath $taskConfig)) {
    if ($Background) { throw 'Chay setup tu terminal truoc khi bat startup.' }
    New-Item -ItemType Directory -Path $taskLocal -Force | Out-Null
    $taskToken = Read-Host 'Bot token tu @BotFather (an ky tu)' -AsSecureString
    $taskCaller = $env:CODEX_THREAD_ID
    if (!$taskCaller) { $taskCaller = $env:CODEX_SESSION_ID }
    if (!$taskCaller) { $taskCaller = Read-Host 'ID chat Codex dung lam cau noi' }
    if (!$taskCaller) { throw 'Can ID chat Codex de ket noi App.' }
    @{
        token = [System.Net.NetworkCredential]::new('', $taskToken).Password
        callerThreadId = $taskCaller
    } | ConvertTo-Json | Set-Content -LiteralPath $taskConfig -Encoding UTF8
    # Restrict the token/state directory to the current Windows account and SYSTEM.
    $taskSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $taskLocal /inheritance:r /grant:r "*$($taskSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Khong dat duoc quyen bao ve token.' }
}
if ($Background) {
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    $taskBridge = Join-Path $PSScriptRoot 'telegram_codex.mjs'
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList ('"' + $taskBridge + '"') `
        -WorkingDirectory $taskRoot -WindowStyle Hidden -Wait -PassThru `
        -RedirectStandardOutput (Join-Path $taskLocal 'stdout.log') `
        -RedirectStandardError (Join-Path $taskLocal 'stderr.log')
    exit $taskProcess.ExitCode
}
& node (Join-Path $PSScriptRoot 'telegram_codex.mjs')
