import test from 'node:test';
import assert from 'node:assert/strict';
import { finishAccountDeletion } from '../src/account-deletion.ts';

const response = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('account deletion follows advancing server progress with a bounded delay', async () => {
  const pages = [
    response(202, { ok: true, deletionPending: true, progressToken: '8', retryAfterMs: 1 }),
    response(202, { ok: true, deletionPending: true, progressToken: '16', retryAfterMs: 250 }),
    response(200, { ok: true, deleted: true }),
  ];
  const waits = [];
  let calls = 0;
  await finishAccountDeletion(async () => {
    calls++;
    return pages.shift();
  }, { wait: async delay => { waits.push(delay); } });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 250]);
});

test('account deletion stops when a server cursor stalls instead of hammering forever', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(() => finishAccountDeletion(async () => {
    calls++;
    return response(202, {
      ok: true, deletionPending: true, progressToken: '8', retryAfterMs: 100,
    });
  }, { wait: async delay => { waits.push(delay); } }), /delete_progress_stalled/);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [100]);
});

test('account deletion caps a single client attempt while preserving server resumability', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(() => finishAccountDeletion(async () => {
    calls++;
    return response(202, {
      ok: true, deletionPending: true, progressToken: String(calls), retryAfterMs: 0,
    });
  }, { maxPages: 3, wait: async delay => { waits.push(delay); } }), /delete_resume_required/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 100, 100]);
});
