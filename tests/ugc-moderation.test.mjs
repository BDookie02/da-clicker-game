import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TERMS_VERSION } from '../server/worker.js';

const VIEWER_ID = 42;
const TARGET_ID = 84;
const TARGET_REF = 'b'.repeat(32);
const ADMIN_TOKEN = 'launch-moderation-token-which-is-long-enough';
const LEGAL_ENV = {
  LEGAL_PUBLISHER_NAME: 'Test Publisher',
  LEGAL_CONTACT_EMAIL: 'privacy@example.test',
  LEGAL_EFFECTIVE_DATE: '2026-07-23',
  LEGAL_RETENTION_NOTICE: 'Test retention notice.',
  LEGAL_TARGET_AUDIENCE_NOTICE: 'Test target audience notice.',
};

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.args = [];
  }
  bind(...args) { this.args = args; return this; }
  async first() {
    this.db.firstCalls.push(this);
    if (this.sql.includes('FROM sessions s JOIN accounts a')) {
      return {
        id: VIEWER_ID,
        username: 'Viewer',
        lower_username: 'viewer',
        created_epoch: 1,
      };
    }
    if (this.sql.includes('FROM account_profiles WHERE account_id=?')) {
      return {
        account_id: VIEWER_ID,
        public_id: 'a'.repeat(32),
        terms_version: this.db.currentTerms ? TERMS_VERSION : 'legacy',
        terms_accepted_at: '2026-07-23 00:00:00',
        leaderboard_status: 'active',
      };
    }
    if (this.sql.includes('WHERE p.public_id=?')) {
      if (this.args[0] !== TARGET_REF) return null;
      return { id: TARGET_ID, username: 'Target', public_id: TARGET_REF, taps: 500 };
    }
    if (this.sql.includes('SELECT taps FROM scores WHERE account_id=?')) return { taps: 10 };
    if (this.sql.includes('SELECT COUNT(*) AS n')) return { n: 0 };
    if (this.sql.includes('SELECT reported_account_id FROM community_reports')) {
      return { reported_account_id: TARGET_ID };
    }
    return null;
  }
  async all() {
    this.db.allCalls.push(this);
    if (this.sql.includes('FROM scores s') && this.sql.includes('JOIN account_profiles p')) {
      return {
        results: this.db.blocked.has(TARGET_ID) ? [] : [{
          name: 'Target',
          taps: 500,
          account_id: TARGET_ID,
          player_ref: TARGET_REF,
        }],
      };
    }
    if (this.sql.includes('FROM account_blocks b')) {
      return {
        results: this.db.blocked.has(TARGET_ID)
          ? [{ player_ref: TARGET_REF, name: 'Target' }]
          : [],
      };
    }
    if (this.sql.includes('FROM community_reports r')) return { results: [] };
    return { results: [] };
  }
  async run() {
    this.db.runCalls.push(this);
    if (this.sql.startsWith('INSERT OR IGNORE INTO community_reports')) {
      const key = `${this.args[0]}:${this.args[1]}`;
      const created = !this.db.reports.has(key);
      this.db.reports.add(key);
      return { success: true, meta: { changes: created ? 1 : 0 } };
    }
    if (this.sql.startsWith('INSERT OR IGNORE INTO account_blocks')) {
      const created = !this.db.blocked.has(this.args[1]);
      this.db.blocked.add(this.args[1]);
      return { success: true, meta: { changes: created ? 1 : 0 } };
    }
    if (this.sql.startsWith('DELETE FROM account_blocks')) {
      this.db.blocked.delete(this.args[1]);
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE account_profiles SET terms_version=')) {
      this.db.currentTerms = true;
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class Db {
  currentTerms = true;
  blocked = new Set();
  reports = new Set();
  firstCalls = [];
  allCalls = [];
  runCalls = [];
  batches = [];
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

const authorized = (url, init = {}) => new Request(url, {
  ...init,
  headers: {
    Authorization: 'Bearer local-test-session',
    ...(init.headers || {}),
  },
});
const communityEnv = (db) => ({ DB: db, MODERATION_ADMIN_TOKEN: ADMIN_TOKEN, ...LEGAL_ENV });

test('registration rejects missing and stale Terms acceptance', async () => {
  const body = { username: 'LaunchTester', password: 'very-long-password' };
  const missing = await worker.fetch(new Request('https://api.example/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), LEGAL_ENV);
  assert.equal(missing.status, 428);
  assert.deepEqual(await missing.json(), {
    ok: false,
    error: 'terms_required',
    termsVersion: TERMS_VERSION,
  });

  const stale = await worker.fetch(new Request('https://api.example/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, acceptTerms: true, termsVersion: 'old' }),
  }), LEGAL_ENV);
  assert.equal(stale.status, 428);
});

test('legacy accounts keep authentication but must reaccept before community access', async () => {
  const db = new Db();
  db.currentTerms = false;
  const board = await worker.fetch(authorized('https://api.example/v1/board'), communityEnv(db));
  assert.equal(board.status, 428);
  assert.deepEqual(await board.json(), {
    ok: false,
    error: 'terms_required',
    termsVersion: TERMS_VERSION,
  });

  const accepted = await worker.fetch(authorized('https://api.example/v1/account/terms', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accepted: true, version: TERMS_VERSION }),
  }), communityEnv(db));
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).account.termsCurrent, true);
});

