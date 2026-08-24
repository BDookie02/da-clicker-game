param([string]$Serial = '')

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$runtimeDir = Join-Path $root 'devlog\physical-pvp-qa'
$persistDir = Join-Path $root '.wrangler\physical-pvp-qa'
$runtimeFile = Join-Path $runtimeDir 'runtime.json'
$holdOpenFile = Join-Path $runtimeDir 'hold-open'
$qaVarsFile = Join-Path $runtimeDir 'worker.qa.env'
$workerPort = 8787
$webPort = 4173
$expectedTestApiUrl = "http://127.0.0.1:$workerPort"
$packageName = 'com.nosiah.discipline.test'
$component = "$packageName/com.nosiah.discipline.MainActivity"
$priorViteApiUrlExists = Test-Path Env:VITE_API_URL
$priorViteApiUrl = $env:VITE_API_URL

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    & $Command
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

function Get-AdbSerialFromDeviceRow {
    param([Parameter(Mandatory = $true)][string]$Row)
    $match = [regex]::Match($Row, '^(?<serial>.+?)\s+device(?:\s|$)')
    if (-not $match.Success) { return $null }
    return $match.Groups['serial'].Value
}

function Remove-AdbReverseIfPresent {
    param(
        [Parameter(Mandatory = $true)][string]$DeviceSerial,
        [Parameter(Mandatory = $true)][int]$Port
    )
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & $adb -s $DeviceSerial reverse --remove "tcp:$Port" 2>$null | Out-Null
    }
    finally {
        $ErrorActionPreference = $savedErrorActionPreference
        $global:LASTEXITCODE = 0
    }
}

function Resolve-AdbSerial {
    param([string]$RequestedSerial)
    $rows = @(& $adb devices -l | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice(?:\s|$)' })
    $serials = @(
        foreach ($row in $rows) {
            $parsed = Get-AdbSerialFromDeviceRow -Row ([string]$row)
            if ($parsed) { $parsed }
        }
    )
    if ($RequestedSerial) {
        if (-not ($serials | Where-Object { $_ -ceq $RequestedSerial })) {
            throw "Android device '$RequestedSerial' is not connected and authorized."
        }
        return $RequestedSerial
    }
    if ($serials.Count -ne 1) {
        throw "Expected exactly one connected Android device; found $($serials.Count). Pass -Serial when more than one is connected."
    }
    return $serials[0]
}

function Wait-HttpJson {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][scriptblock]$Validate,
        [System.Diagnostics.Process[]]$Processes = @(),
        [int]$TimeoutSeconds = 45
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($process in $Processes) {
            $process.Refresh()
            if ($process.HasExited) {
                throw "QA helper process $($process.Id) exited before $Url became ready."
            }
        }
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if (& $Validate $response) { return $response }
            $lastError = "Unexpected response: $($response | ConvertTo-Json -Compress)"
        }
        catch { $lastError = $_.Exception.Message }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $Url. Last result: $lastError"
}

function Start-HiddenLoggedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$Stdout,
        [Parameter(Mandatory = $true)][string]$Stderr
    )
    return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr
}

if (-not (Test-Path -LiteralPath $adb)) {
    throw "Android adb was not found at $adb"
}

New-Item -ItemType Directory -Force -Path $runtimeDir, $persistDir | Out-Null

