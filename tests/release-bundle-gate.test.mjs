import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('bundle preflight skips only store-listing art and keeps every runtime gate', async () => {
  const packageJson = JSON.parse(read('package.json'));
  const build = read('scripts/build-play-release.ps1');
  const releaseCheck = read('scripts/release-check.mjs');
  const releaseVerifier = read('scripts/verify-android-release-assets.mjs');
  const { selectReleaseFailures } = await import('../scripts/release-check-policy.mjs');

  assert.equal(packageJson.scripts['release:check'], 'node scripts/release-check.mjs');
  assert.equal(packageJson.scripts['release:bundle-check'], 'node scripts/release-check.mjs --bundle');
  assert.match(build, /npm run release:bundle-check/);
  assert.doesNotMatch(build, /npm run release:check/);

  const listingFailures = ['feature graphic', 'screenshots'];
  const runtimeFailures = ['API', 'AdMob', 'Play Games', 'version', 'signing', 'D1'];
  const productionFailures = ['production payload'];
  assert.deepEqual(
    selectReleaseFailures({ bundleOnly: false, listingFailures, runtimeFailures, productionFailures }),
    [...listingFailures, ...runtimeFailures, ...productionFailures],
  );
  assert.deepEqual(
    selectReleaseFailures({ bundleOnly: true, listingFailures, runtimeFailures, productionFailures }),
    [...runtimeFailures, ...productionFailures],
  );

  assert.match(releaseCheck, /requirePng\(listingFailures, 'store-assets\/feature-graphic\.png'/);
  assert.match(releaseCheck, /listingFailures\.push\(`store-assets\/screenshots:/);
  assert.match(releaseCheck, /requirePng\(runtimeFailures, 'public\/icon-512\.png'/);
  for (const mandatoryRuntimeGate of [
    'VITE_API_URL',
    'VITE_ADMOB_ANDROID_REWARDED_ID',
    'VITE_ADMOB_ANDROID_INTERSTITIAL_ID',
    'VITE_PLAY_GAMES_LEADERBOARD_ID',
    'VITE_ADMOB_TESTING',
    'ADMOB_ANDROID_APP_ID',
    'PLAY_GAMES_APP_ID',
    'VERSION_CODE',
    'VERSION_NAME',
    'android/keystore.properties',
    'D1 database_id',
    'ADMOB_REWARDED_AD_UNIT_ID',
  ]) {
    assert.match(releaseCheck, new RegExp(mandatoryRuntimeGate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(releaseCheck, /isGoogleSampleAdMobId\(values\.VITE_ADMOB_ANDROID_INTERSTITIAL_ID\)/);
  assert.match(releaseCheck, /appPublisher && interstitialPublisher && appPublisher !== interstitialPublisher/);
  assert.match(releaseCheck, /Rewarded and interstitial ads must use separate AdMob unit IDs/);
  assert.match(releaseVerifier, /VITE_ADMOB_ANDROID_INTERSTITIAL_ID/);
  assert.match(releaseVerifier, /source\.includes\(interstitialId\)/);
  assert.match(releaseVerifier, /rewardedPublisher !== interstitialPublisher/);
});
