import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { isAdmobCallbackTester, parseAdmobSignedQuery } from '../server/worker.js';

class SqliteD1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first(column) {
    const row = this.db.sqlite.prepare(this.sql).get(...this.args) || null;
    return column && row ? row[column] : row;
  }
  all() { return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.db.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) { return new SqliteD1Statement(this, sql); }
  batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

async function sha256Hex(value) {
  return [...new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value),
  ))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    this.db.firstCalls.push(this);
    if (this.sql.includes('FROM sessions s JOIN accounts a')) {
      return { id: 42, username: 'Visualqa', lower_username: 'visualqa' };
    }
    if (this.sql.startsWith('SELECT account_id,public_id,terms_version')) {
      return { account_id: 42, public_id: 'a'.repeat(32),
        terms_version: '2026-08-24-pvp1', leaderboard_status: 'active' };
    }
    if (this.sql === 'SELECT friend_code FROM account_profiles WHERE account_id=?') {
      return { friend_code: 'A1B2C3D4' };
    }
    if (this.sql === 'SELECT account_id FROM account_deletion_jobs WHERE account_id=?') {
      if (this.db.beforeDeletionCheck) await this.db.beforeDeletionCheck();
      return this.db.deletionPending ? { account_id: this.args[0] } : null;
    }
    if (this.sql.includes('SELECT referral_cursor FROM account_deletion_jobs')) {
      return { referral_cursor: -1 };
    }
    return null;
  }

  async all() {
    return { success: true, results: [] };
  }

  async run() {
    this.db.runCalls.push(this);
    if (this.sql.startsWith('DELETE FROM account_mutation_leases')) {
      if (this.sql.includes('WHERE request_id=?')) this.db.activeLease = false;
      return { success: true, meta: { changes: 0 } };
    }
    if (this.sql.startsWith('INSERT INTO account_mutation_leases')) {
      if (this.db.deletionPending) return { success: true, meta: { changes: 0 } };
      this.db.activeLease = true;
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT OR IGNORE INTO account_deletion_jobs')) {
      if (this.db.activeLease) return { success: true, meta: { changes: 0 } };
      this.db.deletionPending = true;
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class MockDb {
  firstCalls = [];
  runCalls = [];
  batches = [];

  constructor({ deletionPending = false, beforeDeletionCheck = null } = {}) {
    this.deletionPending = deletionPending;
    this.beforeDeletionCheck = beforeDeletionCheck;
    this.activeLease = false;
  }

  beginDeletion() {
    if (this.activeLease) return false;
    this.deletionPending = true;
    return true;
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

test('serves public privacy and account-deletion pages', async () => {
  const privacy = await worker.fetch(new Request('https://api.example/privacy'), {});
  assert.equal(privacy.status, 200);
  assert.match(privacy.headers.get('content-type'), /^text\/html/);
  assert.match(await privacy.text(), /DISCIPLINE\. Privacy Policy/);

  const terms = await worker.fetch(new Request('https://api.example/terms'), {});
  assert.equal(terms.status, 200);
  assert.match(await terms.text(), /DISCIPLINE\. Terms/);

  const deletion = await worker.fetch(new Request('https://api.example/account-deletion'), {});
  assert.equal(deletion.status, 200);
  const page = await deletion.text();
  assert.match(page, /Delete a DISCIPLINE\. account/);
  assert.match(page, /Type DELETE/);
  assert.match(page, /fetch\('\/v1\/account'/);
});

test('requires authentication before deleting an account', async () => {
  const db = new MockDb();
  const response = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE',
  }), { DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: 'unauthorized' });
  assert.equal(db.batches.length, 0);
});

test('rejects unsigned AdMob reward callbacks before touching account data', async () => {
  const response = await worker.fetch(new Request('https://api.example/v1/admob/reward?transaction_id=fake'), {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: 'invalid_admob_callback' });
});

test('recognizes only the exact fresh AdMob console callback tester payload', () => {
  const now = Date.now();
  const params = new URLSearchParams({
    ad_network: '5450213213286189855',
    ad_unit: '1234567890',
    transaction_id: '123456789',
    reward_amount: '1',
    reward_item: 'completed_ad',
    timestamp: String(now),
  });
  assert.equal(isAdmobCallbackTester(params, now), true);
  params.set('transaction_id', 'real-transaction');
  assert.equal(isAdmobCallbackTester(params, now), false);
  params.set('transaction_id', '123456789');
  assert.equal(isAdmobCallbackTester(params, now + 5 * 60 * 1000 + 1), false);
});

test('requires signed AdMob fields followed by terminal signature and key ID', () => {
  const signed = [
    'ad_network=5450213213286189855',
    'ad_unit=1234567890',
    'custom_data=%7B%22v%22%3A1%7D',
    'reward_amount=1',
    'reward_item=completed_ad',
    'timestamp=1785046013637',
    'transaction_id=123456789',
    'user_id=test-user',
  ].join('&');
  const query = `${signed}&signature=MEUCIQ&key_id=3335741209`;
  const parsed = parseAdmobSignedQuery(query);
  assert.ok(parsed);
  assert.equal(parsed.signedContent, signed);
  assert.equal(parsed.signature, 'MEUCIQ');
  assert.equal(parsed.keyId, '3335741209');
  assert.equal(parseAdmobSignedQuery(`${query}&custom_data=unsigned`), null);
  assert.equal(parseAdmobSignedQuery(`${signed}&user_id=duplicate&signature=MEUCIQ&key_id=3335741209`), null);
  assert.equal(parseAdmobSignedQuery(`${signed}&key_id=3335741209&signature=MEUCIQ`), null);
});

test('rejects authenticated routes globally while account deletion is pending', async () => {
  const routes = [
    ['GET', '/v1/account', 0],
    ['GET', '/v1/board', 0],
    ['GET', '/v1/referral', 1],
    ['POST', '/v1/referral/claim', 1],
    ['POST', '/v1/friends/request', 1],
    ['POST', '/v1/pvp/invite', 1],
    ['POST', `/v1/pvp/${'a'.repeat(32)}/tap`, 0],
    ['PUT', '/v1/account/username', 1],
    ['POST', '/v1/blocks', 1],
    ['PUT', '/v1/save', 1],
    ['POST', '/v1/purchases/android/verify', 1],
  ];
  for (const [method, pathname, expectedLeaseAttempts] of routes) {
    const db = new MockDb({ deletionPending: true });
    const response = await worker.fetch(new Request(`https://api.example${pathname}`, {
      method,
      headers: { Authorization: 'Bearer local-test-session' },
    }), { DB: db });
    assert.equal(response.status, 409, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'account_deletion_pending',
    });
    assert.equal(db.runCalls.filter(call => call.sql.startsWith(
      'INSERT INTO account_mutation_leases',
    )).length, expectedLeaseAttempts,
    `${method} ${pathname} must use its read or database lease deletion gate`);
    assert.equal(db.batches.length, 0, `${method} ${pathname} must not batch mutations`);
  }
});

test('unknown authenticated POST routes perform no mutation-lease writes', async () => {
  for (const pathname of ['/v1/not-a-route', '/v1/pvp/not-a-real-match/tap']) {
    const db = new MockDb();
    const response = await worker.fetch(new Request(`https://api.example${pathname}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-test-session' },
    }), { DB: db });
    assert.equal(response.status, 404, pathname);
    assert.equal(db.runCalls.length, 0,
      `${pathname}: an unknown route must not create a lease or repair a profile`);
  }
});

test('tap snapshots rely on their exact deletion guard instead of per-snapshot leases', async () => {
  const db = new MockDb();
  const matchId = 'b'.repeat(32);
  const response = await worker.fetch(new Request(
    `https://api.example/v1/pvp/${matchId}/tap`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-test-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ count: 1 }),
    },
  ), { DB: db });
  assert.equal(response.status, 409, 'the mock has no active match');
  assert.equal(db.runCalls.some(call => call.sql.includes('account_mutation_leases')), false,
    'a high-frequency score snapshot must not spend two D1 lease writes');
  assert.ok(db.runCalls.some(call => call.sql.startsWith('UPDATE pvp_matches')),
    'the request still reaches the exact match mutation guarded by account deletion state');
  const runCount = db.runCalls.length;
  const burst = await worker.fetch(new Request(
    `https://api.example/v1/pvp/${matchId}/tap`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-test-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ count: 2 }),
    },
  ), { DB: db });
  assert.equal(burst.status, 429);
  assert.equal(db.runCalls.length, runCount,
    'the per-isolate burst guard must reject before any account-state or match write attempt');
});

