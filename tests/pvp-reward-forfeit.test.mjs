import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  commitQuickDrawScore,
  handleMultiplayerRoute,
  MAX_PVP_REWARDED_WINS_PER_24H,
  PVP_TAP_MIN_WRITE_INTERVAL_MS,
  pvpForfeitIntentStatement,
  resolveMatch,
  settlePvPAccountDeparture,
  settlePvPForfeit,
} from '../server/multiplayer.js';

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first(column) {
    const row = this.db.sqlite.prepare(this.sql).get(...this.args) || null;
    return column && row ? row[column] : row;
  }
  all() {
    return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args) };
  }
  run() {
    const result = this.db.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) { return new D1Statement(this, sql); }
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

function seedAccounts(DB, ids) {
  const insert = DB.sqlite.prepare(`INSERT INTO accounts(
    id,username,lower_username,password_salt,password_hash) VALUES(?,?,?,?,?)`);
  for (const id of ids) insert.run(id, `Player${id}`, `player${id}`, 'salt', 'hash');
}

function seedAcceptedFriendship(DB, first, second) {
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  DB.sqlite.prepare(`INSERT INTO friendships(
    account_low_id,account_high_id,requested_by_account_id,status)
    VALUES(?,?,?,'accepted')`).run(low, high, first);
}

function seedActiveTapMatch(DB, id, inviter, invitee, participation = 'both') {
  const now = Date.now();
  DB.sqlite.prepare(`INSERT INTO pvp_matches(
    id,inviter_account_id,invitee_account_id,mode,duration_seconds,status,
    phase,round_number,phase_starts_at,phase_ends_at)
    VALUES(?,?,?,'tap',30,'active','tap',1,?,?)`)
    .run(id, inviter, invitee, now - 35_000, now - 5_000);
  if (participation === 'both' || participation === 'inviter') {
    DB.sqlite.prepare(`INSERT INTO pvp_round_scores(
      match_id,round_number,account_id,tap_count,updated_at_ms) VALUES(?,1,?,?,?)`)
      .run(id, inviter, 25, now - 5_000);
  }
  if (participation === 'both' || participation === 'invitee') {
    DB.sqlite.prepare(`INSERT INTO pvp_round_scores(
      match_id,round_number,account_id,tap_count,updated_at_ms) VALUES(?,1,?,?,?)`)
      .run(id, invitee, 20, now - 5_000);
  }
}

test('active relationship termination is an idempotent forfeit with the same reward gate', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedActiveTapMatch(DB, 'a'.repeat(32), 1, 2, 'both');

  assert.equal(await settlePvPForfeit({ DB }, 1, 2, 'friend_removed'), true);
  const match = DB.sqlite.prepare(`SELECT status,winner_account_id,result_reason
    FROM pvp_matches`).get();
  assert.equal(match.status, 'completed');
  assert.equal(match.winner_account_id, 2);
  assert.equal(match.result_reason, 'friend_removed');
  const reward = DB.sqlite.prepare(`SELECT winner_account_id,pair_low_account_id,
    pair_high_account_id,mentality_amount FROM pvp_rewards`).get();
  assert.equal(reward.winner_account_id, 2);
  assert.equal(reward.pair_low_account_id, 1);
  assert.equal(reward.pair_high_account_id, 2);
  assert.equal(reward.mentality_amount, 5);
  await settlePvPForfeit({ DB }, 1, 2, 'friend_removed');
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM pvp_rewards').get().count, 1);
});

test('pre-input forfeit completes with zero reward and an invitation only cancels', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2, 3]);
  seedActiveTapMatch(DB, 'b'.repeat(32), 1, 2, 'none');
  await settlePvPForfeit({ DB }, 1, 2, 'blocked_player');
  assert.equal(DB.sqlite.prepare(`SELECT winner_account_id FROM pvp_matches
    WHERE id=?`).get('b'.repeat(32)).winner_account_id, 2);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM pvp_rewards').get().count, 0,
    'both players need durable participation before any forfeit reward');

  DB.sqlite.prepare(`INSERT INTO pvp_matches(
    id,inviter_account_id,invitee_account_id,mode,duration_seconds)
    VALUES(?,?,?,'tap',30)`).run('c'.repeat(32), 2, 3);
  await settlePvPForfeit({ DB }, 2, 3, 'friend_removed');
  const invited = DB.sqlite.prepare(`SELECT status,winner_account_id FROM pvp_matches
    WHERE id=?`).get('c'.repeat(32));
  assert.equal(invited.status, 'cancelled');
  assert.equal(invited.winner_account_id, null);
});

