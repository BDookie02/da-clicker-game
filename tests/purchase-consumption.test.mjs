import test from 'node:test';
import assert from 'node:assert/strict';
import { completeAndroidConsumption } from '../server/worker.js';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); }
  bind(...args) { this.args = args; return this; }
  async run() { this.db.writes.push({ sql: this.sql, args: this.args }); return { success: true }; }
}

const db = () => ({
  writes: [],
  prepare(sql) { return new Statement(this, sql); },
});

test('failed Google consumption is durable and grants nothing', async () => {
  const DB = db();
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith(':consume')) return new Response('try later', { status: 503 });
    return Response.json({ consumptionState: 0 });
  };
  const consumed = await completeAndroidConsumption({
    env: { DB }, verifyUrl: 'https://google/purchase', access: 'token',
    transactionId: 'GPA.pending', consumptionState: 0, fetcher,
  });
  assert.equal(consumed, false);
  assert.deepEqual(calls, ['https://google/purchase:consume', 'https://google/purchase']);
  assert.equal(DB.writes.length, 1);
  assert.deepEqual(DB.writes[0].args.slice(0, 2), ['GPA.pending', 0]);
});

test('a retry can complete a previously pending consumption exactly once', async () => {
  const DB = db();
  let calls = 0;
  const consumed = await completeAndroidConsumption({
    env: { DB }, verifyUrl: 'https://google/purchase', access: 'token',
    transactionId: 'GPA.retry', consumptionState: 0,
    fetcher: async () => { calls += 1; return new Response(null, { status: 200 }); },
  });
  assert.equal(consumed, true);
  assert.equal(calls, 1);
  assert.deepEqual(DB.writes[0].args, ['GPA.retry', 1, null]);
});

test('already-consumed purchases never call Google consume again', async () => {
  const DB = db();
  const consumed = await completeAndroidConsumption({
    env: { DB }, verifyUrl: 'https://google/purchase', access: 'token',
    transactionId: 'GPA.done', consumptionState: 1,
    fetcher: async () => { throw new Error('must not be called'); },
  });
  assert.equal(consumed, true);
  assert.deepEqual(DB.writes[0].args, ['GPA.done', 1, null]);
});
