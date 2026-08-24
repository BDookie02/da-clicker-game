import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ui = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
const leaderboard = readFileSync(new URL('../src/leaderboard.ts', import.meta.url), 'utf8');

test('quick-buy performs exactly one normal tap before preserving its advertised purchase', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = ui.indexOf("document.getElementById('quick-buy')");
  const end = ui.indexOf('const eyeBtn', start);
  assert.ok(start >= 0 && end > start, 'quick-buy handler was not found');
  const handler = ui.slice(start, end);
  const advertisedAt = handler.indexOf('this.game.cheapestAffordable()');
  const tapAt = handler.indexOf('this.onQuickBuyTap()');
  const purchaseAt = handler.indexOf('this.game.buyUpgrade(best.id)');
  assert.ok(advertisedAt >= 0 && advertisedAt < tapAt);
  assert.ok(tapAt < purchaseAt);
  assert.match(handler, /this\.game\.buyCrew\(best\.id\)/);
  assert.match(main, /ui\.onQuickBuyTap = registerPhysicalTap/);
  const physicalTap = main.slice(main.indexOf('const registerPhysicalTap'), main.indexOf('ui.onQuickBuyTap'));
  assert.equal(physicalTap.match(/game\.tap\(\)/g)?.length, 1);
  assert.match(physicalTap, /tutorial\.recordSuccessfulTap\(\)/);
  assert.match(physicalTap, /sfx\.tap\(\)/);
});

test('Ranks shows description-free username and login controls before a real-only board', () => {
  const start = ui.indexOf("else if (this.openTab === 'ranks')");
  const end = ui.indexOf("else if (this.openTab === 'boosters')", start);
  assert.ok(start >= 0 && end > start, 'Ranks renderer was not found');
  const ranks = ui.slice(start, end);
  const controlsAt = ranks.indexOf('class="ranks-controls');
  const listAt = ranks.indexOf('const list =');
  const tableAt = ranks.indexOf('class="lb-table"');
  assert.ok(controlsAt >= 0 && controlsAt < listAt);
  assert.ok(tableAt > listAt);
  const controls = ranks.slice(controlsAt, ranks.indexOf('</div>`);', controlsAt));
  assert.match(controls, />CHANGE USERNAME</);
  assert.match(controls, />LOGIN</);
  assert.doesNotMatch(controls, /row-desc|Change costs|submit your taps/);
  assert.match(ranks, /this\.remoteBoard\?\.entries \?\? \[\]/);
  assert.match(ranks, /const shown = \[\.\.\.list\]\.sort/);
  assert.doesNotMatch(ranks, /row\('official'|Official Board|>VIEW</);
  assert.doesNotMatch(leaderboard, /getWorldList|preview data/);
});

test('username and platform-login descriptions are deferred to their selected flows', () => {
  assert.match(ui, /promptUsername\(false\)/);
  assert.match(ui, /CHANGE USERNAME[\s\S]*data-id="signin"[\s\S]*>LOGIN</);
  assert.match(ui, /leaderboard-signin-overlay/);
  assert.match(
    ui,
    /submits a client-recorded cumulative tap count that the server limits to plausible rates/,
  );
  assert.doesNotMatch(ui, /submits your raw tap count/);
  const promptAt = ui.indexOf('private promptLeaderboardSignIn()');
  const signInAt = ui.indexOf('await provider.signIn()', promptAt);
  const submitAt = ui.indexOf('await provider.submit(this.game.s.totalTaps)', signInAt);
  assert.ok(promptAt >= 0 && signInAt > promptAt && submitAt > signInAt);
  assert.match(ui, /if \(id !== 'signin'\) return;\s*await this\.promptLeaderboardSignIn\(\)/);
});