test('one pair earns only once per rolling day while later matches still complete', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  for (let index = 0; index < 2; index += 1) {
    const id = String(index + 1).repeat(32);
    seedActiveTapMatch(DB, id, 1, 2, 'both');
    await settlePvPForfeit({ DB }, 1, 2, 'friend_removed');
  }
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM pvp_matches
    WHERE status='completed'`).get().count, 2);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM pvp_rewards').get().count, 1);
});

test('winner rolling-day cap is exactly ten across distinct opponents', async () => {
  const DB = new D1Database();
  const winner = 1;
  const opponents = Array.from({ length: MAX_PVP_REWARDED_WINS_PER_24H + 1 }, (_, i) => i + 2);
  seedAccounts(DB, [winner, ...opponents]);
  for (let index = 0; index < opponents.length; index += 1) {
    const opponent = opponents[index];
    const id = (index + 1).toString(16).padStart(32, '0');
    seedActiveTapMatch(DB, id, opponent, winner, 'both');
    await settlePvPForfeit({ DB }, opponent, winner, 'friend_removed');
  }
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM pvp_rewards').get().count,
    MAX_PVP_REWARDED_WINS_PER_24H);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM pvp_matches
    WHERE status='completed'`).get().count, opponents.length);
});

test('account departure forfeits before deletion and leaves the opponent reward erasable by policy', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedActiveTapMatch(DB, 'd'.repeat(32), 1, 2, 'both');
  await settlePvPAccountDeparture({ DB }, 1);
  assert.equal(DB.sqlite.prepare(`SELECT winner_account_id FROM pvp_matches`).get().winner_account_id, 2);
  assert.equal(DB.sqlite.prepare(`SELECT winner_account_id FROM pvp_rewards`).get().winner_account_id, 2);
});

test('committed friend removal defeats a stale normal resolver and preserves the forfeit outcome', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedAcceptedFriendship(DB, 1, 2);
  const id = 'e'.repeat(32);
  seedActiveTapMatch(DB, id, 1, 2, 'both');
  const staleMatch = DB.sqlite.prepare('SELECT * FROM pvp_matches WHERE id=?').get(id);
  DB.batch([
    DB.prepare(`DELETE FROM friendships
      WHERE account_low_id=1 AND account_high_id=2`),
    pvpForfeitIntentStatement({ DB }, 1, 2, 'friend_removed'),
  ]);
  // Even an immediate re-friend cannot erase the departure that was recorded
  // atomically with removal.
  seedAcceptedFriendship(DB, 1, 2);

  await resolveMatch({ DB }, staleMatch, Date.now());
  assert.equal(DB.sqlite.prepare('SELECT status FROM pvp_matches WHERE id=?').get(id).status,
    'active', 'normal completion must fail after the relationship mutation commits');
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM pvp_rewards').get().count, 0);

  await settlePvPForfeit({ DB }, 1, 2, 'friend_removed');
  const result = DB.sqlite.prepare(`SELECT status,winner_account_id,result_reason
    FROM pvp_matches WHERE id=?`).get(id);
  assert.equal(result.status, 'completed');
  assert.equal(result.winner_account_id, 2);
  assert.equal(result.result_reason, 'friend_removed');
});

test('deletion intent defeats a stale normal resolver before account-departure settlement', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedAcceptedFriendship(DB, 1, 2);
  const id = 'f'.repeat(32);
  seedActiveTapMatch(DB, id, 1, 2, 'both');
  const staleMatch = DB.sqlite.prepare('SELECT * FROM pvp_matches WHERE id=?').get(id);
  DB.sqlite.prepare('INSERT INTO account_deletion_jobs(account_id) VALUES(1)').run();

  await resolveMatch({ DB }, staleMatch, Date.now());
  assert.equal(DB.sqlite.prepare('SELECT status FROM pvp_matches WHERE id=?').get(id).status,
    'active', 'normal completion must fail after deletion intent is durable');
  await settlePvPAccountDeparture({ DB }, 1);
  assert.equal(DB.sqlite.prepare('SELECT winner_account_id FROM pvp_matches WHERE id=?').get(id)
    .winner_account_id, 2);
});

test('an already-open Quick Draw socket cannot commit after either player begins deletion', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedAcceptedFriendship(DB, 1, 2);
  const id = '9'.repeat(32);
  const now = Date.now();
  DB.sqlite.prepare(`INSERT INTO pvp_matches(
    id,inviter_account_id,invitee_account_id,mode,duration_seconds,status,
    phase,round_number,phase_starts_at,phase_ends_at,quick_draw_issued_at)
    VALUES(?,?,?,'quick_draw',0,'active','quick_draw',1,?,?,?)`)
    .run(id, 1, 2, now - 2_000, now + 4_000, now - 500);
  const revision = DB.sqlite.prepare('SELECT state_revision FROM pvp_matches WHERE id=?').get(id)
    .state_revision;
  DB.sqlite.prepare('INSERT INTO account_deletion_jobs(account_id) VALUES(1)').run();

  const result = await commitQuickDrawScore({ DB }, {
    matchId: id,
    accountId: 1,
    roundNumber: 1,
    submittedAt: now,
    reactionMs: 500,
    rawReactionMs: 500,
    rttAdjustmentMs: 0,
    transport: 'websocket',
  });
  assert.deepEqual(result, { ok: false, error: 'pvp_state_changed' });
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM pvp_round_scores
    WHERE match_id=?`).get(id).count, 0);
  assert.equal(DB.sqlite.prepare('SELECT state_revision FROM pvp_matches WHERE id=?').get(id)
    .state_revision, revision);
});

test('equal tap retries do not arm the commit barrier or advance match revision', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedAcceptedFriendship(DB, 1, 2);
  const id = '8'.repeat(32);
  const now = Date.now();
  DB.sqlite.prepare(`INSERT INTO pvp_matches(
    id,inviter_account_id,invitee_account_id,mode,duration_seconds,status,
    phase,round_number,phase_starts_at,phase_ends_at)
    VALUES(?,?,?,'tap',30,'active','tap',1,?,?)`)
    .run(id, 1, 2, now - 1_000, now + 250);
  DB.sqlite.prepare(`INSERT INTO pvp_round_scores(
    match_id,round_number,account_id,tap_count,updated_at_ms) VALUES(?,1,1,10,?)`)
    .run(id, now - 100);
  const before = DB.sqlite.prepare(`SELECT state_revision,tap_commit_barrier_until
    FROM pvp_matches WHERE id=?`).get(id);
  const response = await handleMultiplayerRoute({
    method: 'POST',
    json: async () => ({ count: 10 }),
  }, new URL(`https://api.example/v1/pvp/${id}/tap`), { DB }, { id: 1 }, '2026-08-24');
  assert.equal(response.status, 200);
  const after = DB.sqlite.prepare(`SELECT state_revision,tap_commit_barrier_until
    FROM pvp_matches WHERE id=?`).get(id);
  assert.deepEqual(after, before);
});

