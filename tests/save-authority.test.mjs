import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSave, verifiedTapTotal } from '../server/worker.js';

const base = () => ({
  economyVersion: 1,
  username: 'CLIENT_NAME',
  prestiges: 0,
  respect: 12,
  mentality: 999999,
  totalTaps: 25,
  opponentIndex: 0,
  opponentProgress: 12,
  upgradeLevels: {},
  crewCounts: {},
  ownedCosmetics: [],
  labOwned: [],
  equippedCosmetics: {},
  dashboardSlots: [null, null, null, null, null, null],
  boostMult: 1,
  boostEndsAt: 0,
  lastSeen: Date.now(),
  adsWatched: 999,
  infiniteCurrency: true,
  appliedPurchases: ['forged'],
  textSizeTier: 3,
  tutorialComplete: true,
});

test('premium balance, identity, ledgers, and tap score are server authoritative', () => {
  const clean = sanitizeSave(base(), {
    earnedMentality: 125,
    totalTaps: 20,
    adCount: 1,
    purchaseIds: ['GPA.real-order'],
  }, null, 'SERVER_NAME');
  assert.equal(clean.username, 'SERVER_NAME');
  assert.equal(clean.mentality, 125);
  assert.equal(clean.totalTaps, 20);
  assert.equal(clean.adsWatched, 1);
  assert.equal(clean.infiniteCurrency, false);
  assert.deepEqual(clean.appliedPurchases, ['GPA.real-order']);
});

test('verified premium earnings may be spent only on known inventory', () => {
  const value = base();
  value.ownedCosmetics = ['dangle_dice'];
  value.labOwned = ['lab_grip'];
  value.equippedCosmetics = { dangler: 'dangle_dice', roof: 'dangle_dice' };
  const clean = sanitizeSave(value, {
    earnedMentality: 210,
    totalTaps: 25,
    adCount: 0,
    purchaseIds: [],
  }, null, 'PLAYER');
  assert.equal(clean.mentality, 0);
  assert.deepEqual(clean.ownedCosmetics, ['dangle_dice']);
  assert.deepEqual(clean.labOwned, ['lab_grip']);
  assert.deepEqual(clean.equippedCosmetics, { dangler: 'dangle_dice' });
});

test('unverified premium inventory is rejected', () => {
  const value = base();
  value.ownedCosmetics = ['roof_taxi'];
  assert.throws(() => sanitizeSave(value, {
    earnedMentality: 0, totalTaps: 0, adCount: 0, purchaseIds: [],
  }, null, 'PLAYER'), /unverified_premium_spend/);
});

test('a stale device cannot delete durable ownership', () => {
  const previous = base();
  previous.ownedCosmetics = ['dangle_dice'];
  const clean = sanitizeSave(base(), {
    earnedMentality: 90, totalTaps: 25, adCount: 0, purchaseIds: [],
  }, previous, 'PLAYER');
  assert.deepEqual(clean.ownedCosmetics, ['dangle_dice']);
  assert.equal(clean.mentality, 0);
});

test('raw leaderboard taps are monotonic and rate bounded', () => {
  assert.equal(verifiedTapTotal(125, 100, 1_000, 1_001), 125);
  assert.equal(verifiedTapTotal(90, 100, 1_000, 1_001), 100);
  assert.equal(verifiedTapTotal(131, 100, 1_000, 1_001), null);
  assert.equal(verifiedTapTotal(355, 100, 1_000, 1_010), 355);
  assert.equal(verifiedTapTotal(356, 100, 1_000, 1_010), null);
});