test('hot multiplayer state polling performs no mutation-lease writes', async () => {
  const db = new MockDb();
  const response = await worker.fetch(new Request('https://api.example/v1/multiplayer', {
    headers: { Authorization: 'Bearer local-test-session' },
  }), { DB: db });
  assert.equal(response.status, 200);
  assert.equal(db.runCalls.some(call => call.sql.includes('account_mutation_leases')), false);
});

test('an authenticated mutation lease atomically prevents deletion from beginning mid-request', async () => {
  let releaseBody;
  let observeBody;
  const bodyObserved = new Promise(resolve => { observeBody = resolve; });
  const bodyReleased = new Promise(resolve => { releaseBody = resolve; });
  const db = new MockDb();
  const request = {
    method: 'PUT',
    url: 'https://api.example/v1/account/username',
    headers: new Headers({ Authorization: 'Bearer local-test-session' }),
    json: async () => {
      observeBody();
      await bodyReleased;
      return { username: 'Leaseproof' };
    },
  };
  const responsePromise = worker.fetch(request, { DB: db });
  await bodyObserved;
  assert.equal(db.activeLease, true,
    `request must own its database lease before handler work: ${db.runCalls.map(call => call.sql).join(' | ')}`);
  assert.equal(db.beginDeletion(), false, 'deletion job cannot begin after the request passes its gate');
  assert.equal(db.deletionPending, false);
  releaseBody();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account: { id: '42', username: 'Leaseproof' },
  });
  assert.equal(db.activeLease, false, 'finally must release the request lease');
  assert.equal(db.beginDeletion(), true, 'deletion may begin immediately after request completion');
});