test('rapid increasing tap snapshots are write-coalesced but the final cumulative flush wins', async () => {
  const DB = new D1Database();
  seedAccounts(DB, [1, 2]);
  seedAcceptedFriendship(DB, 1, 2);
  const id = '7'.repeat(32);
  const now = Date.now();
  DB.sqlite.prepare(`INSERT INTO pvp_matches(
    id,inviter_account_id,invitee_account_id,mode,duration_seconds,status,
    phase,round_number,phase_starts_at,phase_ends_at)
    VALUES(?,?,?,'tap',30,'active','tap',1,?,?)`)
    .run(id, 1, 2, now - 1_000, now + 10_000);
  const submit = (count) => handleMultiplayerRoute({
    method: 'POST', json: async () => ({ count }),
  }, new URL(`https://api.example/v1/pvp/${id}/tap`), { DB }, { id: 1 }, '2026-08-24');

  assert.equal((await submit(1)).status, 200);
  const afterFirst = DB.sqlite.prepare(`SELECT state_revision,tap_commit_barrier_until
    FROM pvp_matches WHERE id=?`).get(id);
  assert.equal(afterFirst.state_revision, 1);
  assert.equal(afterFirst.tap_commit_barrier_until, null);
  for (let count = 2; count <= 20; count += 1)
    assert.equal((await submit(count)).status, 429, `rapid cumulative snapshot ${count}`);
  assert.equal(DB.sqlite.prepare(`SELECT tap_count FROM pvp_round_scores
    WHERE match_id=? AND account_id=1`).get(id).tap_count, 1);
  assert.deepEqual(DB.sqlite.prepare(`SELECT state_revision,tap_commit_barrier_until
    FROM pvp_matches WHERE id=?`).get(id), afterFirst,
  'rejected high-frequency snapshots must cause no score, revision, or barrier writes');

  DB.sqlite.prepare(`UPDATE pvp_round_scores SET updated_at_ms=?
    WHERE match_id=? AND account_id=1`).run(Date.now() - PVP_TAP_MIN_WRITE_INTERVAL_MS - 1, id);
  assert.equal((await submit(20)).status, 200);
  assert.equal(DB.sqlite.prepare(`SELECT tap_count FROM pvp_round_scores
    WHERE match_id=? AND account_id=1`).get(id).tap_count, 20);

  // A phase-close flush is allowed once across the deadline even if the last
  // ordinary one-second snapshot was recent, so coalescing cannot lose taps.
  DB.sqlite.prepare('DELETE FROM pvp_matches WHERE id=?').run(id);
  const finalId = '6'.repeat(32);
  const finalNow = Date.now();
  DB.sqlite.prepare(`INSERT INTO pvp_matches(
    id,inviter_account_id,invitee_account_id,mode,duration_seconds,status,
    phase,round_number,phase_starts_at,phase_ends_at)
    VALUES(?,?,?,'tap',30,'active','tap',1,?,?)`)
    .run(finalId, 1, 2, finalNow - 1_100, finalNow - 100);
  DB.sqlite.prepare(`INSERT INTO pvp_round_scores(
    match_id,round_number,account_id,tap_count,updated_at_ms) VALUES(?,1,1,1,?)`)
    .run(finalId, finalNow - 200);
  const finalResponse = await handleMultiplayerRoute({
    method: 'POST', json: async () => ({ count: 2 }),
  }, new URL(`https://api.example/v1/pvp/${finalId}/tap`), { DB }, { id: 1 }, '2026-08-24');
  assert.equal(finalResponse.status, 200);
  assert.equal(DB.sqlite.prepare(`SELECT tap_count FROM pvp_round_scores
    WHERE match_id=? AND account_id=1`).get(finalId).tap_count, 2);
});
