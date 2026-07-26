import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('closed Alpha AAB is an explicit signed-release path with demo ads and real services', () => {
  const pkg = JSON.parse(read('package.json'));
  const build = read('scripts/build-play-release.ps1');
  const verifier = read('scripts/verify-android-closed-alpha-assets.mjs');

  assert.equal(
    pkg.scripts['release:play:closed-alpha'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-play-release.ps1 -ClosedAlphaWithGoogleDemoAds',
  );
  assert.match(build, /param\(\s*\[switch\]\$ClosedAlphaWithGoogleDemoAds/s);
  assert.match(build, /npm run release:bundle-check/);
  assert.match(build, /npx vite build --mode closed-alpha/);
  assert.match(build, /verify-android-closed-alpha-assets\.mjs/);
  assert.match(build, /:app:lintRelease :app:bundleRelease/);
  assert.match(build, /jarsigner\.exe'\) -verify/);
  assert.match(build, /Assert-Equal 'AdMob application ID'/);
  assert.match(build, /Assert-Equal 'Play Games metadata reference'/);
  assert.match(build, /productionPromotable = \(-not \$ClosedAlphaWithGoogleDemoAds\)/);
  assert.match(build, /PLAY CLOSED-ALPHA AAB READY WITH GOOGLE DEMO ADS/);
  assert.match(build, /Remove-Item -LiteralPath \$aab -Force/);

  for (const required of [
    'VITE_ADMOB_TESTING',
    'VITE_VISUAL_AUDIT',
    'VITE_API_URL',
    'VITE_PLAY_GAMES_LEADERBOARD_ID',
    'ca-app-pub-3940256099942544/5224354917',
    'ca-app-pub-3940256099942544/1033173712',
    '/v1/auth/',
    '/v1/save',
    '/v1/admob/reward/status',
  ]) {
    assert.match(verifier, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(verifier, /byte-for-byte identical/);
  assert.match(verifier, /contains a non-demo AdMob ID/);
  for (const forbiddenHandle of ['__game', '__scene', '__ui', '__tutorial', '__interstitial'])
    assert.match(verifier, new RegExp(forbiddenHandle));
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
