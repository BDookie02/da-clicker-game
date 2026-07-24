import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('package scripts preserve native patching and route test APKs through the exact workflow', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@capgo/native-purchases'], '8.6.4');
  assert.equal(pkg.scripts.postinstall, 'node scripts/patch-native-purchases.mjs');
  assert.equal(pkg.scripts.prebuild, 'node scripts/patch-native-purchases.mjs');
  assert.equal(pkg.scripts['prebuild:test'], 'node scripts/patch-native-purchases.mjs');
  assert.equal(
    pkg.scripts['android:test:apk'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-test-apk.ps1',
  );
});

test('test payload verifier requires byte identity, visual handles, and only Google test ads', () => {
  const verifier = read('scripts/verify-android-test-assets.mjs');
  const testEnv = read('.env.test');
  assert.match(testEnv, /^VITE_VISUAL_AUDIT=true$/m);
  assert.match(testEnv, /^VITE_ADMOB_TESTING=true$/m);
  assert.match(verifier, /treeDigest\(distRoot\)/);
  assert.match(verifier, /treeDigest\(androidWebRoot, capacitorBridgePlaceholders\)/);
  assert.match(verifier, /Capacitor bridge placeholder must remain empty/);
  assert.match(verifier, /not byte-for-byte identical/);
  for (const handle of ['__game', '__scene', '__ui'])
    assert.match(verifier, new RegExp(handle));
  assert.match(verifier, /ca-app-pub-3940256099942544\/5224354917/);
  assert.match(verifier, /contains a non-test AdMob ID/);
});

test('test APK workflow fingerprints both source states and exports only verified debug output', () => {
  const build = read('scripts/build-test-apk.ps1');
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\/artifacts\/$/m);
  assert.match(build, /npm ci --no-audit --no-fund/);
  assert.match(build, /npm test/);
  assert.match(build, /npm audit --audit-level=high/);
  assert.match(build, /npm run build:test/);
  assert.match(build, /npx cap sync android/);
  assert.match(build, /verify-android-test-assets\.mjs --json/);
  assert.match(build, /clean :app:lintDebug :app:assembleDebug/);
  assert.doesNotMatch(build, /bundleRelease|assembleRelease|gradlew[^\r\n]*publish|playConsole|uploadBundle/i);
  assert.match(build, /apkanalyzer manifest print/);
  assert.match(build, /Assert-Equal 'package'/);
  assert.match(build, /Assert-Equal 'minSdkVersion'/);
  assert.match(build, /Assert-Equal 'targetSdkVersion'/);
  assert.match(build, /Assert-Equal 'debuggable flag'/);
  assert.match(build, /apksigner verify --verbose --print-certs/);
  assert.match(build, /CN=Android Debug/);
  assert.match(build, /\.android\\debug\.keystore/);
  assert.match(build, /keytool -exportcert/);
  assert.match(build, /signerSha256 -cne \$debugCertificateSha256/);
  assert.match(build, /refusing possible release-key output/);
  assert.match(build, /\$initialSource = Get-SourceSnapshot/);
  assert.match(build, /\$finalSource = Get-SourceSnapshot/);
  assert.match(build, /fingerprintSha256 -ne \$initialSource\.fingerprintSha256/);
  assert.match(build, /DISCIPLINE-test-\$shortHead-\$shortSource-\$shortApk/);
  assert.match(build, /app-debug\.apk/);
  assert.match(build, /\.provenance\.json/);
  assert.match(build, /\.sha256/);
  assert.match(build, /publishable = \$false/);
  assert.match(build, /buildVariant = 'debug'/);
});
