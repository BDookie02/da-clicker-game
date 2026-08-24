param([string]$Serial = '')

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $root 'devlog\physical-pvp-qa\runtime.json'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'

if (-not (Test-Path -LiteralPath $runtimeFile)) {
    Write-Output 'No physical PvP QA runtime is recorded.'
    exit 0
}

$runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
foreach ($entry in @($runtime.worker, $runtime.desktopClient)) {
    $process = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $actualStart = $process.StartTime.ToUniversalTime().ToString('o')
    if ($actualStart -ne [string]$entry.startedAtUtc) {
        throw "Refusing to stop reused PID $($entry.pid); its start time no longer matches the recorded QA process."
    }
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
}

$targetSerial = if ($Serial) { $Serial } else { [string]$runtime.serial }
if ($targetSerial -and (Test-Path -LiteralPath $adb)) {
    & $adb -s $targetSerial reverse --remove tcp:8787 2>$null | Out-Null
}

Remove-Item -LiteralPath $runtimeFile -Force
Write-Output 'Physical PvP QA services and adb reverse bridge stopped.'