test('public board fails closed until a moderation secret is configured', async () => {
  const response = await worker.fetch(new Request('https://api.example/v1/board'), { DB: new Db() });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'community_unavailable' });
});

test('reports require auth and deduplicate one reporter-target pair', async () => {
  const db = new Db();
  const body = JSON.stringify({
    playerRef: TARGET_REF,
    reason: 'username',
    details: 'Please review this name.',
  });
  const unauthenticated = await worker.fetch(new Request('https://api.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }), communityEnv(db));
  assert.equal(unauthenticated.status, 401);

  const first = await worker.fetch(authorized('https://api.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }), communityEnv(db));
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), {
    ok: true,
    reported: true,
    alreadyReported: false,
  });
  const stored = db.runCalls.find(call => call.sql.startsWith('INSERT OR IGNORE INTO community_reports'));
  assert.deepEqual(stored.args.slice(2, 6), ['Viewer', 'Target', 500, TARGET_REF]);

  const duplicate = await worker.fetch(authorized('https://api.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }), communityEnv(db));
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).alreadyReported, true);
  assert.equal(db.reports.size, 1);
});

test('block filtering hides a player and unblock restores the row', async () => {
  const db = new Db();
  const blocked = await worker.fetch(authorized('https://api.example/v1/blocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerRef: TARGET_REF }),
  }), communityEnv(db));
  assert.equal(blocked.status, 200);

  const hiddenBoard = await worker.fetch(authorized('https://api.example/v1/board'), communityEnv(db));
  const hidden = await hiddenBoard.json();
  assert.deepEqual(hidden.top, []);
  assert.deepEqual(hidden.blocked, [{ playerRef: TARGET_REF, name: 'Target' }]);
  const filteredQuery = db.allCalls.find(call => call.sql.includes('NOT EXISTS'));
  assert.ok(filteredQuery, 'authenticated board must filter the viewer block list in SQL');
  const blockedQuery = db.allCalls.find(call => call.sql.includes('FROM account_blocks b'));
  assert.match(blockedQuery.sql, /p\.terms_version=\?/);
  assert.match(blockedQuery.sql, /p\.leaderboard_status='active'/);

  const unblocked = await worker.fetch(authorized(`https://api.example/v1/blocks/${TARGET_REF}`, {
    method: 'DELETE',
  }), communityEnv(db));
  assert.equal(unblocked.status, 200);
  const restoredBoard = await worker.fetch(authorized('https://api.example/v1/board'), communityEnv(db));
  const restored = await restoredBoard.json();
  assert.equal(restored.top.length, 1);
  assert.equal(restored.top[0].playerRef, TARGET_REF);
});

test('moderation API requires its server secret and can action a report', async () => {
  const db = new Db();
  const rejected = await worker.fetch(new Request('https://api.example/v1/admin/reports'), {
    DB: db,
    MODERATION_ADMIN_TOKEN: ADMIN_TOKEN,
  });
  assert.equal(rejected.status, 401);

  const actioned = await worker.fetch(new Request('https://api.example/v1/admin/reports/7', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'actioned',
      moderatorNote: 'Score reviewed.',
      leaderboardAction: 'suspend',
    }),
  }), {
    DB: db,
    MODERATION_ADMIN_TOKEN: ADMIN_TOKEN,
  });
  assert.equal(actioned.status, 200);
  assert.deepEqual(await actioned.json(), {
    ok: true,
    reportId: 7,
    status: 'actioned',
    leaderboardAction: 'suspend',
  });
  assert.equal(db.batches.length, 1);
  assert.match(db.batches[0][0].sql, /UPDATE community_reports/);
  assert.deepEqual(db.batches[0][1].args, ['suspended', TARGET_ID]);
});

test('legal acceptance endpoints fail closed until publisher facts are configured', async () => {
  const legal = await worker.fetch(new Request('https://api.example/v1/legal'), {});
  assert.equal(legal.status, 503);
  assert.equal((await legal.json()).error, 'legal_unavailable');

  const register = await worker.fetch(new Request('https://api.example/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'LaunchTester',
      password: 'very-long-password',
      acceptTerms: true,
      termsVersion: TERMS_VERSION,
    }),
  }), {});
  assert.equal(register.status, 503);
  assert.equal((await register.json()).error, 'legal_unavailable');
});
