import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ads = fs.readFileSync(new URL('../src/ads.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('native ad inventory initializes and preloads away from the user tap path', () => {
  assert.match(ads, /void nativeProvider\.warmup\(\)\.catch/);
  assert.match(ads, /const loads: Promise<unknown>\[\] = \[this\.preloadInterstitial\(\)\]/);
  assert.match(ads, /if \(AD_CONFIG\.TESTING\) loads\.push\(/);
  assert.match(ads, /document\.addEventListener\('visibilitychange'/);
  assert.match(ads, /nativeProvider\.onVisibilityChange\(\)/);
});

test('rewarded loads are bounded, serialized, and never open after backgrounding', () => {
  assert.match(ads, /const AD_LOAD_TIMEOUT_MS = 15_000/);
  assert.match(ads, /private showInProgress = false/);
  assert.match(ads, /if \(this\.showInProgress\) return \{ rewarded: false, watchedSeconds: 0 \}/);
  assert.match(ads, /requestedInEpoch !== this\.backgroundEpoch/);
  assert.match(ads, /const AD_SHOW_TIMEOUT_MS = 120_000/);
  assert.match(ads, /retryable: error instanceof AdDeadlineError/);
  assert.match(ui, /pendingRewardLoad/);
});

test('a consumed test reward is refilled while the UI retains its five-second guard', () => {
  assert.match(ads, /Rewarded ads are single-use/);
  assert.match(ads, /void this\.warmup\(\)\.catch/);
  assert.match(ui, /const waitMs = 5000 - \(now - this\.lastAdStartedAt\)/);
  assert.match(ui, /if \(this\.adInProgress\)/);
  assert.match(ui, /class="ad-loading-spinner"/);
});

test('forced interstitials use exactly 6.28 foreground minutes and only an opponent break', () => {
  assert.match(main, /const INTERSTITIAL_INTERVAL_MS = 376_800/);
  assert.match(main, /interstitialElapsedMs \+= interstitialDeltaMs/);
  assert.match(main, /nativeAppActive\s*&&\s*pageVisible\s*&&\s*windowFocused/);
  assert.match(main, /!tutorial\.isActive/);
  assert.match(main, /!ui\.isPanelOpen/);
  const defeat = main.indexOf("e.type === 'defeated'");
  const show = main.indexOf('await maybeShowDueInterstitial()', defeat);
  const drive = main.indexOf('scene.driveToNext', defeat);
  assert.ok(defeat >= 0 && show > defeat && drive > show);
  assert.match(main, /if \(shown\) \{\s*interstitialDue = false;\s*interstitialElapsedMs = 0/);
  assert.match(ads, /if \(this\.showInProgress \|\| document\.hidden \|\| !this\.isInterstitialPrepared\(\)\)/);
});
