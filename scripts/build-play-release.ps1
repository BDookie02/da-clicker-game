param(
    [switch]$ClosedAlphaWithGoogleDemoAds
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$javaHome = 'C:\Program Files\Android\Android Studio\jbr'
$androidNamespace = 'http://schemas.android.com/apk/res/android'
$bundletoolVersion = '1.18.3'
$bundletoolSha256 = 'A099CFA1543F55593BC2ED16A70A7C67FE54B1747BB7301F37FDFD6D91028E29'
$gradleDistributionSha256 = 'ED1A8D686605FD7C23BDF62C7FC7ADD1C5B23B2BBC3721E661934EF4A4911D7C'
$closedAlphaRewardedId = 'ca-app-pub-3940256099942544/5224354917'
$closedAlphaInterstitialId = 'ca-app-pub-3940256099942544/1033173712'

if ($ClosedAlphaWithGoogleDemoAds) {
    throw 'Google demo ad units cannot be uploaded to a Play track: they cannot credit the production SSV reward ledger. Use the default production-ad release path.'
}

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

function Read-KeyValueFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) { continue }
        $values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1).Trim()
    }
    return $values
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
    $identityJson = $identity | ConvertTo-Json -Depth 8 -Compress
    return [ordered]@{
        identity = $identity
        fingerprintSha256 = Get-StringSha256 $identityJson
    }
}

function Get-VerifiedBundletool {
    $cacheRoot = Join-Path $env:LOCALAPPDATA 'DisciplineClicker\build-tools'
    $cacheRoot = [IO.Path]::GetFullPath($cacheRoot)
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'DisciplineClicker'))
    if (-not $cacheRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unexpected bundletool cache path: $cacheRoot"
    }
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    $jar = Join-Path $cacheRoot "bundletool-all-$bundletoolVersion.jar"
    $download = "$jar.download"

    if (Test-Path -LiteralPath $jar) {
        $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $jar).Hash
        if ($existingHash -eq $bundletoolSha256) { return $jar }
        Remove-Item -LiteralPath $jar -Force
    }
    if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }

    $url = "https://github.com/google/bundletool/releases/download/$bundletoolVersion/bundletool-all-$bundletoolVersion.jar"
    Invoke-WebRequest -Uri $url -OutFile $download
    $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash
    if ($downloadHash -ne $bundletoolSha256) {
        Remove-Item -LiteralPath $download -Force
        throw "Downloaded bundletool checksum mismatch: expected $bundletoolSha256, found $downloadHash"
    }
    Move-Item -LiteralPath $download -Destination $jar
    return $jar
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [AllowEmptyString()][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    if ($Actual -cne $Expected) {
        throw "Built AAB $Label mismatch: expected '$Expected', found '$Actual'"
    }
}

function Get-ProductionWebValues {
    $values = @{}
    foreach ($relativePath in @('.env', '.env.local', '.env.production', '.env.production.local')) {
        $fromFile = Read-KeyValueFile (Join-Path $root $relativePath)
        foreach ($key in $fromFile.Keys) { $values[$key] = $fromFile[$key] }
    }
    foreach ($name in @(
        'VITE_API_URL',
        'VITE_PLAY_GAMES_LEADERBOARD_ID',
        'VITE_GAME_CENTER_LEADERBOARD_ID'
    )) {
        $fromProcess = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $fromProcess) { $values[$name] = $fromProcess }
    }
    return $values
}

function Invoke-ClosedAlphaWebBuild {
    $productionValues = Get-ProductionWebValues
    $apiUrl = [string]$productionValues.VITE_API_URL
    $leaderboardId = [string]$productionValues.VITE_PLAY_GAMES_LEADERBOARD_ID
    if ($apiUrl -notmatch '^https://') {
        throw 'Closed Alpha requires the real HTTPS VITE_API_URL from the production configuration.'
    }
    if ($leaderboardId -notmatch '^CgkI') {
        throw 'Closed Alpha requires the real VITE_PLAY_GAMES_LEADERBOARD_ID from the production configuration.'
    }

    $overrides = [ordered]@{
        VITE_VISUAL_AUDIT = 'false'
        VITE_ADMOB_TESTING = 'true'
        VITE_ADMOB_ANDROID_REWARDED_ID = $null
        VITE_ADMOB_ANDROID_INTERSTITIAL_ID = $null
        VITE_ADMOB_IOS_REWARDED_ID = $null
        VITE_ADMOB_IOS_INTERSTITIAL_ID = $null
        VITE_API_URL = $apiUrl
        VITE_PLAY_GAMES_LEADERBOARD_ID = $leaderboardId
        VITE_GAME_CENTER_LEADERBOARD_ID = [string]$productionValues.VITE_GAME_CENTER_LEADERBOARD_ID
    }
    $previous = @{}
    foreach ($name in $overrides.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        foreach ($name in $overrides.Keys) {
            [Environment]::SetEnvironmentVariable($name, $overrides[$name], 'Process')
        }
        Invoke-NativeChecked 'Closed Alpha web build failed.' {
            cmd /c "npx tsc --noEmit && npx vite build --mode closed-alpha"
        }
        Invoke-NativeChecked 'Capacitor Android sync failed.' { cmd /c npx cap sync android }
        Invoke-NativeChecked 'Closed Alpha Android web payload verification failed.' {
            node scripts/verify-android-closed-alpha-assets.mjs
        }
    }
    finally {
        foreach ($name in $overrides.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
        }
    }
}