Push-Location $root
try {
    if (Test-Path -LiteralPath $runtimeFile) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot 'stop-physical-pvp-qa.ps1')
        if ($LASTEXITCODE -ne 0) {
            throw 'The prior recorded physical PvP QA runtime could not be stopped safely.'
        }
    }
    foreach ($port in @($workerPort, $webPort)) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($listener) {
            throw "TCP port $port is already occupied by PID $($listener.OwningProcess); refusing to certify a stale service."
        }
    }

    $Serial = Resolve-AdbSerial $Serial

    # Pin the physical-QA app and desktop client to the same local Worker.
    # Do not rely on an ignored developer env file that may be missing or stale.
    $env:VITE_API_URL = $expectedTestApiUrl

    # Always build from the current source. The underlying builder validates
    # the package, manifest, debug signer, source fingerprint, inputs, payload,
    # exported hash, and provenance before it prints this exact artifact path.
    # The exact builder intentionally surfaces Git warnings on stderr. Capture
    # them in the evidence log, but judge the native process by its exit code
    # instead of letting PowerShell 5 turn a harmless stderr line into a
    # terminating NativeCommandError under this script's fail-fast policy.
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $buildOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $PSScriptRoot 'build-test-apk.ps1') 2>&1)
        $buildExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    $buildOutput | Set-Content -LiteralPath (Join-Path $runtimeDir 'build.log') -Encoding UTF8
    if ($buildExitCode -ne 0) { throw 'Exact physical-device test APK build failed.' }
    $readyLine = $buildOutput | Where-Object { $_ -match '^EXACT TEST APK READY .*?:\s*(.+\.apk)$' } |
        Select-Object -Last 1
    if (-not $readyLine) { throw 'Build succeeded but did not report its verified APK path.' }
    $ApkPath = [regex]::Match([string]$readyLine, '^EXACT TEST APK READY .*?:\s*(.+\.apk)$').Groups[1].Value.Trim()

    $ApkPath = [IO.Path]::GetFullPath($ApkPath)
    if (-not (Test-Path -LiteralPath $ApkPath)) { throw "Verified test APK does not exist: $ApkPath" }
    if (-not $ApkPath.StartsWith([IO.Path]::GetFullPath((Join-Path $root 'artifacts\android-test')), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing an APK outside the verified test artifact directory: $ApkPath"
    }

    # Apply every checked-in migration to the same persisted local D1 instance
    # that Wrangler dev will bind. This is required before readiness can pass.
    Invoke-NativeChecked 'Local D1 migrations failed.' {
        & npx.cmd -y wrangler@4.125.0 d1 migrations apply discipline-db `
            --local --persist-to $persistDir
    }

    $workerOut = Join-Path $runtimeDir 'worker.stdout.log'
    $workerErr = Join-Path $runtimeDir 'worker.stderr.log'
    $webOut = Join-Path $runtimeDir 'web.stdout.log'
    $webErr = Join-Path $runtimeDir 'web.stderr.log'
    Remove-Item -LiteralPath $workerOut, $workerErr, $webOut, $webErr -Force -ErrorAction SilentlyContinue

    # Registration shares the referral abuse-prevention key registry. Give the
    # isolated QA Worker deterministic, test-only material so a persisted QA
    # D1 remains usable across restarts without reading or copying production
    # secrets. This file lives under the ignored physical-QA evidence folder.
    @(
        'REFERRAL_EVIDENCE_HMAC_KEYRING_JSON={"current":"physical-qa-v1","keys":{"physical-qa-v1":"physical-pvp-qa-hmac-key-material-v1-not-for-production"}}'
        'REFERRAL_EVIDENCE_REPLAY_PEPPER=physical-pvp-qa-permanent-replay-pepper-v1-not-for-production'
    ) | Set-Content -LiteralPath $qaVarsFile -Encoding UTF8

    $reverseInstalled = $false
    $worker = Start-HiddenLoggedProcess -FilePath 'npx.cmd' -ArgumentList @(
        '-y', 'wrangler@4.125.0', 'dev', '--local', '--port', [string]$workerPort,
        '--persist-to', $persistDir, '--env-file', $qaVarsFile
    ) -Stdout $workerOut -Stderr $workerErr
    $web = Start-HiddenLoggedProcess -FilePath 'npm.cmd' -ArgumentList @(
        'run', 'dev', '--', '--mode', 'test', '--host', '127.0.0.1',
        '--port', [string]$webPort, '--strictPort'
    ) -Stdout $webOut -Stderr $webErr

    try {
        $readiness = Wait-HttpJson -Url "http://127.0.0.1:$workerPort/v1/pvp/readiness" `
            -Validate { param($body) $body.ready -eq $true } -Processes @($worker)
        $legal = Wait-HttpJson -Url "http://127.0.0.1:$workerPort/v1/legal" `
            -Validate { param($body) $body.ready -eq $true } -Processes @($worker)
        # Readiness alone can miss a referral-key failure on the authenticated
        # path. Create one disposable account through the same public endpoint
        # the phone and desktop clients will use before certifying the runtime.
        $smokeUsername = 'Qa' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
        $registration = Invoke-RestMethod -Uri "http://127.0.0.1:$workerPort/v1/auth/register" `
            -Method Post -ContentType 'application/json' -Body (@{
                username = $smokeUsername
                password = 'PhysicalQaOnly-DoNotReuse-2026'
                acceptTerms = $true
                termsVersion = [string]$legal.termsVersion
            } | ConvertTo-Json -Compress) -TimeoutSec 10
        if ($registration.ok -ne $true -or -not $registration.token) {
            throw 'Local Worker registration smoke failed; physical clients would be unable to create QA accounts.'
        }
        Wait-HttpJson -Url "http://127.0.0.1:$webPort" `
            -Validate { param($body) $null -ne $body } -Processes @($worker, $web) | Out-Null
        foreach ($process in @($worker, $web)) {
            $process.Refresh()
            if ($process.HasExited) {
                throw "QA helper process $($process.Id) exited after readiness; refusing a stale-listener false positive."
            }
        }

        Remove-AdbReverseIfPresent -DeviceSerial $Serial -Port $workerPort
        Invoke-NativeChecked 'Could not bridge the physical app to the local Worker.' {
            & $adb -s $Serial reverse "tcp:$workerPort" "tcp:$workerPort"
        }
        $reverseInstalled = $true
        $reverse = @(& $adb -s $Serial reverse --list)
        if (-not ($reverse | Where-Object { $_ -match "tcp:$workerPort\s+tcp:$workerPort" })) {
            throw "adb reverse did not retain tcp:$workerPort -> tcp:$workerPort for $Serial"
        }

        Invoke-NativeChecked 'Verified test APK installation failed.' {
            & $adb -s $Serial install -r $ApkPath
        }
        & $adb -s $Serial shell am force-stop $packageName | Out-Null
        Invoke-NativeChecked 'DISCIPLINE test app did not launch.' {
            & $adb -s $Serial shell am start -n $component
        }

        $runtime = [ordered]@{
            startedAtUtc = [DateTime]::UtcNow.ToString('o')
            serial = $Serial
            package = $packageName
            apk = $ApkPath
            worker = [ordered]@{
                pid = $worker.Id
                startedAtUtc = $worker.StartTime.ToUniversalTime().ToString('o')
                url = "http://127.0.0.1:$workerPort"
                stdout = $workerOut
                stderr = $workerErr
                ready = $readiness.ready
            }
            desktopClient = [ordered]@{
                pid = $web.Id
                startedAtUtc = $web.StartTime.ToUniversalTime().ToString('o')
                url = "http://127.0.0.1:$webPort"
                stdout = $webOut
                stderr = $webErr
            }
            legalReady = $legal.ready
            registrationSmoke = [ordered]@{
                ok = $true
                username = $smokeUsername
            }
            adbReverse = @($reverse)
        }
        $runtime | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $runtimeFile -Encoding UTF8

        Write-Output "PHYSICAL PVP QA READY"
        Write-Output "Device: $Serial"
        Write-Output "APK: $ApkPath"
        Write-Output "Worker: http://127.0.0.1:$workerPort (D1 + QuickDrawRoom ready)"
        Write-Output "Desktop second client: http://127.0.0.1:$webPort"
        Write-Output "Runtime evidence: $runtimeFile"
        # Unified/agent terminals may terminate detached descendants as soon as
        # this launcher exits. A caller-created sentinel keeps the launcher and
        # both helpers in one monitored lifetime for hands-on physical QA. The
        # ordinary command remains nonblocking when the sentinel is absent.
        while (Test-Path -LiteralPath $holdOpenFile) {
            foreach ($process in @($worker, $web)) {
                $process.Refresh()
                if ($process.HasExited) {
                    throw "QA helper process $($process.Id) exited while physical QA was active."
                }
            }
            Start-Sleep -Seconds 1
        }
    }
    catch {
        if ($reverseInstalled) {
            Remove-AdbReverseIfPresent -DeviceSerial $Serial -Port $workerPort
        }
        foreach ($process in @($worker, $web)) {
            if ($process -and -not $process.HasExited) {
                & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
            }
        }
        throw
    }
}
finally {
    Pop-Location
    if ($priorViteApiUrlExists) {
        $env:VITE_API_URL = $priorViteApiUrl
    }
    else {
        Remove-Item Env:VITE_API_URL -ErrorAction SilentlyContinue
    }
}
