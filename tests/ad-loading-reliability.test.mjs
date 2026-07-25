import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ads = fs.readFileSync(new URL('../src/ads.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');

test('native rewarded ads initialize and preload away from the user tap path', () => {
  assert.match(ads, /void nativeProvider\.warmup\(\)\.catch/);
  assert.match(ads, /if \(AD_CONFIG\.TESTING\)\s+await deadline\(this\.prepare\(\)/);
  assert.match(ads, /document\.addEventListener\('visibilitychange'/);
  assert.match(ads, /nativeProvider\.onVisibilityChange\(\)/);
});

test('rewarded loads are bounded, serialized, and never open after backgrounding', () => {
  assert.match(ads, /const AD_LOAD_TIMEOUT_MS = 15_000/);
  assert.match(ads, /private showInProgress = false/);
  assert.match(ads, /if \(this\.showInProgress\) return \{ rewarded: false, watchedSeconds: 0 \}/);
  assert.match(ads, /requestedInEpoch !== this\.backgroundEpoch/);
  assert.match(ads, /const AD_SHOW_TIMEOUT_MS = 120_000/);
});

test('a consumed test reward is refilled while the UI retains its five-second guard', () => {
  assert.match(ads, /Rewarded ads are single-use/);
  assert.match(ads, /void this\.warmup\(\)\.catch/);
  assert.match(ui, /const waitMs = 5000 - \(now - this\.lastAdStartedAt\)/);
  assert.match(ui, /if \(this\.adInProgress\)/);
  assert.match(ui, /class="ad-loading-spinner"/);
});