test('real D1 SQL rejects delete after a request lease is acquired, then permits it after release', async () => {
  const DB = new SqliteD1();
  DB.sqlite.prepare(`INSERT INTO accounts(
    id,username,lower_username,password_salt,password_hash) VALUES(42,'Visualqa','visualqa','salt','hash')`).run();
  DB.sqlite.prepare(`INSERT INTO account_profiles(
    account_id,public_id,terms_version) VALUES(42,?,'2026-08-24-pvp1')`).run('a'.repeat(32));
  const token = 'real-race-session';
  DB.sqlite.prepare(`INSERT INTO sessions(token_hash,account_id,expires_at)
    VALUES(?,42,?)`).run(await sha256Hex(token), Math.floor(Date.now() / 1000) + 3600);

  let releaseBody;
  let observeBody;
  const bodyObserved = new Promise(resolve => { observeBody = resolve; });
  const bodyReleased = new Promise(resolve => { releaseBody = resolve; });
  const renamePromise = worker.fetch({
    method: 'PUT',
    url: 'https://api.example/v1/account/username',
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    json: async () => {
      observeBody();
      await bodyReleased;
      return { username: 'Leaseproof' };
    },
  }, { DB });
  await bodyObserved;
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM account_mutation_leases
    WHERE account_id=42`).get().count, 1);

  const blockedDelete = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  }), { DB });
  assert.equal(blockedDelete.status, 503);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM account_deletion_jobs
    WHERE account_id=42`).get().count, 0, 'deletion must not begin behind a live mutation');
  assert.equal(DB.sqlite.prepare('SELECT username FROM accounts WHERE id=42').get().username,
    'Visualqa');

  releaseBody();
  assert.equal((await renamePromise).status, 200);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM account_mutation_leases
    WHERE account_id=42`).get().count, 0);
  assert.equal(DB.sqlite.prepare('SELECT username FROM accounts WHERE id=42').get().username,
    'Leaseproof');
  const completedDelete = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  }), { DB });
  assert.equal(completedDelete.status, 200);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts WHERE id=42').get().count, 0);
});

test('allows the authenticated deletion continuation through the pending gate', async () => {
  const db = new MockDb({ deletionPending: true });
  const response = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer local-test-session' },
  }), { DB: db });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: true });
  assert.equal(db.batches.length, 1);
});

test('accepts AdMob callback tester payloads that omit optional user and custom data', () => {
  const signed = [
    'ad_network=5450213213286189855',
    'ad_unit=1234567890',
    'reward_amount=1',
    'reward_item=completed_ad',
    'timestamp=1785046013637',
    'transaction_id=123456789',
  ].join('&');
  const query = `${signed}&signature=MEUCIQ&key_id=3335741209`;
  const parsed = parseAdmobSignedQuery(query);
  assert.ok(parsed);
  assert.equal(parsed.signedContent, signed);
  assert.equal(parsed.params.has('custom_data'), false);
  assert.equal(parsed.params.has('user_id'), false);
  assert.equal(parseAdmobSignedQuery(`${signed}&user_id=one&user_id=two&signature=MEUCIQ&key_id=3335741209`), null);
});

test('reward status is authenticated and scoped to exact account, nonce, and kind', async () => {
  const db = new MockDb();
  const nonce = '123e4567-e89b-12d3-a456-426614174000';
  const response = await worker.fetch(new Request(
    `https://api.example/v1/admob/reward/status?nonce=${nonce}&kind=boost`,
    { headers: { Authorization: 'Bearer local-test-session' } },
  ), { DB: db });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, verified: false, nonce, kind: 'boost' });
  const rewardLookup = db.firstCalls.find(call => call.sql.includes('FROM ad_rewards'));
  assert.ok(rewardLookup);
  assert.deepEqual(rewardLookup.args, [42, nonce, 'boost']);
});

