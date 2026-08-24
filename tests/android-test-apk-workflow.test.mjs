import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const absolute = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const artifactBuildScripts = [
  'scripts/build-test-apk.ps1',
  'scripts/build-play-release.ps1',
];

function hashWithScriptHelper(scriptPath, fixturePath) {
  const command = [
    '$tokens=$null',
    '$errors=$null',
    `$ast=[System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(scriptPath)},[ref]$tokens,[ref]$errors)`,
    "if($errors.Count){throw ($errors | Out-String)}",
    "$functionAst=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-FileSha256'},$true)",
    "if($null -eq $functionAst){throw 'Get-FileSha256 was not found'}",
    'Invoke-Expression $functionAst.Extent.Text',
    `Get-FileSha256 -LiteralPath ${psLiteral(fixturePath)}`,
  ].join('; ');
  return execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8', windowsHide: true }).trim();
}

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
  const exampleEnv = read('.env.example');
  assert.match(testEnv, /^VITE_VISUAL_AUDIT=true$/m);
  assert.match(testEnv, /^VITE_ADMOB_TESTING=true$/m);
  assert.match(exampleEnv, /^VITE_ADMOB_ANDROID_INTERSTITIAL_ID=$/m);
  assert.match(verifier, /treeDigest\(distRoot\)/);
  assert.match(verifier, /treeDigest\(androidWebRoot, capacitorBridgePlaceholders\)/);
  assert.match(verifier, /Capacitor bridge placeholder must remain empty/);
  assert.match(verifier, /not byte-for-byte identical/);
  for (const handle of ['__game', '__scene', '__ui'])
    assert.match(verifier, new RegExp(handle));
  assert.match(verifier, /ca-app-pub-3940256099942544\/5224354917/);
  assert.match(verifier, /ca-app-pub-3940256099942544\/1033173712/);
  assert.match(verifier, /does not contain Google.*official Android interstitial-ad test unit/);
  assert.match(verifier, /unexpectedly contains the production interstitial-ad unit ID/);
  assert.match(verifier, /contains a non-test AdMob ID/);
  assert.match(verifier, /expectedTestApiUrl = 'http:\/\/127\.0\.0\.1:8787'/);
  assert.match(verifier, /VITE_API_URL must be exactly/);
  assert.match(verifier, /does not contain the required local API origin/);
  assert.match(verifier, /unexpectedly contains the production API origin/);
});

test('test APK workflow fingerprints both source states and exports only verified debug output', () => {
  const build = read('scripts/build-test-apk.ps1');
  const gradle = read('android/app/build.gradle');
  const debugManifest = read('android/app/src/debug/AndroidManifest.xml');
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
  assert.match(build, /\$expectedPackage = 'com\.nosiah\.discipline\.test'/);
  assert.match(gradle, /debug\s*\{[\s\S]*applicationIdSuffix "\.test"/);
  assert.match(gradle, /debug\s*\{[\s\S]*versionNameSuffix "-test"/);
  assert.match(debugManifest, /android:usesCleartextTraffic="true"/);
});

test('Android artifact scripts have no Get-FileHash dependency', () => {
  for (const script of artifactBuildScripts) {
    const source = read(script);
    assert.doesNotMatch(source, /\bGet-FileHash\b/,
      `${script} must not depend on the optional Microsoft.PowerShell.Utility cmdlet`);
    assert.match(source, /function Get-FileSha256/);
    assert.match(source, /\[System\.IO\.File\]::OpenRead\(\$LiteralPath\)/);
    assert.match(source, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
    assert.match(source, /ToUpperInvariant\(\)/);
  }
});

test('Android artifact scripts use deterministic uppercase file hashes', {
  skip: process.platform !== 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discipline-sha256-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'binary hash fixture.dat');
  const bytes = Buffer.from([0x00, 0x44, 0x49, 0x53, 0x43, 0x49, 0x50, 0x4c, 0x49, 0x4e, 0x45, 0xff]);
  fs.writeFileSync(fixture, bytes);
  const expected = createHash('sha256').update(bytes).digest('hex').toUpperCase();

  for (const script of artifactBuildScripts) {
    const scriptPath = absolute(script);
    const first = hashWithScriptHelper(scriptPath, fixture);
    const second = hashWithScriptHelper(scriptPath, fixture);
    assert.equal(first, expected, `${script} must match Node's SHA-256 result`);
    assert.equal(second, expected, `${script} must hash identical bytes deterministically`);
    assert.match(first, /^[0-9A-F]{64}$/);
  }
});
