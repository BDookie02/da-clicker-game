import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';

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
    return null;
  }
}

class MockDb {
  firstCalls = [];
  batches = [];

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
    'DELETE FROM ad_rewards WHERE account_id=?',
    'DELETE FROM purchases WHERE account_id=?',
    'DELETE FROM scores WHERE account_id=?',
    'DELETE FROM cloud_saves WHERE account_id=?',
    'DELETE FROM sessions WHERE account_id=?',
    'DELETE FROM accounts WHERE id=?',
  ]);
  assert.deepEqual(db.batches[0].map(statement => statement.args), [
    [42], [42], [42], [42], [42], [42],
  ]);
});
