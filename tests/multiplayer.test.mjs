import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_PVP_REWARDED_PAIR_RESULTS_PER_24H,
  MAX_PVP_REWARDED_WINS_PER_24H,
  MAX_PVP_TAPS_PER_SECOND,
  PVP_TAP_MIN_WRITE_INTERVAL_MS,
  MAX_PVP_ROUNDS,
  MAX_FRIEND_RELATIONSHIPS,
  MAX_PVP_MATCH_HISTORY,
  TAP_COMMIT_BARRIER_MS,
  TAP_SUBMISSION_GRACE_MS,
  PVP_REWARD_MENTALITY,
  comparePvPRound,
  decidePvPRound,
  nextTiebreakerPhase,
  normalizeFriendCode,
  projectPublicMatch,
  tapSettlementReadyAt,
  validatePvPInvite,
  verifiedPvPTapCount,
} from '../server/multiplayer.js';
import {
  QUICK_DRAW_MAX_RTT_ADJUSTMENT_MS,
  boundedQuickDrawRttAdjustment,
} from '../server/quick-draw-room.js';

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
  assert.equal(PVP_TAP_MIN_WRITE_INTERVAL_MS, 750);
  assert.equal(verifiedPvPTapCount(5, start, end, start), 5);
  assert.equal(verifiedPvPTapCount(30, start, end, start + 1000), 30);
  assert.equal(verifiedPvPTapCount(31, start, end, start + 1000), null);
  assert.equal(verifiedPvPTapCount(9999, start, end, end + 5000), null);
});

