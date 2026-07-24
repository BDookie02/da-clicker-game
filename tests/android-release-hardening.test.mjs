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

test('Play Games is auto-discovered once and splash resources cover Android 7 through 12+', () => {
  const activity = read('android/app/src/main/java/com/nosiah/discipline/MainActivity.java');
  const styles = read('android/app/src/main/res/values/styles.xml');
  assert.doesNotMatch(activity, /registerPlugin\s*\(\s*CapacitorGameConnectPlugin/);
  assert.doesNotMatch(activity, /import com\.openforge\.capacitorgameconnect/);
  assert.match(activity, /SplashScreen\.installSplashScreen\(this\)/);
  assert.match(styles, /windowSplashScreenBackground/);
  assert.match(styles, /windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher<\/item>/);
  assert.match(styles, /postSplashScreenTheme">@style\/AppTheme\.NoActionBar<\/item>/);
});

test('release tooling pins Gradle integrity and records exact source provenance', () => {
  const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
  const build = read('scripts/build-play-release.ps1');
  const releaseCheck = read('scripts/release-check.mjs');
  const payloadCheck = read('scripts/verify-android-release-assets.mjs');

  assert.match(wrapper, /distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c/);
  assert.match(build, /npm ci --no-audit --no-fund/);
  assert.match(build, /git rev-parse HEAD/);
  assert.match(build, /dirty = \(\$statusLines\.Count -gt 0\)/);
  assert.match(build, /app-release\.provenance\.json/);
  assert.match(build, /bundletool dump manifest/);
  assert.match(build, /Assert-Equal 'package'/);
  assert.match(build, /Assert-Equal 'minSdkVersion'/);
  assert.match(build, /Assert-Equal 'targetSdkVersion'/);
  assert.match(build, /Assert-Equal 'AdMob application ID'/);
  assert.match(build, /game_services_project_id --values/);
  assert.match(releaseCheck, /GOOGLE_SAMPLE_ADMOB_PUBLISHER = '3940256099942544'/);
  assert.match(payloadCheck, /Google’s sample rewarded-ad ID/);
});
