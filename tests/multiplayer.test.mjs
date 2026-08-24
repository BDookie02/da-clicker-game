import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PVP_TAPS_PER_SECOND,
  TAP_SUBMISSION_GRACE_MS,
  PVP_REWARD_MENTALITY,
  comparePvPRound,
  nextTiebreakerPhase,
  normalizeFriendCode,
  validatePvPInvite,
  verifiedPvPTapCount,
} from '../server/multiplayer.js';

test('friend codes are normalized without accepting guessed or partial values', () => {
  assert.equal(normalizeFriendCode('a1b2-c3d4'), 'A1B2C3D4');
  assert.equal(normalizeFriendCode('A1B2C3'), '');
  assert.equal(normalizeFriendCode('ZZZZ-ZZZZ'), '');
});

test('tap and standalone Quick Draw modes accept only their supported setup', () => {
  assert.deepEqual(validatePvPInvite('tap', 30), { mode: 'tap', durationSeconds: 30 });
  assert.deepEqual(validatePvPInvite('tap', 60), { mode: 'tap', durationSeconds: 60 });
  assert.deepEqual(validatePvPInvite('tap', 90), { mode: 'tap', durationSeconds: 90 });
  assert.deepEqual(validatePvPInvite('quick_draw', 90), { mode: 'quick_draw', durationSeconds: 0 });
  assert.equal(validatePvPInvite('tap', 45), null);
  assert.equal(validatePvPInvite('unknown', 30), null);
});

test('PvP tap uploads are bounded by the same legitimate multi-touch ceiling', () => {
  const start = 10_000;
  const end = 40_000;
  assert.equal(MAX_PVP_TAPS_PER_SECOND, 25);
  assert.equal(verifiedPvPTapCount(5, start, end, start), 5);
  assert.equal(verifiedPvPTapCount(30, start, end, start + 1000), 30);
  assert.equal(verifiedPvPTapCount(31, start, end, start + 1000), null);
  assert.equal(verifiedPvPTapCount(9999, start, end, end + 5000), null);
});

test('tap submission grace is long enough for the final cumulative upload', () => {
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  assert.equal(TAP_SUBMISSION_GRACE_MS, 2500);
  assert.match(multiplayerSource,
    /phase_ends_at\) \+ TAP_SUBMISSION_GRACE_MS/);
  assert.match(multiplayerSource,
    /now < Number\(match\.phase_ends_at\) \+ TAP_SUBMISSION_GRACE_MS/);
});

test('tap rounds use the highest count and exact ties require Quick Draw', () => {
  assert.equal(comparePvPRound('tap', { tap_count: 100 }, { tap_count: 99 }), 1);
  assert.equal(comparePvPRound('tap', { tap_count: 99 }, { tap_count: 100 }), -1);
  assert.equal(comparePvPRound('tap', { tap_count: 100 }, { tap_count: 100 }), 0);
  assert.equal(nextTiebreakerPhase('tap'), 'quick_draw');
});

test('Quick Draw uses lowest valid server reaction and ties switch to a 30-second tap phase', () => {
  assert.equal(comparePvPRound('quick_draw', { reaction_ms: 175 }, { reaction_ms: 220 }), 1);
  assert.equal(comparePvPRound('quick_draw', { reaction_ms: -1 }, { reaction_ms: 220 }), -1);
  assert.equal(comparePvPRound('quick_draw', { reaction_ms: -1 }, { reaction_ms: -1 }), 0);
  assert.equal(comparePvPRound('quick_draw', null, null), 0);
  assert.equal(nextTiebreakerPhase('quick_draw'), 'tap');
  assert.equal(PVP_REWARD_MENTALITY, 5);
});

test('Worker entrypoint keeps constants out of named exports and ties rewards to completion', () => {
  const workerSource = readFileSync(new URL('../server/worker.js', import.meta.url), 'utf8');
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(workerSource, /export\s+const\s+(?:TERMS_VERSION|REFERRAL_REWARD_LIMIT)/);
  assert.match(workerSource, /import\s+\{\s*TERMS_VERSION\s*\}\s+from\s+'\.\/constants\.js'/);
  assert.match(multiplayerSource,
    /INSERT OR IGNORE INTO pvp_rewards[\s\S]*SELECT id,winner_account_id,\?[\s\S]*status='completed'/);
});