test('tap submission grace is long enough for the final cumulative upload', () => {
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  assert.equal(TAP_SUBMISSION_GRACE_MS, 2500);
  assert.equal(TAP_COMMIT_BARRIER_MS, 1500);
  assert.equal(tapSettlementReadyAt({
    phase_ends_at: 40_000, tap_commit_barrier_until: null,
  }), 42_500);
  assert.equal(tapSettlementReadyAt({
    phase_ends_at: 40_000, tap_commit_barrier_until: 43_100,
  }), 43_100, 'an in-flight final commit must delay stale GET settlement');
  assert.match(multiplayerSource,
    /phase_ends_at\) \+ TAP_SUBMISSION_GRACE_MS/);
  assert.match(multiplayerSource,
    /match\.phase === 'tap' && now < tapSettlementReadyAt\(match\)/);
  const recordTaps = multiplayerSource.slice(multiplayerSource.indexOf('async function recordTaps'));
  assert.ok(recordTaps.indexOf('SET tap_commit_barrier_until=MAX')
    < recordTaps.indexOf('const match = await matchById'),
  'the D1 barrier must serialize before a final tap reads mutable match state');
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

test('round state makes one-sided participation a forfeit and prevents endless tiebreakers', () => {
  assert.deepEqual(decidePvPRound('tap', null, null, 1),
    { kind: 'cancelled', reason: 'no_input' });
  assert.deepEqual(decidePvPRound('tap', { tap_count: 1 }, null, 1),
    { kind: 'winner', comparison: 1, reason: 'incomplete_round' });
  assert.deepEqual(decidePvPRound('quick_draw', null, { reaction_ms: 240 }, 1),
    { kind: 'winner', comparison: -1, reason: 'incomplete_round' });
  assert.deepEqual(decidePvPRound('quick_draw', { reaction_ms: -1 }, null, 1),
    { kind: 'winner', comparison: 1, reason: 'incomplete_round' });
  assert.deepEqual(decidePvPRound('tap', { tap_count: 0 }, { tap_count: 0 }, 1),
    { kind: 'cancelled', reason: 'no_input' });
  assert.deepEqual(decidePvPRound('tap', { tap_count: 0 }, { tap_count: 1 }, 1),
    { kind: 'winner', comparison: -1, reason: 'incomplete_round' });
  assert.deepEqual(decidePvPRound('quick_draw', { reaction_ms: -1 }, { reaction_ms: 240 }, 1),
    { kind: 'winner', comparison: -1 },
    'an early Quick Draw tap is a participated foul, not a missing submission');
  assert.deepEqual(decidePvPRound('tap', { tap_count: 10 }, { tap_count: 10 }, 1),
    { kind: 'tiebreaker' });
  assert.equal(MAX_PVP_ROUNDS, 2, 'a match gets exactly one opposite-mode tiebreaker');
  assert.deepEqual(decidePvPRound('quick_draw', { reaction_ms: 200 }, { reaction_ms: 200 }, 2),
    { kind: 'cancelled', reason: 'tie_limit' },
    'a tied Quick Draw tiebreaker must not schedule a third tap round');
  assert.deepEqual(decidePvPRound('tap', { tap_count: 10 }, { tap_count: 10 }, MAX_PVP_ROUNDS),
    { kind: 'cancelled', reason: 'tie_limit' });
});

test('Quick Draw projection withholds every timestamp that can reveal DRAW', () => {
  const row = {
    id: 'a'.repeat(32), opponent_code: 'A1B2C3D4', opponent_username: 'RIVAL',
    inviter_account_id: 1, invitee_account_id: 2, mode: 'quick_draw', duration_seconds: 0,
    status: 'active', phase: 'quick_draw', round_number: 1,
    phase_starts_at: 1_000, phase_ends_at: 8_000, draw_at: 3_000,
    my_tap_count: 0, opponent_tap_count: 0, my_reaction_ms: null,
    opponent_reaction_ms: null, winner_account_id: null,
  };
  const waiting = projectPublicMatch(row, 1, 2_999);
  assert.equal(waiting.drawReady, false);
  assert.equal(Object.hasOwn(waiting, 'drawAt'), false);
  assert.equal(waiting.phaseEndsAt, 10_950);
  assert.notEqual(waiting.phaseEndsAt, row.phase_ends_at);
  assert.equal(waiting.opponentTapCount, null,
    'live opponent scores must stay hidden so a client cannot snipe by one tap');

  const issuedRow = { ...row, quick_draw_issued_at: 3_000 };
  const ready = projectPublicMatch(issuedRow, 1, 3_000);
  assert.equal(ready.drawReady, true);
  assert.equal(Object.hasOwn(ready, 'drawAt'), false);
  assert.equal(ready.phaseEndsAt, row.phase_ends_at);

  const opponentCommitted = projectPublicMatch({
    ...issuedRow, opponent_reaction_ms: 240,
  }, 1, 3_100);
  assert.equal(opponentCommitted.opponentReactionMs, null,
    'an uncommitted player must not learn the opponent result');
  const bothCommitted = projectPublicMatch({
    ...issuedRow, my_reaction_ms: 260, opponent_reaction_ms: 240,
  }, 1, 3_100);
  assert.equal(bothCommitted.opponentReactionMs, 240);
});

test('Quick Draw RTT normalization is median-based, sample-gated, and tightly capped', () => {
  assert.equal(boundedQuickDrawRttAdjustment([80, 100]), 0,
    'fewer than three pre-round samples must earn no latency credit');
  assert.equal(boundedQuickDrawRttAdjustment([80, 100, 120]), 50);
  assert.equal(boundedQuickDrawRttAdjustment([10, 12, 14, 2000, 2000]), 7,
    'outlier-delayed pongs must not control a five-sample median');
  assert.equal(boundedQuickDrawRttAdjustment([1000, 1000, 1000]),
    QUICK_DRAW_MAX_RTT_ADJUSTMENT_MS,
  'a client that deliberately delays every pong receives only the fixed cap');
});

test('Quick Draw winner uses raw server receipt time and RTT remains telemetry only', () => {
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  const roomSource = readFileSync(new URL('../server/quick-draw-room.js', import.meta.url), 'utf8');
  assert.match(multiplayerSource,
    /const normalizedRaw = Number\(rawReactionMs\) < 0 \? -1[\s\S]*?const normalizedReaction = normalizedRaw;/);
  assert.match(roomSource,
    /adjustment = boundedQuickDrawRttAdjustment\(attachment\.rttSamples\);[\s\S]*?reactionMs = rawReactionMs;/);
  assert.doesNotMatch(roomSource, /reactionMs = Math\.max\(0, rawReactionMs - adjustment\)/);
});

test('reward gate is atomic, participation-backed, and enforces exact rolling limits', () => {
  const source = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  assert.equal(MAX_PVP_REWARDED_WINS_PER_24H, 10);
  assert.equal(MAX_PVP_REWARDED_PAIR_RESULTS_PER_24H, 1);
  const gate = source.slice(source.indexOf('function rewardInsertStatement'),
    source.indexOf('async function completeMatch'));
  assert.match(gate, /INSERT OR IGNORE INTO pvp_rewards\(/);
  assert.match(gate, /pair_low_account_id,pair_high_account_id/);
  assert.match(gate, /recent\.awarded_at>=datetime\('now','-24 hours'\)\)<\?/);
  assert.match(gate, /recent_pair\.awarded_at>=datetime\('now','-24 hours'\)\)<\?/);
  assert.equal((gate.match(/EXISTS \(SELECT 1 FROM pvp_round_scores participated/g) || []).length, 2,
    'both players need durable participation evidence from any round');
  assert.match(gate, /participated\.tap_count>0 OR participated\.reaction_ms IS NOT NULL/);
  assert.match(source,
    /return env\.DB\.batch\(\[[\s\S]*?UPDATE pvp_matches SET status='completed'[\s\S]*?rewardInsertStatement/,
    'terminal transition and eligibility-gated reward must share one D1 batch');
  assert.doesNotMatch(source, /wager/i);
});

test('migration 0018 backfills unordered pairs and decouples reward history from matches', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE accounts(id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO accounts(id) VALUES(1),(2);
    CREATE TABLE pvp_matches(
      id TEXT PRIMARY KEY,
      inviter_account_id INTEGER NOT NULL,
      invitee_account_id INTEGER NOT NULL
    );
    INSERT INTO pvp_matches VALUES('historic-match',2,1);
    CREATE TABLE pvp_rewards(
      match_id TEXT PRIMARY KEY,
      winner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      mentality_amount INTEGER NOT NULL DEFAULT 5 CHECK(mentality_amount=5),
      awarded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_pvp_rewards_winner ON pvp_rewards(winner_account_id,awarded_at DESC);
    INSERT INTO pvp_rewards(match_id,winner_account_id) VALUES('historic-match',1);
  `);
  const migration = readFileSync(new URL(
    '../server/migrations/0018_pvp_reward_forfeit_hardening.sql', import.meta.url,
  ), 'utf8');
  sqlite.exec(migration);
  const row = sqlite.prepare('SELECT * FROM pvp_rewards').get();
  assert.equal(row.pair_low_account_id, 1);
  assert.equal(row.pair_high_account_id, 2);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count
    FROM pragma_foreign_key_list('pvp_rewards')`).get().count, 0);
  sqlite.exec(`DELETE FROM pvp_matches WHERE id='historic-match'`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM pvp_rewards').get().count, 1);
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_pvp_rewards_pair'`).get());
});

test('relationship-ending actions forfeit active matches and cancel only invitations', () => {
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  const workerSource = readFileSync(new URL('../server/worker.js', import.meta.url), 'utf8');
  const helper = multiplayerSource.slice(multiplayerSource.indexOf('export async function settlePvPForfeit'),
    multiplayerSource.indexOf('export async function settlePvPAccountDeparture'));
  assert.match(helper, /WHERE status='invited'/);
  assert.match(helper, /WHERE status='active'/);
  assert.match(helper, /completeMatch\([\s\S]*?pending\?\.reason \|\| reason, true/,
    'relationship-departure settlement must use the explicit guarded-CAS bypass');
  assert.match(multiplayerSource,
    /DELETE FROM friendships[\s\S]*?pvpForfeitIntentStatement\(env, account\.id, target\.id, 'friend_removed'\)[\s\S]*?\]\);/,
    'friend removal and durable forfeit intent must commit in one D1 batch');
  assert.match(workerSource,
    /INSERT OR IGNORE INTO account_blocks[\s\S]*?pvpForfeitIntentStatement\(env, account\.id, target\.id, 'blocked_player'\)[\s\S]*?\]\);/,
    'blocking and durable forfeit intent must commit in one D1 batch');
  assert.match(multiplayerSource, /AND \$\{match\}\.result_reason IS NULL/,
    'ordinary match CAS writes must reject a durable departure intent');
  assert.match(multiplayerSource, /settlePvPForfeit\(env, account\.id, target\.id, 'friend_removed'\)/);
  assert.match(workerSource, /settlePvPForfeit\(env, account\.id, target\.id, 'blocked_player'\)/);
  assert.match(workerSource, /settlePvPAccountDeparture\(env, account\.id\)/);
  assert.match(workerSource,
    /DELETE FROM pvp_rewards WHERE winner_account_id=\?[\s\S]*?UPDATE pvp_rewards SET pair_low_account_id=NULL,pair_high_account_id=NULL/,
    'deletion removes the deleted winner while preserving an opponent reward without the deleted pair ID');
});