test('deletes every account-owned record before the account row', async () => {
  const db = new MockDb();
  const response = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer local-test-session' },
  }), { DB: db });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: true });
  assert.equal(db.batches.length, 1);
  assert.deepEqual(db.batches[0].map(statement => statement.sql), [
    'DELETE FROM pvp_round_scores WHERE account_id=?',
    'DELETE FROM pvp_matches WHERE inviter_account_id=? OR invitee_account_id=?',
    'DELETE FROM pvp_rewards WHERE winner_account_id=?',
    'UPDATE pvp_rewards SET pair_low_account_id=NULL,pair_high_account_id=NULL WHERE pair_low_account_id=? OR pair_high_account_id=?',
    'DELETE FROM friendships WHERE account_low_id=? OR account_high_id=?',
    'DELETE FROM community_reports WHERE reporter_account_id=? OR reported_account_id=?',
    'DELETE FROM username_reports WHERE reporter_account_id=? OR reported_account_id=?',
    'DELETE FROM account_blocks WHERE blocker_account_id=? OR blocked_account_id=?',
    'DELETE FROM referral_reward_ledger WHERE referrer_account_id=?',
    'UPDATE referral_claim_ledger SET referred_account_id=NULL WHERE referred_account_id=?',
    'UPDATE referral_claim_ledger SET referrer_account_id=NULL WHERE referrer_account_id=?',
    'DELETE FROM referral_rewards WHERE referred_account_id=? OR referrer_account_id=?',
    'DELETE FROM referral_claims WHERE referred_account_id=? OR referrer_account_id=?',
    'DELETE FROM referral_codes WHERE account_id=?',
    'DELETE FROM purchase_consumptions WHERE EXISTS ( SELECT 1 FROM purchases p WHERE p.account_id=? AND p.platform=purchase_consumptions.platform AND p.transaction_id=purchase_consumptions.transaction_id )',
    'DELETE FROM ad_rewards WHERE account_id=?',
    'DELETE FROM purchases WHERE account_id=?',
    'DELETE FROM scores WHERE account_id=?',
    'DELETE FROM cloud_saves WHERE account_id=?',
    'DELETE FROM sessions WHERE account_id=?',
    'DELETE FROM account_profiles WHERE account_id=?',
    'DELETE FROM account_mutation_leases WHERE account_id=?',
    'DELETE FROM account_deletion_jobs WHERE account_id=?',
    'DELETE FROM accounts WHERE id=?',
  ]);
  assert.deepEqual(db.batches[0].map(statement => statement.args), [
    [42], [42, 42], [42], [42, 42], [42, 42],
    [42, 42], [42, 42], [42, 42], [42], [42], [42],
    [42, 42], [42, 42], [42], [42], [42], [42], [42], [42], [42], [42], [42], [42], [42],
  ]);
});
