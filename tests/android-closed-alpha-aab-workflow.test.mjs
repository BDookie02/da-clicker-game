import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('closed Play testing uses the production-ad release path so M reaches the SSV ledger', () => {
  const pkg = JSON.parse(read('package.json'));
  const build = read('scripts/build-play-release.ps1');

  assert.equal(
    pkg.scripts['release:play:closed-alpha'],
    'npm run release:play',
  );
  assert.match(build, /if \(\$ClosedAlphaWithGoogleDemoAds\) \{\s*throw 'Google demo ad units cannot be uploaded to a Play track:/s);
  assert.match(build, /npm run release:bundle-check/);
  assert.match(build, /npm run build/);
  assert.match(build, /verify-android-release-assets\.mjs/);
});

test('the default Play release still builds and verifies the production web payload', () => {
  const pkg = JSON.parse(read('package.json'));
  const build = read('scripts/build-play-release.ps1');

  assert.equal(
    pkg.scripts['release:play'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-play-release.ps1',
  );
  assert.match(build, /else \{\s*Invoke-NativeChecked 'Production web build failed\.'/s);
  assert.match(build, /npm run build/);
  assert.match(build, /verify-android-release-assets\.mjs/);
  assert.match(build, /distribution = if \(\$ClosedAlphaWithGoogleDemoAds\) \{ 'play-closed-alpha' \} else \{ 'play-production' \}/);
});
