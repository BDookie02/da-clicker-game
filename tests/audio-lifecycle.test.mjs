import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('native and browser lifecycle signals gate both music and sound effects', () => {
  const main = read('src/main.ts');
  const pkg = JSON.parse(read('package.json'));

  assert.match(pkg.dependencies['@capacitor/app'], /^\^8\./);
  assert.match(main, /App\.addListener\('appStateChange'/);
  assert.match(main, /window\.addEventListener\('blur'/);
  assert.match(main, /window\.addEventListener\('focus'/);
  assert.match(main, /document\.addEventListener\('visibilitychange'/);
  assert.match(main, /music\.setAppActive\(active\)/);
  assert.match(main, /sfx\.setAppActive\(active\)/);
});

test('backgrounding stops one-shot effects and prevents music from resuming early', () => {
  const audio = read('src/audio.ts');

  assert.match(audio, /for \(const source of this\.activeSources\)/);
  assert.match(audio, /private canPlay\(\) \{ return this\.appActive && !this\.muted && this\.volume > 0; \}/);
  assert.match(audio, /!this\.appActive \|\| this\.adPauseDepth > 0 \|\| this\.muted \|\| this\.userVolume <= 0/);
  assert.match(audio, /const volume = this\.muted \|\| !this\.appActive/);
});