Push-Location $root
try {
    $initialSource = Get-SourceSnapshot
    $initialPackageLockHash = Get-OptionalFileSha256 (Join-Path $root 'package-lock.json')
    if (-not $initialPackageLockHash) { throw 'package-lock.json is required for a reproducible release install.' }

    # npm ci installs the exact lockfile without rewriting it. This script
    # never stashes, resets, cleans, commits, or otherwise discards user work.
    Invoke-NativeChecked 'Reproducible npm install failed.' { cmd /c npm ci --no-audit --no-fund }
    $installedPackageLockHash = Get-OptionalFileSha256 (Join-Path $root 'package-lock.json')
    if ($installedPackageLockHash -ne $initialPackageLockHash) {
        throw 'npm ci unexpectedly changed package-lock.json; release build stopped.'
    }

    Invoke-NativeChecked 'Tests failed.' { cmd /c npm test }
    Invoke-NativeChecked 'Dependency security audit failed.' { cmd /c npm audit --audit-level=high }
    Invoke-NativeChecked 'Release bundle preflight failed.' { cmd /c npm run release:bundle-check }
    if ($ClosedAlphaWithGoogleDemoAds) {
        Invoke-ClosedAlphaWebBuild
    }
    else {
        Invoke-NativeChecked 'Production web build failed.' { cmd /c npm run build }
        Invoke-NativeChecked 'Capacitor Android sync failed.' { cmd /c npx cap sync android }
        Invoke-NativeChecked 'Packaged Android web payload verification failed.' {
            node scripts/verify-android-release-assets.mjs
        }
    }

    $env:JAVA_HOME = $javaHome
    Push-Location (Join-Path $root 'android')
    try {
        Invoke-NativeChecked 'Android release build failed.' {
            .\gradlew.bat clean :app:lintRelease :app:bundleRelease --console=plain
        }
    }
    finally {
        Pop-Location
    }

    $aab = Join-Path $root 'android\app\build\outputs\bundle\release\app-release.aab'
    if (-not (Test-Path -LiteralPath $aab)) { throw 'Gradle did not produce app-release.aab.' }

    $bundletool = Get-VerifiedBundletool
    $java = Join-Path $javaHome 'bin\java.exe'
    $verificationDir = Join-Path $root 'android\app\build\outputs\bundle\release\verification'
    New-Item -ItemType Directory -Force -Path $verificationDir | Out-Null
    $manifestDump = Join-Path $verificationDir 'AndroidManifest.xml'
    Invoke-NativeChecked 'bundletool could not dump the built AAB manifest.' {
        & $java -jar $bundletool dump manifest "--bundle=$aab" --module=base > $manifestDump
    }

    [xml]$manifest = Get-Content -LiteralPath $manifestDump -Raw
    $manifestNode = $manifest.DocumentElement
    $usesSdk = $manifest.SelectSingleNode('/manifest/uses-sdk')
    $application = $manifest.SelectSingleNode('/manifest/application')
    if (-not $manifestNode -or -not $usesSdk -or -not $application) {
        throw 'bundletool returned an incomplete AAB manifest.'
    }

    $releaseProperties = Read-KeyValueFile (Join-Path $root 'android\private-release.properties')
    Assert-Equal 'package' $manifestNode.GetAttribute('package') 'com.nosiah.discipline'
    Assert-Equal 'versionCode' $manifestNode.GetAttribute('versionCode', $androidNamespace) $releaseProperties.VERSION_CODE
    Assert-Equal 'versionName' $manifestNode.GetAttribute('versionName', $androidNamespace) $releaseProperties.VERSION_NAME
    Assert-Equal 'minSdkVersion' $usesSdk.GetAttribute('minSdkVersion', $androidNamespace) '29'
    Assert-Equal 'targetSdkVersion' $usesSdk.GetAttribute('targetSdkVersion', $androidNamespace) '36'

    $metadata = @{}
    foreach ($node in $application.SelectNodes('meta-data')) {
        $metadata[$node.GetAttribute('name', $androidNamespace)] = $node.GetAttribute('value', $androidNamespace)
    }
    Assert-Equal 'AdMob application ID' $metadata['com.google.android.gms.ads.APPLICATION_ID'] $releaseProperties.ADMOB_ANDROID_APP_ID
    Assert-Equal 'Play Games metadata reference' $metadata['com.google.android.gms.games.APP_ID'] '@string/game_services_project_id'

    $gameServicesDump = Join-Path $verificationDir 'game-services-project-id.txt'
    Invoke-NativeChecked 'bundletool could not dump the Play Games app-ID resource.' {
        & $java -jar $bundletool dump resources "--bundle=$aab" --resource=string/game_services_project_id --values > $gameServicesDump
    }
    $gameServicesText = Get-Content -LiteralPath $gameServicesDump -Raw
    if ($gameServicesText -notmatch [regex]::Escape($releaseProperties.PLAY_GAMES_APP_ID)) {
        throw 'Built AAB Play Games app-ID resource does not match android/private-release.properties.'
    }

    # Android upload certificates are normally self-signed. `-strict` treats
    # that expected certificate-chain warning as an error, so verify archive
    # signature integrity without requiring a public-CA chain.
    $signatureLog = Join-Path $verificationDir 'jarsigner-verification.txt'
    Invoke-NativeChecked 'AAB signature verification failed.' {
        & (Join-Path $javaHome 'bin\jarsigner.exe') -verify $aab *> $signatureLog
    }

    $finalSource = Get-SourceSnapshot
    if ($finalSource.fingerprintSha256 -ne $initialSource.fingerprintSha256) {
        throw 'The Git source state changed while the AAB was building. The artifact is not declared release-ready; rerun from a stable working tree.'
    }

    $aabHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $aab).Hash
    $artifactRelativePath = 'android/app/build/outputs/bundle/release/app-release.aab'
    if ($ClosedAlphaWithGoogleDemoAds) {
        $artifactDir = Join-Path $root 'artifacts\android-closed-alpha'
        New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
        $safeVersionName = $releaseProperties.VERSION_NAME -replace '[^0-9A-Za-z._-]', '-'
        $artifactName = "DISCIPLINE-closed-alpha-v$($safeVersionName)-code$($releaseProperties.VERSION_CODE)-$($aabHash.Substring(0, 12)).aab"
        $closedAlphaAab = Join-Path $artifactDir $artifactName
        Copy-Item -LiteralPath $aab -Destination $closedAlphaAab -Force
        Remove-Item -LiteralPath $aab -Force
        $aab = $closedAlphaAab
        $artifactRelativePath = "artifacts/android-closed-alpha/$artifactName"
    }
    $provenance = [ordered]@{
        schemaVersion = 1
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        distribution = if ($ClosedAlphaWithGoogleDemoAds) { 'play-closed-alpha' } else { 'play-production' }
        productionPromotable = (-not $ClosedAlphaWithGoogleDemoAds)
        artifact = [ordered]@{
            path = $artifactRelativePath
            sha256 = $aabHash
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
            packageLockSha256 = $initialPackageLockHash
            productionEnvSha256 = Get-OptionalFileSha256 (Join-Path $root '.env.production.local')
            androidReleasePropertiesSha256 = Get-OptionalFileSha256 (Join-Path $root 'android\private-release.properties')
            androidKeystorePropertiesSha256 = Get-OptionalFileSha256 (Join-Path $root 'android\keystore.properties')
        }
        android = [ordered]@{
            package = $manifestNode.GetAttribute('package')
            versionCode = $manifestNode.GetAttribute('versionCode', $androidNamespace)
            versionName = $manifestNode.GetAttribute('versionName', $androidNamespace)
            minSdkVersion = $usesSdk.GetAttribute('minSdkVersion', $androidNamespace)
            targetSdkVersion = $usesSdk.GetAttribute('targetSdkVersion', $androidNamespace)
            admobAppId = $metadata['com.google.android.gms.ads.APPLICATION_ID']
            playGamesAppId = $releaseProperties.PLAY_GAMES_APP_ID
        }
        ads = if ($ClosedAlphaWithGoogleDemoAds) {
            [ordered]@{
                testing = $true
                rewardedAdUnitId = $closedAlphaRewardedId
                interstitialAdUnitId = $closedAlphaInterstitialId
            }
        }
        else {
            [ordered]@{ testing = $false }
        }
        tools = [ordered]@{
            node = (& node --version).Trim()
            npm = (& npm --version).Trim()
            bundletool = $bundletoolVersion
            bundletoolSha256 = $bundletoolSha256
            gradleDistributionSha256 = $gradleDistributionSha256
        }
    }
    $provenanceFile = if ($ClosedAlphaWithGoogleDemoAds) {
        "$aab.provenance.json"
    }
    else {
        Join-Path (Split-Path -Parent $aab) 'app-release.provenance.json'
    }
    $provenance | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $provenanceFile -Encoding UTF8

    if ($ClosedAlphaWithGoogleDemoAds) {
        Write-Output "PLAY CLOSED-ALPHA AAB READY WITH GOOGLE DEMO ADS (not uploaded; never promote to production): $aab"
    }
    else {
        Write-Output "PLAY AAB READY (not uploaded): $aab"
    }
    Write-Output "SHA-256: $aabHash"
    Write-Output "Source HEAD: $($initialSource.identity.head)"
    Write-Output "Source dirty: $($initialSource.identity.dirty)"
    Write-Output "Provenance: $provenanceFile"
}
finally {
    Pop-Location
}
