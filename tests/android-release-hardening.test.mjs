import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Android release variants require explicit versions and reject Google sample AdMob IDs', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /releaseVersionCode ==~ \/\[1-9\]\\d\*\//);
  assert.match(gradle, /VERSION_CODE must be explicitly set/);
  assert.match(gradle, /VERSION_NAME must be explicitly set/);
  assert.match(gradle, /googleSampleAdMobPublisher = "3940256099942544"/);
  assert.match(gradle, /missing, invalid, or a Google sample ID/);
  assert.match(gradle, /manifestPlaceholders\.admobAppId = releaseAdMobAppId \?: ""/);
});

test('Play Games is auto-discovered once and splash resources cover Android 10+', () => {
  const activity = read('android/app/src/main/java/com/nosiah/discipline/MainActivity.java');
  const gradle = read('android/app/build.gradle');
  const styles = read('android/app/src/main/res/values/styles.xml');
  assert.doesNotMatch(activity, /registerPlugin\s*\(\s*CapacitorGameConnectPlugin/);
  assert.doesNotMatch(activity, /import com\.openforge\.capacitorgameconnect/);
  assert.match(gradle, /debug\s*\{[\s\S]*game_services_project_id", releasePlayGamesAppId/);
  assert.match(activity, /SplashScreen\.installSplashScreen\(this\)/);
  assert.match(styles, /windowSplashScreenBackground/);
  assert.match(styles, /windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher<\/item>/);
  assert.match(styles, /postSplashScreenTheme">@style\/AppTheme\.NoActionBar<\/item>/);
});

test('Android referral claims require request-bound Play Integrity proof', () => {
  const activity = read('android/app/src/main/java/com/nosiah/discipline/MainActivity.java');
  const plugin = read('android/app/src/main/java/com/nosiah/discipline/PlatformProofPlugin.java');
  const installReferrer = read('android/app/src/main/java/com/nosiah/discipline/InstallReferrerPlugin.java');
  const gradle = read('android/app/build.gradle');
  const referral = read('src/referral.ts');
  const account = read('src/account.ts');
  const main = read('src/main.ts');

  assert.match(gradle, /com\.google\.android\.play:integrity:1\.6\.0/);
  assert.match(gradle, /PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER is missing or invalid/);
  assert.match(gradle, /play_integrity_cloud_project_number/);
  assert.match(activity, /registerPlugin\(PlatformProofPlugin\.class\)/);
  assert.match(plugin, /IntegrityManagerFactory\.createStandard/);
  assert.match(plugin, /PrepareIntegrityTokenRequest\.builder\(\)[\s\S]*setCloudProjectNumber/);
  assert.match(plugin, /StandardIntegrityTokenRequest\.builder\(\)[\s\S]*setRequestHash/);
  assert.match(plugin, /google_play_integrity/);
  assert.match(plugin, /INTEGRITY_TOKEN_PROVIDER_INVALID/);
  assert.match(plugin, /invalidateProvider\(providerTask\)/);
  assert.match(plugin, /play_integrity_transient/);
  assert.doesNotMatch(plugin, /INITIAL_RETRY_DELAY_MS|MAX_RETRY_ATTEMPTS|postDelayed/);
  assert.match(plugin, /NETWORK_ERROR[\s\S]*TOO_MANY_REQUESTS[\s\S]*CLIENT_TRANSIENT_ERROR/);
  assert.match(installReferrer, /AtomicBoolean settled/);
  assert.match(installReferrer, /CONNECTION_TIMEOUT_MS = 15_000L/);
  assert.match(installReferrer, /Handler\(Looper\.getMainLooper\(\)\)/);
  assert.match(installReferrer, /call\.getInt\("timeoutMs", \(int\) CONNECTION_TIMEOUT_MS\)/);
  assert.match(installReferrer, /Math\.max\(250L, Math\.min\(CONNECTION_TIMEOUT_MS, requestedTimeoutMs\)\)/);
  assert.match(installReferrer, /postDelayed\(timeout, timeoutMs\)/);
  assert.match(installReferrer, /removeCallbacks\(timeout\)/);
  assert.match(installReferrer, /install_referrer_timeout/);
  assert.match(installReferrer, /onInstallReferrerServiceDisconnected\(\)[\s\S]*compareAndSet\(false, true\)[\s\S]*install_referrer_disconnected/);
  assert.match(referral, /referral_claim_v1/);
  assert.match(referral, /crypto\.subtle\.digest\([\s\S]*SHA-256/);
  assert.match(referral, /PlatformProof\.get\(\{ requestHash \}\)/);
  assert.match(referral, /InstallReferrer\.get\(\{ timeoutMs: Math\.max\(250, remainingMs - 250\) \}\)/);
  assert.match(referral, /CLIENT_RETRY_DELAYS_MS = \[1_000, 2_000\]/);
  assert.match(referral, /'install_referrer_timeout'/);
  assert.match(referral, /REFERRAL_CLAIM_WALL_CLOCK_TIMEOUT_MS = 20_000/);
  assert.match(referral, /retryReferralClaim/);
  assert.match(referral, /inFlightClaims/);
  assert.match(referral, /localStorage\.setItem\(key, 'claimed'\)[\s\S]*return true/);
  assert.match(referral, /persistTerminalReferralFailure/);
  assert.match(main, /refreshReferralInBackground/);
  assert.doesNotMatch(main, /await claimInstallReferral/);
  assert.match(account, /provider: 'google_play_install_referrer'/);
  assert.match(account, /provider: 'google_play_integrity'/);
  assert.doesNotMatch(referral, /on Google Play\. Install with my verified referral link/);
});

test('physical-device QA scripts default to the isolated tester package', () => {
  assert.match(read('scripts/audit-android-touch-look.mjs'),
    /option\('--package', 'com\.nosiah\.discipline\.test'\)/);
  assert.match(read('scripts/audit-android-tutorial-flow.mjs'),
    /option\('--package', 'com\.nosiah\.discipline\.test'\)/);
});

test('every Android build and release gate preserves the Android 10 floor', () => {
  const variables = read('android/variables.gradle');
  const testBuild = read('scripts/build-test-apk.ps1');
  const releaseBuild = read('scripts/build-play-release.ps1');
  const releaseCheck = read('scripts/release-check.mjs');
  const vite = read('vite.config.ts');
  assert.match(variables, /minSdkVersion = 29/);
  assert.match(testBuild, /\$expectedMinSdk = '29'/);
  assert.match(releaseBuild, /Assert-Equal 'minSdkVersion'[\s\S]*'29'/);
  assert.match(releaseCheck, /minSdkVersion\\s\*=\\s\*29/);
  assert.match(vite, /Chrome >= 74/);
});

test('Android 10 renderer retains a WebGL 1-safe graphics path', () => {
  const pkg = JSON.parse(read('package.json'));
  const scene = read('src/scene.ts');
  assert.equal(pkg.dependencies.three, '0.162.0');
  assert.equal(pkg.devDependencies['@types/three'], '0.162.0');
  assert.match(scene, /extensions\.has\('OES_standard_derivatives'\)/);
  assert.match(scene, /flatShading: this\.supportsDerivativeFlatShading/);
  assert.match(scene, /float bayer4\(vec2 coordinate\)/);
  assert.doesNotMatch(scene, /bayer\[p\.x\]\[p\.y\]/);
  assert.match(scene, /stencil: false/);
});

test('Android compatibility bootstrap uses the browser global directly', () => {
  const compatibility = read('src/compat.ts');
  assert.match(compatibility, /const root = window as Window/);
  assert.doesNotMatch(compatibility, /\bglobalThis\b(?!`)/);
  assert.match(compatibility, /root\.crypto\.getRandomValues/);
  assert.match(compatibility, /Object\.defineProperty\(root\.crypto, 'randomUUID'/);
});

test('release tooling pins Gradle integrity and records exact source provenance', () => {
  const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
  const build = read('scripts/build-play-release.ps1');
  const testBuild = read('scripts/build-test-apk.ps1');
  const sourceGate = read('scripts/assert-clean-release-source.mjs');
  const releaseCheck = read('scripts/release-check.mjs');
  const payloadCheck = read('scripts/verify-android-release-assets.mjs');

  assert.match(wrapper, /distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c/);
  assert.match(build, /npm ci --no-audit --no-fund/);
  const sourceGateCall = build.indexOf('$initialSource = Get-ReleaseSourceSnapshot');
  const dependencyInstall = build.indexOf('npm ci --no-audit --no-fund');
  assert.ok(sourceGateCall >= 0 && sourceGateCall < dependencyInstall,
    'clean committed tagged source must be verified before dependency installation');
  assert.match(sourceGate, /status', '--porcelain=v1', '--untracked-files=all'/);
  assert.match(sourceGate, /tracked or untracked changes are present/);
  assert.match(sourceGate, /HEAD\^\{commit\}/);
  assert.match(sourceGate, /HEAD\^\{tree\}/);
  assert.match(sourceGate, /refs\/tags\/\$\{expectedTag\}\^\{commit\}/);
  assert.match(build, /commit = \$initialSource\.identity\.commit/);
  assert.match(build, /tree = \$initialSource\.identity\.tree/);
  assert.match(build, /exactTag = \$initialSource\.identity\.exactTag/);
  assert.match(build, /configFingerprintSha256 = \$initialInputs\.fingerprintSha256/);
  assert.match(build, /productionPromotable = \(-not \$ClosedAlphaWithGoogleDemoAds\)/,
    'a demo-ad closed-alpha artifact must never be marked production-promotable');
  assert.doesNotMatch(build, /git hash-object|trackedDiffGitObject/,
    'production provenance must not depend on unstored dirty-tree object IDs');
  assert.match(testBuild, /git hash-object --stdin/,
    'dirty source fingerprinting remains available only for debug/test APKs');
  assert.match(build, /app-release\.provenance\.json/);
  assert.match(build, /bundletool dump manifest/);
  assert.match(build, /Assert-Equal 'package'/);
  assert.match(build, /Assert-Equal 'minSdkVersion'/);
  assert.match(build, /Assert-Equal 'targetSdkVersion'/);
  assert.match(build, /Assert-Equal 'AdMob application ID'/);
  assert.match(build, /game_services_project_id --values/);
  assert.match(build, /play_integrity_cloud_project_number --values/);
  assert.match(build, /PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER/);
  assert.match(build, /keytool\.exe.*-printcert -jarfile/);
  assert.match(build, /UPLOAD_CERT_SHA256/);
  assert.match(releaseCheck, /GOOGLE_SAMPLE_ADMOB_PUBLISHER = '3940256099942544'/);
  assert.match(payloadCheck, /Google’s sample rewarded-ad ID/);
});
