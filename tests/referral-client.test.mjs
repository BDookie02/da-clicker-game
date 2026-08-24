import test from 'node:test';
import assert from 'node:assert/strict';
import {
  persistTerminalReferralFailure,
  retryReferralClaim,
} from '../src/referral.ts';

test('terminal semantic referral failures are not retried and are persisted', async () => {
  let attempts = 0;
  await assert.rejects(() => retryReferralClaim(async () => {
    attempts++;
    throw new Error('referral_not_found');
  }, { wait: async () => undefined, timeoutMs: 1000 }), /referral_not_found/);
  assert.equal(attempts, 1);

  const values = new Map();
  const stored = persistTerminalReferralFailure({
    setItem: (key, value) => values.set(key, value),
  }, 'claim-key', new Error('new_account_required'));
  assert.equal(stored, true);
  assert.equal(values.get('claim-key'), 'terminal:new_account_required');
});

test('known transient referral failures retry only in the bounded TypeScript owner', async () => {
  let attempts = 0;
  const waits = [];
  const result = await retryReferralClaim(async () => {
    attempts++;
    if (attempts < 3) throw new Error('play_integrity_transient');
    return 'claimed';
  }, {
    wait: async delay => { waits.push(delay); },
    timeoutMs: 20_000,
  });
  assert.equal(result, 'claimed');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('configuration failures remain recoverable on a later launch without hot-looping', async () => {
  let attempts = 0;
  await assert.rejects(() => retryReferralClaim(async () => {
    attempts++;
    throw new Error('referral_evidence_not_configured');
  }, { wait: async () => undefined, timeoutMs: 1000 }), /referral_evidence_not_configured/);
  assert.equal(attempts, 1);
  let writes = 0;
  assert.equal(persistTerminalReferralFailure({
    setItem: () => { writes++; },
  }, 'claim-key', new Error('referral_evidence_not_configured')), false);
  assert.equal(writes, 0);
});

test('a hanging native or network operation cannot exceed the referral wall-clock bound', async () => {
  const started = Date.now();
  await assert.rejects(() => retryReferralClaim(
    () => new Promise(() => undefined),
    { timeoutMs: 25 },
  ), /referral_claim_timeout/);
  assert.ok(Date.now() - started < 250);
});
