$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$javaHome = 'C:\Program Files\Android\Android Studio\jbr'
$androidNamespace = 'http://schemas.android.com/apk/res/android'
$expectedPackage = 'com.nosiah.discipline'
$expectedMinSdk = '24'
$expectedTargetSdk = '36'
$expectedTestAdMobAppId = 'ca-app-pub-3940256099942544~3347511713'

if (-not (Test-Path -LiteralPath $javaHome)) {
    throw "Android Studio Java runtime was not found at $javaHome"
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    & $Command
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

function Get-StringSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $sha.Dispose()
    }
}

function Get-OptionalFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Get-BuildInputSnapshot {
    $files = [ordered]@{}
    foreach ($relativePath in @(
        'package-lock.json',
        '.env',
        '.env.local',
        '.env.test',
        '.env.test.local',
        'android\private-release.properties'
    )) {
        $files[$relativePath.Replace('\', '/')] = Get-OptionalFileSha256 (Join-Path $root $relativePath)
    }
    $viteEnvironment = [ordered]@{}
    foreach ($entry in Get-ChildItem Env: | Where-Object { $_.Name.StartsWith('VITE_') } | Sort-Object Name) {
        $viteEnvironment[$entry.Name] = $entry.Value
    }
    $identity = [ordered]@{
        files = $files
        viteEnvironmentSha256 = Get-StringSha256 ($viteEnvironment | ConvertTo-Json -Compress)
    }
    return [ordered]@{
        identity = $identity
        fingerprintSha256 = Get-StringSha256 ($identity | ConvertTo-Json -Depth 5 -Compress)
    }
}

function Get-SourceSnapshot {
    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $head) { throw 'Could not read the Git HEAD.' }
    $branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Git branch.' }
    $statusLines = @(& git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Git working-tree status.' }
    $trackedDiffHash = ((& git diff --binary HEAD --no-ext-diff | & git hash-object --stdin) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $trackedDiffHash) { throw 'Could not fingerprint tracked source changes.' }

    $untracked = @()
    foreach ($relativePath in @(& git ls-files --others --exclude-standard)) {
        if (-not $relativePath) { continue }
        $objectHash = (& git hash-object -- $relativePath).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $objectHash) {
            throw "Could not fingerprint untracked source file: $relativePath"
        }
        $untracked += [ordered]@{ path = $relativePath; gitObject = $objectHash }
    }

    $identity = [ordered]@{
        head = $head
        branch = $branch
        dirty = ($statusLines.Count -gt 0)
        status = $statusLines
        trackedDiffGitObject = $trackedDiffHash
        untracked = $untracked
    }
    return [ordered]@{
        identity = $identity
        fingerprintSha256 = Get-StringSha256 ($identity | ConvertTo-Json -Depth 8 -Compress)
    }
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [AllowEmptyString()][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    if ($Actual -cne $Expected) {
        throw "Built test APK $Label mismatch: expected '$Expected', found '$Actual'"
    }
}

Push-Location $root
try {
    $initialSource = Get-SourceSnapshot
    $initialInputs = Get-BuildInputSnapshot
    $initialPackageLockHash = Get-OptionalFileSha256 (Join-Path $root 'package-lock.json')
    if (-not $initialPackageLockHash) { throw 'package-lock.json is required for an exact test APK.' }

    # This installs the exact lockfile and reapplies the reviewed native
    # purchase patch. It never stashes, resets, cleans, commits, or publishes.
    Invoke-NativeChecked 'Reproducible npm install failed.' { cmd /c npm ci --no-audit --no-fund }
    if ((Get-OptionalFileSha256 (Join-Path $root 'package-lock.json')) -ne $initialPackageLockHash) {
        throw 'npm ci unexpectedly changed package-lock.json; test APK build stopped.'
    }

    Invoke-NativeChecked 'Tests failed.' { cmd /c npm test }
    Invoke-NativeChecked 'Dependency security audit failed.' { cmd /c npm audit --audit-level=high }
    Invoke-NativeChecked 'Test web build failed.' { cmd /c npm run build:test }
    Invoke-NativeChecked 'Capacitor Android sync failed.' { cmd /c npx cap sync android }

    $payloadJson = & node scripts/verify-android-test-assets.mjs --json
    if ($LASTEXITCODE -ne 0) { throw 'Android test payload verification failed.' }
    $payload = $payloadJson | ConvertFrom-Json

    $env:JAVA_HOME = $javaHome
    Push-Location (Join-Path $root 'android')
    try {
        Invoke-NativeChecked 'Android debug lint/APK build failed.' {
            .\gradlew.bat clean :app:lintDebug :app:assembleDebug --console=plain
        }
    }
    finally {
        Pop-Location
    }

    $apkOutputDir = Join-Path $root 'android\app\build\outputs\apk\debug'
    $outputMetadataFile = Join-Path $apkOutputDir 'output-metadata.json'
    if (-not (Test-Path -LiteralPath $outputMetadataFile)) {
        throw 'Gradle did not produce debug APK output metadata.'
    }
    $outputMetadata = Get-Content -LiteralPath $outputMetadataFile -Raw | ConvertFrom-Json
    Assert-Equal 'output applicationId' $outputMetadata.applicationId $expectedPackage
    Assert-Equal 'output variant' $outputMetadata.variantName 'debug'
    $apkElement = @($outputMetadata.elements) | Where-Object { $_.outputFile -eq 'app-debug.apk' } | Select-Object -First 1
    if (-not $apkElement) { throw 'Gradle output metadata did not identify app-debug.apk.' }
    $apk = Join-Path $apkOutputDir $apkElement.outputFile
    if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle did not produce app-debug.apk.' }

    $androidSdk = if ($env:ANDROID_SDK_ROOT) {
        $env:ANDROID_SDK_ROOT
    } else {
        Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    }
    $apkanalyzer = Join-Path $androidSdk 'cmdline-tools\latest\bin\apkanalyzer.bat'
    if (-not (Test-Path -LiteralPath $apkanalyzer)) {
        throw "Android SDK apkanalyzer was not found at $apkanalyzer"
    }
    $verificationDir = Join-Path $apkOutputDir 'verification'
    New-Item -ItemType Directory -Force -Path $verificationDir | Out-Null
    $manifestDump = Join-Path $verificationDir 'AndroidManifest.xml'
    Invoke-NativeChecked 'apkanalyzer could not decode the built test APK manifest.' {
        & $apkanalyzer manifest print $apk > $manifestDump
    }

    [xml]$manifest = Get-Content -LiteralPath $manifestDump -Raw
    $manifestNode = $manifest.DocumentElement
    $usesSdk = $manifest.SelectSingleNode('/manifest/uses-sdk')
    $application = $manifest.SelectSingleNode('/manifest/application')
    if (-not $manifestNode -or -not $usesSdk -or -not $application) {
        throw 'apkanalyzer returned an incomplete APK manifest.'
    }
    Assert-Equal 'package' $manifestNode.GetAttribute('package') $expectedPackage
    Assert-Equal 'versionCode' $manifestNode.GetAttribute('versionCode', $androidNamespace) ([string]$apkElement.versionCode)
    Assert-Equal 'versionName' $manifestNode.GetAttribute('versionName', $androidNamespace) ([string]$apkElement.versionName)
    Assert-Equal 'minSdkVersion' $usesSdk.GetAttribute('minSdkVersion', $androidNamespace) $expectedMinSdk
    Assert-Equal 'targetSdkVersion' $usesSdk.GetAttribute('targetSdkVersion', $androidNamespace) $expectedTargetSdk
    Assert-Equal 'debuggable flag' $application.GetAttribute('debuggable', $androidNamespace) 'true'

    $metadata = @{}
    foreach ($node in $application.SelectNodes('meta-data')) {
        $metadata[$node.GetAttribute('name', $androidNamespace)] = $node.GetAttribute('value', $androidNamespace)
    }
    Assert-Equal 'AdMob application ID' $metadata['com.google.android.gms.ads.APPLICATION_ID'] $expectedTestAdMobAppId

    $buildTools = Get-ChildItem (Join-Path $androidSdk 'build-tools') -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending
    $apksigner = $buildTools | ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $apksigner) { throw 'Android SDK apksigner was not found.' }
    $signatureDump = Join-Path $verificationDir 'signature.txt'
    Invoke-NativeChecked 'Debug APK signature verification failed.' {
        & $apksigner verify --verbose --print-certs $apk > $signatureDump
    }
    $signatureText = Get-Content -LiteralPath $signatureDump -Raw
    $signerDn = [regex]::Match(
        $signatureText,
        '(?m)^Signer #1 certificate DN:\s*([^\r\n]+)'
    ).Groups[1].Value.Trim()
    $signerSha256 = [regex]::Match(
        $signatureText,
        '(?m)^Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\r?$'
    ).Groups[1].Value.ToUpperInvariant()
    $debugKeystore = Join-Path $env:USERPROFILE '.android\debug.keystore'
    $keytool = Join-Path $javaHome 'bin\keytool.exe'
    if (-not (Test-Path -LiteralPath $debugKeystore) -or -not (Test-Path -LiteralPath $keytool)) {
        throw 'The standard Android debug keystore or Android Studio keytool is missing.'
    }
    $debugCertificate = Join-Path $verificationDir 'android-debug-certificate.der'
    Invoke-NativeChecked 'Could not export the standard Android debug certificate.' {
        & $keytool -exportcert -alias androiddebugkey -keystore $debugKeystore `
            -storepass android -keypass android -file $debugCertificate | Out-Null
    }
    $debugCertificateSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $debugCertificate).Hash
    if (($signerDn -notmatch 'CN=Android Debug(?:,|$)') -or
        ($signerSha256 -notmatch '^[0-9A-F]{64}$') -or
        ($signerSha256 -cne $debugCertificateSha256)) {
        throw 'Test APK is not signed by the standard Android debug certificate; refusing possible release-key output.'
    }

    $finalSource = Get-SourceSnapshot
    if ($finalSource.fingerprintSha256 -ne $initialSource.fingerprintSha256) {
        throw 'The Git source state changed while the test APK was building. No artifact was exported; rerun from a stable working tree.'
    }
    $finalInputs = Get-BuildInputSnapshot
    if ($finalInputs.fingerprintSha256 -ne $initialInputs.fingerprintSha256) {
        throw 'A build input changed while the test APK was building. No artifact was exported; rerun with stable environment/configuration.'
    }

    $apkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apk).Hash
    $shortHead = $initialSource.identity.head.Substring(0, 12).ToLowerInvariant()
    $shortSource = $initialSource.fingerprintSha256.Substring(0, 16).ToLowerInvariant()
    $shortApk = $apkHash.Substring(0, 16).ToLowerInvariant()
    $artifactDir = [IO.Path]::GetFullPath((Join-Path $root 'artifacts\android-test'))
    $allowedArtifactsRoot = [IO.Path]::GetFullPath((Join-Path $root 'artifacts'))
    if (-not $artifactDir.StartsWith($allowedArtifactsRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unexpected artifact path: $artifactDir"
    }
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
    $artifactBase = "DISCIPLINE-test-$shortHead-$shortSource-$shortApk"
    $artifactApk = Join-Path $artifactDir "$artifactBase.apk"
    Copy-Item -LiteralPath $apk -Destination $artifactApk -Force
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $artifactApk).Hash -ne $apkHash) {
        throw 'Exported test APK is not byte-identical to Gradle output.'
    }

    $provenance = [ordered]@{
        schemaVersion = 1
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        purpose = 'Android physical-device/emulator test only'
        publishable = $false
        buildVariant = 'debug'
        artifact = [ordered]@{
            fileName = "$artifactBase.apk"
            sha256 = $apkHash
        }
        source = [ordered]@{
            head = $initialSource.identity.head
            branch = $initialSource.identity.branch
            dirty = $initialSource.identity.dirty
            status = $initialSource.identity.status
            fingerprintSha256 = $initialSource.fingerprintSha256
            trackedDiffGitObject = $initialSource.identity.trackedDiffGitObject
            untracked = $initialSource.identity.untracked
        }
        inputs = [ordered]@{
            fingerprintSha256 = $initialInputs.fingerprintSha256
            files = $initialInputs.identity.files
            viteEnvironmentSha256 = $initialInputs.identity.viteEnvironmentSha256
        }
        webPayload = [ordered]@{
            treeSha256 = $payload.treeSha256
            fileCount = $payload.fileCount
            visualAudit = $payload.visualAudit
            admobTesting = $payload.admobTesting
            rewardedAdUnitId = $payload.rewardedAdUnitId
        }
        android = [ordered]@{
            package = $manifestNode.GetAttribute('package')
            versionCode = $manifestNode.GetAttribute('versionCode', $androidNamespace)
            versionName = $manifestNode.GetAttribute('versionName', $androidNamespace)
            minSdkVersion = $usesSdk.GetAttribute('minSdkVersion', $androidNamespace)
            targetSdkVersion = $usesSdk.GetAttribute('targetSdkVersion', $androidNamespace)
            debuggable = $true
            admobAppId = $metadata['com.google.android.gms.ads.APPLICATION_ID']
            signerCertificateDn = $signerDn
            signerCertificateSha256 = $signerSha256
        }
        tools = [ordered]@{
            node = (& node --version).Trim()
            npm = (cmd /c npm --version).Trim()
            apkanalyzer = $apkanalyzer
            apksigner = $apksigner
        }
    }
    $provenanceFile = Join-Path $artifactDir "$artifactBase.provenance.json"
    $shaFile = Join-Path $artifactDir "$artifactBase.sha256"
    $provenance | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $provenanceFile -Encoding UTF8
    "$apkHash  $artifactBase.apk" | Set-Content -LiteralPath $shaFile -Encoding ASCII

    Write-Output "EXACT TEST APK READY (debug only, not published): $artifactApk"
    Write-Output "SHA-256: $apkHash"
    Write-Output "Source HEAD: $($initialSource.identity.head)"
    Write-Output "Source dirty: $($initialSource.identity.dirty)"
    Write-Output "Source fingerprint: $($initialSource.fingerprintSha256)"
    Write-Output "Provenance: $provenanceFile"
}
finally {
    Pop-Location
}