test('Quick Draw realtime uses one-use tickets, nonce-bound responses, and D1 audit fields', () => {
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  const roomSource = readFileSync(new URL('../server/quick-draw-room.js', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../server/migrations/0014_quick_draw_realtime.sql', import.meta.url), 'utf8');
  const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(multiplayerSource,
    /used_at_ms IS NULL[\s\S]*?UPDATE pvp_socket_tickets SET used_at_ms=\?/,
    'the unauthenticated upgrade path must consume a short-lived ticket exactly once');
  assert.match(multiplayerSource,
    /LEFT JOIN account_deletion_jobs deletion[\s\S]*?error: 'account_deletion_pending'[\s\S]*?UPDATE pvp_socket_tickets[\s\S]*?NOT EXISTS \(SELECT 1 FROM account_deletion_jobs/,
    'ticket-authenticated WebSocket upgrades must honor the account deletion gate too');
  assert.match(roomSource, /this\.ctx\.acceptWebSocket\(server, \[`account:\$\{accountId\}`\]\)/);
  assert.match(roomSource, /socket\.serializeAttachment\(attachment\)/,
    'connection identity and ping state must survive hibernation');
  assert.match(roomSource,
    /body\?\.type !== 'draw_response'[\s\S]*?body\.nonce !== nonce/,
    'a post-DRAW score must present the room nonce');
  assert.match(roomSource, /transport: 'websocket'/);
  assert.match(schema, /raw_reaction_ms INTEGER[\s\S]*?rtt_adjustment_ms INTEGER[\s\S]*?reaction_transport TEXT/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pvp_socket_tickets/);
  assert.match(wrangler, /\[\[durable_objects\.bindings\]\][\s\S]*?name = "QUICK_DRAW_ROOMS"/);
  assert.match(wrangler, /\[exports\.QuickDrawRoom\][\s\S]*?storage = "sqlite"/);
});

test('PvP hardening migration uses transactional player locks and terminal release triggers', () => {
  const migration = readFileSync(new URL('../server/migrations/0010_pvp_hardening.sql', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /WHERE status IN \('invited','active'\)/,
    'pre-lock matches must be closed instead of bypassing the lock table');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pvp_player_locks/);
  assert.match(migration, /account_id INTEGER PRIMARY KEY/);
  assert.match(migration, /AFTER UPDATE OF status ON pvp_matches/);
  assert.match(migration, /DELETE FROM pvp_player_locks WHERE match_id=NEW\.id/);
  assert.match(migration, /idx_pvp_matches_status_created/);
  assert.match(migration, /idx_pvp_matches_status_updated/);
});

test('tap settlement barrier is present in both fresh schema and migration chain', () => {
  const schema = readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../server/migrations/0013_pvp_tap_commit_barrier.sql', import.meta.url), 'utf8');
  assert.match(schema, /tap_commit_barrier_until INTEGER/);
  assert.match(migration, /ALTER TABLE pvp_matches ADD COLUMN tap_commit_barrier_until INTEGER/);
});

test('friend graph and cleanup work are bounded and invite eligibility is atomic', () => {
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  assert.equal(MAX_FRIEND_RELATIONSHIPS, 200);
  assert.equal(MAX_PVP_MATCH_HISTORY, 20);
  assert.match(multiplayerSource,
    /FROM friendships f[\s\S]*?ORDER BY f\.updated_at DESC[\s\S]*?LIMIT \?`\)\.bind\(accountId, accountId, accountId, MAX_FRIEND_RELATIONSHIPS\)/);
  assert.match(multiplayerSource,
    /INSERT INTO friendships\([\s\S]*?SELECT COUNT\(\*\) FROM friendships[\s\S]*?MAX_FRIEND_RELATIONSHIPS/,
    'friend capacity must be enforced inside the inserting statement');
  const pvpRowsSource = multiplayerSource.slice(
    multiplayerSource.indexOf('async function pvpRows'),
    multiplayerSource.indexOf('export function projectPublicMatch'),
  );
  const staleGuardAt = pvpRowsSource.indexOf('if (staleInvite)');
  const scopedCleanupAt = pvpRowsSource.indexOf('expireStaleMatches(env, [accountId])');
  assert.ok(staleGuardAt >= 0 && scopedCleanupAt > staleGuardAt,
    'state GET cleanup must be guarded by a read that found a stale invite');
  assert.doesNotMatch(pvpRowsSource.slice(0, staleGuardAt), /expireStaleMatches/,
    'high-frequency state GETs must not run cleanup unconditionally');
  assert.doesNotMatch(pvpRowsSource, /expireStaleMatches\(env\s*\)/,
    'state GET cleanup must never use the global cleanup form');
  assert.match(multiplayerSource,
    /async function expireStaleMatches\(env, rawAccountIds\)[\s\S]*?inviter_account_id IN \(\$\{placeholders\}\)/,
    'mutation-time cleanup must be restricted to involved accounts');
  assert.match(multiplayerSource,
    /const staleInvite = [\s\S]*?if \(staleInvite\) \{[\s\S]*?expireStaleMatches\(env, \[accountId\]\)/,
    'GET cleanup may run only after a bounded read proves this account has a stale invite');
  assert.match(multiplayerSource,
    /INSERT INTO pvp_matches\([\s\S]*?SELECT \?,\?,\?,\?,\?[\s\S]*?WHERE EXISTS \(SELECT 1 FROM friendships[\s\S]*?NOT EXISTS \(SELECT 1 FROM account_blocks/,
    'friendship and block eligibility must be rechecked by the match INSERT');
});

test('Worker entrypoint keeps constants out of named exports and ties rewards to eligible completion', () => {
  const workerSource = readFileSync(new URL('../server/worker.js', import.meta.url), 'utf8');
  const multiplayerSource = readFileSync(new URL('../server/multiplayer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(workerSource, /export\s+const\s+(?:TERMS_VERSION|REFERRAL_REWARD_LIMIT|REFERRAL_RATE_LIMIT_TEST_HOOK)/);
  assert.match(workerSource, /import\s+\{\s*TERMS_VERSION\s*\}\s+from\s+'\.\/constants\.js'/);
  assert.match(multiplayerSource,
    /INSERT OR IGNORE INTO pvp_rewards[\s\S]*?m\.status='completed'[\s\S]*?recent\.awarded_at/);
  assert.match(multiplayerSource,
    /WHERE excluded\.tap_count>pvp_round_scores\.tap_count/,
    'equal or lower score replays must not mutate the match revision');
  assert.match(multiplayerSource,
    /stored\.account_id=\? AND stored\.tap_count>=\?/,
    'equal or lower score replays must not arm or extend the commit barrier');
  assert.match(multiplayerSource,
    /s\.account_id=\? AND s\.updated_at_ms=\?/,
    'a revision bump must be tied to the score row changed by this request');
});
