$ErrorActionPreference = 'Stop'
$script:launched = @()
$script:stopped = @()
$script:existingApp = $true
function Get-AppxPackage { param($Name) [pscustomobject]@{ InstallLocation='C:\FakeCodex'; PackageFamilyName='OpenAI.Codex_test' } }
function Get-CimInstance { param($ClassName,$Filter)
    if (!$script:existingApp) { return @() }
    @([pscustomobject]@{ProcessId=123;ParentProcessId=1;ExecutablePath='C:\FakeCodex\app\ChatGPT.exe'},
      [pscustomobject]@{ProcessId=124;ParentProcessId=123;ExecutablePath='C:\FakeCodex\app\ChatGPT.exe'},
      [pscustomobject]@{ProcessId=999;ParentProcessId=1;ExecutablePath='C:\UnrelatedApp\ChatGPT.exe'})
}
function Get-Process { param($Id,$ErrorAction) [pscustomobject]@{Id=$Id} }
function Stop-Process { param($Id,[switch]$Force) $script:stopped += $Id }
function taskkill.exe { param($PidFlag,$TargetPid,$Tree,$Force) $script:stopped += [int]$TargetPid; $global:LASTEXITCODE=0 }
function Wait-Process { param($Id,$Timeout,$ErrorAction) }
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle) $script:launched += [pscustomobject]@{Path=$FilePath;Args=$ArgumentList;Style=$WindowStyle} }
$controlScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\control_codex_app.ps1'
. $controlScript -Action start | Out-Null
if ($script:stopped.Count -or $script:launched.Count) { throw 'Start must not kill/relaunch an already-running app.' }
$script:existingApp = $false
. $controlScript -Action start | Out-Null
if ($script:launched.Count -ne 1 -or $script:stopped.Count) { throw 'Start must launch when Codex is closed.' }
$script:launched = @()
$script:existingApp = $true
. $controlScript -Action restart | Out-Null
if ($script:stopped.Count -ne 1 -or $script:stopped[0] -ne 123) { throw 'Restart must target only the installed Codex app.' }
if ($script:launched.Count -ne 1 -or $script:launched[0].Args -ne 'shell:AppsFolder\OpenAI.Codex_test!App' -or $script:launched[0].Style -ne 'Hidden') {
    throw 'Wrong launch command.'
}
Write-Output 'codex_app_control: start/restart target isolation and launch passed with mocked processes.'
