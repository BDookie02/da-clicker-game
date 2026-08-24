// Platform-neutral friends and server-authoritative PvP for DISCIPLINE.
// Google Play Games / Game Center may be linked later, but neither platform
// owns the friend graph or match identity, preserving Android/iOS cross-play.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});

export const PVP_REWARD_MENTALITY = 5;
export const MAX_PVP_REWARDED_WINS_PER_24H = 10;
export const MAX_PVP_REWARDED_PAIR_RESULTS_PER_24H = 1;
export const TAP_DURATIONS = Object.freeze([30, 60, 90]);
export const MAX_PVP_TAPS_PER_SECOND = 25;
export const TAP_SUBMISSION_GRACE_MS = 2500;
export const TAP_COMMIT_BARRIER_MS = 1500;
const TAP_COMMIT_ARM_LEAD_MS = 500;
// The official client coalesces cumulative snapshots to one second. Keep the
// server floor slightly lower so ordinary timer/network jitter is accepted,
// while a modified client cannot turn each physical tap into D1 writes.
export const PVP_TAP_MIN_WRITE_INTERVAL_MS = 750;
export const MAX_FRIEND_RELATIONSHIPS = 200;
export const MAX_PVP_MATCH_HISTORY = 20;
// The requested format has exactly one opposite-mode tiebreaker. A second tie
// ends the match without a winner instead of starting a third round.
export const MAX_PVP_ROUNDS = 2;
const QUICK_DRAW_MIN_DELAY_MS = 1800;
const QUICK_DRAW_MAX_DELAY_MS = 4200;
export const QUICK_DRAW_WINDOW_MS = 5000;
export const QUICK_DRAW_REST_FAILOVER_MS = 750;
const QUICK_DRAW_TICKET_TTL_MS = 30_000;
const validMatchId = (value) => /^[0-9a-f]{32}$/.test(String(value || ''));
const randomHex = (bytes) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const randomBetween = (minimum, maximum) => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return minimum + (value[0] % (maximum - minimum + 1));
};
const sha256Hex = async (value) => [...new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(String(value)),
))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function normalizeFriendCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-F0-9]/g, '');
  return /^[A-F0-9]{8}$/.test(code) ? code : '';
}

export function validatePvPInvite(mode, durationSeconds) {
  if (mode === 'quick_draw') return { mode, durationSeconds: 0 };
  const duration = Number(durationSeconds);
  return mode === 'tap' && TAP_DURATIONS.includes(duration)
    ? { mode, durationSeconds: duration }
    : null;
}

export function verifiedPvPTapCount(requested, phaseStartsAt, phaseEndsAt, now) {
  const count = Math.trunc(Number(requested));
  const start = Number(phaseStartsAt);
  const end = Number(phaseEndsAt);
  const at = Math.min(Number(now), end);
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(start)
      || !Number.isFinite(end) || at < start) return null;
  const maximum = 5 + Math.floor(Math.max(0, at - start) * MAX_PVP_TAPS_PER_SECOND / 1000);
  return count <= maximum ? count : null;
}

export function tapSettlementReadyAt(match) {
  return Math.max(
    Number(match?.phase_ends_at || 0) + TAP_SUBMISSION_GRACE_MS,
    Number(match?.tap_commit_barrier_until || 0),
  );
}

export function comparePvPRound(phase, first, second) {
  if (phase === 'tap') {
    const a = Math.max(0, Number(first?.tap_count) || 0);
    const b = Math.max(0, Number(second?.tap_count) || 0);
    return a === b ? 0 : a > b ? 1 : -1;
  }
  const reaction = (score) => {
    if (score?.reaction_ms === null || score?.reaction_ms === undefined) return Number.POSITIVE_INFINITY;
    const value = Number(score.reaction_ms);
    return value < 0 ? Number.POSITIVE_INFINITY : value;
  };
  const a = reaction(first);
  const b = reaction(second);
  return a === b ? 0 : a < b ? 1 : -1;
}

export const nextTiebreakerPhase = (phase) => phase === 'tap' ? 'quick_draw' : 'tap';

export function decidePvPRound(phase, first, second, roundNumber) {
  const participated = (score) => {
    if (score === null || score === undefined) return false;
    // The client performs a final cumulative upload even when the player never
    // tapped. A zero counter is therefore not participation and cannot help a
    // disposable/colluding account mint a rewarded 0-vs-1 result. In Quick
    // Draw an early press is real participation: it is the mode's explicit
    // foul condition and legitimately loses to a correctly timed draw.
    if (phase === 'tap') return Number(score.tap_count) > 0;
    return score.reaction_ms !== null && score.reaction_ms !== undefined;
  };
  const firstSubmitted = participated(first);
  const secondSubmitted = participated(second);
  if (!firstSubmitted && !secondSubmitted) return { kind: 'cancelled', reason: 'no_input' };
  // Once the authoritative deadline has passed, a player who took part beats
  // an opponent who did not. Reward farming from no-show accounts is bounded
  // separately and atomically by the winner and unordered-pair ledgers.
  if (firstSubmitted !== secondSubmitted) return {
    kind: 'winner', comparison: firstSubmitted ? 1 : -1,
    reason: 'incomplete_round',
  };
  const comparison = comparePvPRound(phase, first, second);
  if (comparison !== 0) return { kind: 'winner', comparison };
  if (Number(roundNumber) >= MAX_PVP_ROUNDS)
    return { kind: 'cancelled', reason: 'tie_limit' };
  return { kind: 'tiebreaker' };
}

async function ensureFriendCode(env, accountId) {
  let profile = await env.DB.prepare('SELECT friend_code FROM account_profiles WHERE account_id=?')
    .bind(accountId).first();
  if (profile?.friend_code) return String(profile.friend_code);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomHex(4).toUpperCase();
    try {
      await env.DB.prepare(`UPDATE account_profiles SET friend_code=?,updated_at=datetime('now')
        WHERE account_id=? AND friend_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs
            WHERE account_id=?)`).bind(code, accountId, accountId).run();
    } catch { /* unique collision; generate another */ }
    profile = await env.DB.prepare('SELECT friend_code FROM account_profiles WHERE account_id=?')
      .bind(accountId).first();
    if (profile?.friend_code) return String(profile.friend_code);
  }
  const deleting = await env.DB.prepare(`SELECT account_id FROM account_deletion_jobs
    WHERE account_id=?`).bind(accountId).first();
  if (deleting) throw new Error('account_deletion_pending');
  throw new Error('friend_code_unavailable');
}

const pair = (first, second) => Number(first) < Number(second)
  ? [Number(first), Number(second)] : [Number(second), Number(first)];

// This predicate is repeated inside the mutating SQL itself, not used as a
// preflight read. Once either account begins deletion, or either player
// removes/blocks the other, ordinary match resolution can no longer beat the
// dedicated forfeit settlement in a check-then-write race.
const activeMatchEligibilitySql = (match = 'pvp_matches') => `
  AND ${match}.result_reason IS NULL
  AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
    WHERE deleting.account_id=${match}.inviter_account_id
       OR deleting.account_id=${match}.invitee_account_id)
  AND EXISTS (SELECT 1 FROM friendships eligible_friendship
    WHERE eligible_friendship.account_low_id=CASE
        WHEN ${match}.inviter_account_id<${match}.invitee_account_id
          THEN ${match}.inviter_account_id ELSE ${match}.invitee_account_id END
      AND eligible_friendship.account_high_id=CASE
        WHEN ${match}.inviter_account_id<${match}.invitee_account_id
          THEN ${match}.invitee_account_id ELSE ${match}.inviter_account_id END
      AND eligible_friendship.status='accepted')
  AND NOT EXISTS (SELECT 1 FROM account_blocks disqualifying_block
    WHERE (disqualifying_block.blocker_account_id=${match}.inviter_account_id
        AND disqualifying_block.blocked_account_id=${match}.invitee_account_id)
       OR (disqualifying_block.blocker_account_id=${match}.invitee_account_id
        AND disqualifying_block.blocked_account_id=${match}.inviter_account_id))`;

const parseForfeitIntent = (match) => {
  if (match?.status !== 'active' || match.winner_account_id == null
      || !['friend_removed', 'blocked_player'].includes(String(match.result_reason || ''))) return null;
  const winner = Number(match.winner_account_id);
  if (winner !== Number(match.inviter_account_id) && winner !== Number(match.invitee_account_id))
    return null;
  return {
    winner,
    forfeiter: winner === Number(match.inviter_account_id)
      ? Number(match.invitee_account_id) : Number(match.inviter_account_id),
    reason: String(match.result_reason),
  };
};

export function pvpForfeitIntentStatement(env, forfeitingAccountId, opponentAccountId,
    reason = 'friend_removed') {
  return env.DB.prepare(`UPDATE pvp_matches
    SET winner_account_id=?,result_reason=?,updated_at=datetime('now'),
      state_revision=state_revision+1
    WHERE status='active' AND result_reason IS NULL
      AND ((inviter_account_id=? AND invitee_account_id=?)
        OR (inviter_account_id=? AND invitee_account_id=?))`)
    .bind(opponentAccountId, reason,
      forfeitingAccountId, opponentAccountId, opponentAccountId, forfeitingAccountId);
}

async function accountByFriendCode(env, value) {
  const code = normalizeFriendCode(value);
  if (!code) return null;
  return env.DB.prepare(`SELECT a.id,a.username,p.friend_code,p.terms_version,p.leaderboard_status
    FROM account_profiles p JOIN accounts a ON a.id=p.account_id
    WHERE p.friend_code=?`).bind(code).first();
}

async function friendRows(env, accountId) {
  const rows = await env.DB.prepare(`SELECT f.account_low_id,f.account_high_id,
      f.requested_by_account_id,f.status,f.updated_at,a.username,p.friend_code
    FROM friendships f
    JOIN accounts a ON a.id=CASE WHEN f.account_low_id=? THEN f.account_high_id ELSE f.account_low_id END
    JOIN account_profiles p ON p.account_id=a.id
    WHERE f.account_low_id=? OR f.account_high_id=?
    ORDER BY f.updated_at DESC
    LIMIT ?`).bind(accountId, accountId, accountId, MAX_FRIEND_RELATIONSHIPS).all();
  return (rows.results || []).map((row) => ({
    playerCode: String(row.friend_code || ''),
    username: String(row.username),
    status: String(row.status),
    direction: Number(row.requested_by_account_id) === Number(accountId) ? 'outgoing' : 'incoming',
  }));
}

async function requestFriend(req, env, account, termsVersion) {
  const { playerCode } = await req.json().catch(() => ({}));
  const target = await accountByFriendCode(env, playerCode);
  if (!target || target.terms_version !== termsVersion || target.leaderboard_status !== 'active')
    return json({ ok: false, error: 'friend_not_found' }, 404);
  if (Number(target.id) === Number(account.id)) return json({ ok: false, error: 'self_friend' }, 409);
  const blocked = await env.DB.prepare(`SELECT 1 AS blocked FROM account_blocks
    WHERE (blocker_account_id=? AND blocked_account_id=?)
       OR (blocker_account_id=? AND blocked_account_id=?) LIMIT 1`)
    .bind(account.id, target.id, target.id, account.id).first();
  if (blocked) return json({ ok: false, error: 'friend_unavailable' }, 409);
  const [low, high] = pair(account.id, target.id);
  const prior = await env.DB.prepare(`SELECT requested_by_account_id,status FROM friendships
    WHERE account_low_id=? AND account_high_id=?`).bind(low, high).first();
  if (prior?.status === 'accepted') return json({ ok: true, alreadyFriends: true });
  if (prior && Number(prior.requested_by_account_id) !== Number(account.id)) {
    const result = await env.DB.prepare(`UPDATE friendships SET status='accepted',updated_at=datetime('now')
      WHERE account_low_id=? AND account_high_id=? AND status='pending'
        AND requested_by_account_id=?
        AND NOT EXISTS (SELECT 1 FROM account_blocks
          WHERE (blocker_account_id=? AND blocked_account_id=?)
             OR (blocker_account_id=? AND blocked_account_id=?))`)
      .bind(low, high, target.id, account.id, target.id, target.id, account.id).run();
    if (!Number(result?.meta?.changes || 0))
      return json({ ok: false, error: 'friend_unavailable' }, 409);
    return json({ ok: true, accepted: true });
  }
  if (prior) return json({ ok: true, requested: true });
  // The capacity and block checks belong to the INSERT statement, so a wave of
  // concurrent requests cannot all pass a stale COUNT or recreate a row after
  // either player blocks the other.
  const inserted = await env.DB.prepare(`INSERT INTO friendships(
      account_low_id,account_high_id,requested_by_account_id)
    SELECT ?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM account_blocks
      WHERE (blocker_account_id=? AND blocked_account_id=?)
         OR (blocker_account_id=? AND blocked_account_id=?))
      AND (SELECT COUNT(*) FROM friendships
        WHERE account_low_id=? OR account_high_id=?)<?
      AND (SELECT COUNT(*) FROM friendships
        WHERE account_low_id=? OR account_high_id=?)<?`)
    .bind(low, high, account.id,
      account.id, target.id, target.id, account.id,
      account.id, account.id, MAX_FRIEND_RELATIONSHIPS,
      target.id, target.id, MAX_FRIEND_RELATIONSHIPS).run();
  if (!Number(inserted?.meta?.changes || 0)) {
    const nowBlocked = await env.DB.prepare(`SELECT 1 AS blocked FROM account_blocks
      WHERE (blocker_account_id=? AND blocked_account_id=?)
         OR (blocker_account_id=? AND blocked_account_id=?) LIMIT 1`)
      .bind(account.id, target.id, target.id, account.id).first();
    return nowBlocked
      ? json({ ok: false, error: 'friend_unavailable' }, 409)
      : json({ ok: false, error: 'friend_limit_reached' }, 409);
  }
  return json({ ok: true, requested: true }, 201);
}

async function respondFriend(req, env, account) {
  const { playerCode, accept } = await req.json().catch(() => ({}));
  const target = await accountByFriendCode(env, playerCode);
  if (!target) return json({ ok: false, error: 'friend_not_found' }, 404);
  const [low, high] = pair(account.id, target.id);
  const prior = await env.DB.prepare(`SELECT requested_by_account_id,status FROM friendships
    WHERE account_low_id=? AND account_high_id=?`).bind(low, high).first();
  if (!prior || prior.status !== 'pending' || Number(prior.requested_by_account_id) === Number(account.id))
    return json({ ok: false, error: 'friend_request_not_found' }, 404);
  if (accept === true) {
    const result = await env.DB.prepare(`UPDATE friendships SET status='accepted',updated_at=datetime('now')
      WHERE account_low_id=? AND account_high_id=? AND status='pending'
        AND requested_by_account_id=?
        AND NOT EXISTS (SELECT 1 FROM account_blocks
          WHERE (blocker_account_id=? AND blocked_account_id=?)
             OR (blocker_account_id=? AND blocked_account_id=?))`)
      .bind(low, high, target.id, account.id, target.id, target.id, account.id).run();
    if (!Number(result?.meta?.changes || 0))
      return json({ ok: false, error: 'friend_request_changed' }, 409);
  } else {
    const result = await env.DB.prepare(`DELETE FROM friendships
      WHERE account_low_id=? AND account_high_id=? AND status='pending'
        AND requested_by_account_id=?`).bind(low, high, target.id).run();
    if (!Number(result?.meta?.changes || 0))
      return json({ ok: false, error: 'friend_request_changed' }, 409);
  }
  return json({ ok: true, accepted: accept === true });
}

async function removeFriend(env, account, rawCode) {
  const target = await accountByFriendCode(env, rawCode);
  if (!target) return json({ ok: false, error: 'friend_not_found' }, 404);
  const [low, high] = pair(account.id, target.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM friendships WHERE account_low_id=? AND account_high_id=?')
      .bind(low, high),
    env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason='friend_removed',
        updated_at=datetime('now'),state_revision=state_revision+1
      WHERE status='invited'
        AND ((inviter_account_id=? AND invitee_account_id=?)
          OR (inviter_account_id=? AND invitee_account_id=?))`)
      .bind(account.id, target.id, target.id, account.id),
    pvpForfeitIntentStatement(env, account.id, target.id, 'friend_removed'),
  ]);
  await settlePvPForfeit(env, account.id, target.id, 'friend_removed');
  return json({ ok: true, removed: true });
}

function phaseSchedule(phase, durationSeconds, now) {
  const startsAt = now + 3000;
  if (phase === 'tap') return {
    phase: 'tap', startsAt, endsAt: startsAt + durationSeconds * 1000, drawAt: null,
  };
  const drawAt = startsAt + randomBetween(QUICK_DRAW_MIN_DELAY_MS, QUICK_DRAW_MAX_DELAY_MS);
  // Reserve a short REST-recovery interval after the planned push. The DO
  // replaces this provisional end with actualIssue+window when DRAW is sent.
  return {
    phase: 'quick_draw', startsAt,
    endsAt: drawAt + QUICK_DRAW_REST_FAILOVER_MS + QUICK_DRAW_WINDOW_MS,
    drawAt,
  };
}

async function initializeQuickDrawRoom(env, matchId) {
  if (!env.QUICK_DRAW_ROOMS || !validMatchId(matchId)) return false;
  try {
    const response = await env.QUICK_DRAW_ROOMS.getByName(matchId).fetch(
      new Request('https://quick-draw.internal/init', {
        method: 'POST', headers: { 'X-DISCIPLINE-Match-Id': matchId },
      }),
    );
    return response.ok;
  } catch (error) {
    console.error('quick_draw_room_init_failed', matchId, error);
    return false;
  }
}

async function scheduleTiebreaker(env, match, now) {
  const phase = nextTiebreakerPhase(match.phase);
  const duration = phase === 'tap' ? 30 : 0;
  const schedule = phaseSchedule(phase, duration, now);
  const result = await env.DB.prepare(`UPDATE pvp_matches SET phase=?,duration_seconds=?,round_number=round_number+1,
      phase_starts_at=?,phase_ends_at=?,draw_at=?,state_revision=state_revision+1,
      quick_draw_issued_at=NULL,tap_commit_barrier_until=NULL,updated_at=datetime('now')
    WHERE id=? AND status='active' AND round_number=? AND state_revision=?
      ${activeMatchEligibilitySql()}`)
    .bind(schedule.phase, duration, schedule.startsAt, schedule.endsAt, schedule.drawAt,
      match.id, match.round_number, match.state_revision).run();
  if (Number(result?.meta?.changes || 0) && phase === 'quick_draw')
    await initializeQuickDrawRoom(env, match.id);
  return result;
}

function rewardInsertStatement(env, matchId, winnerAccountId) {
  return env.DB.prepare(`INSERT OR IGNORE INTO pvp_rewards(
      match_id,winner_account_id,pair_low_account_id,pair_high_account_id,mentality_amount)
    SELECT m.id,m.winner_account_id,
      CASE WHEN m.inviter_account_id<m.invitee_account_id
        THEN m.inviter_account_id ELSE m.invitee_account_id END,
      CASE WHEN m.inviter_account_id<m.invitee_account_id
        THEN m.invitee_account_id ELSE m.inviter_account_id END,?
    FROM pvp_matches m
    WHERE m.id=? AND m.status='completed' AND m.winner_account_id=?
      AND EXISTS (SELECT 1 FROM pvp_round_scores participated
        WHERE participated.match_id=m.id
          AND participated.account_id=m.inviter_account_id
          AND (participated.tap_count>0 OR participated.reaction_ms IS NOT NULL))
      AND EXISTS (SELECT 1 FROM pvp_round_scores participated
        WHERE participated.match_id=m.id
          AND participated.account_id=m.invitee_account_id
          AND (participated.tap_count>0 OR participated.reaction_ms IS NOT NULL))
      AND (SELECT COUNT(*) FROM pvp_rewards recent
        WHERE recent.winner_account_id=m.winner_account_id
          AND recent.awarded_at>=datetime('now','-24 hours'))<?
      AND (SELECT COUNT(*) FROM pvp_rewards recent_pair
        WHERE recent_pair.pair_low_account_id=CASE
            WHEN m.inviter_account_id<m.invitee_account_id
              THEN m.inviter_account_id ELSE m.invitee_account_id END
          AND recent_pair.pair_high_account_id=CASE
            WHEN m.inviter_account_id<m.invitee_account_id
              THEN m.invitee_account_id ELSE m.inviter_account_id END
          AND recent_pair.awarded_at>=datetime('now','-24 hours'))<?`)
    .bind(PVP_REWARD_MENTALITY, matchId, winnerAccountId,
      MAX_PVP_REWARDED_WINS_PER_24H, MAX_PVP_REWARDED_PAIR_RESULTS_PER_24H);
}

async function completeMatch(env, match, winnerAccountId, reason = null,
    relationshipDeparture = false) {
  return env.DB.batch([
    env.DB.prepare(`UPDATE pvp_matches SET status='completed',winner_account_id=?,
      result_reason=?,completed_at=datetime('now'),updated_at=datetime('now'),
      state_revision=state_revision+1
      WHERE id=? AND status='active' AND round_number=? AND state_revision=?
        AND (?=1 OR (1=1 ${activeMatchEligibilitySql()}))`)
      .bind(winnerAccountId, reason, match.id, match.round_number, match.state_revision,
        relationshipDeparture ? 1 : 0),
    // D1 batches are transactional and execute in order. The INSERT itself
    // performs both rolling-window checks against the current ledger, so
    // concurrent completions cannot pass a stale preflight COUNT.
    rewardInsertStatement(env, match.id, winnerAccountId),
  ]);
}

export async function settlePvPForfeit(env, forfeitingAccountId, opponentAccountId,
    reason = 'friend_removed') {
  const forfeiter = Number(forfeitingAccountId);
  const opponent = Number(opponentAccountId);
  if (!Number.isSafeInteger(forfeiter) || forfeiter < 1
      || !Number.isSafeInteger(opponent) || opponent < 1 || forfeiter === opponent) return false;
  // Invitations have not begun and therefore cancel. An active player who
  // removes, blocks, or deletes the relationship forfeits to the opponent.
  await env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason=?,
      updated_at=datetime('now'),state_revision=state_revision+1
    WHERE status='invited'
      AND ((inviter_account_id=? AND invitee_account_id=?)
        OR (inviter_account_id=? AND invitee_account_id=?))`)
    .bind(reason, forfeiter, opponent, opponent, forfeiter).run();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = await env.DB.prepare(`SELECT * FROM pvp_matches
      WHERE status='active'
        AND ((inviter_account_id=? AND invitee_account_id=?)
          OR (inviter_account_id=? AND invitee_account_id=?))
      LIMIT 1`).bind(forfeiter, opponent, opponent, forfeiter).first();
    if (!match) return true;
    const pending = parseForfeitIntent(match);
    const intendedForfeiter = pending?.forfeiter || forfeiter;
    const intendedOpponent = pending?.winner || (Number(match.inviter_account_id) === intendedForfeiter
      ? Number(match.invitee_account_id) : Number(match.inviter_account_id));
    const results = await completeMatch(
      env, match, intendedOpponent, pending?.reason || reason, true,
    );
    if (Number(results?.[0]?.meta?.changes || 0)) return true;
  }
  const remaining = await env.DB.prepare(`SELECT 1 AS active FROM pvp_matches
    WHERE status='active'
      AND ((inviter_account_id=? AND invitee_account_id=?)
        OR (inviter_account_id=? AND invitee_account_id=?)) LIMIT 1`)
    .bind(forfeiter, opponent, opponent, forfeiter).first();
  if (remaining) throw new Error('pvp_forfeit_settlement_conflict');
  return true;
}

export async function settlePvPAccountDeparture(env, accountId) {
  const departing = Number(accountId);
  if (!Number.isSafeInteger(departing) || departing < 1) return;
  await env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason='friend_removed',
      updated_at=datetime('now'),state_revision=state_revision+1
    WHERE status='invited' AND (inviter_account_id=? OR invitee_account_id=?)`)
    .bind(departing, departing).run();
  // Player locks restrict a valid account to one active match. The bounded
  // loop also safely drains legacy/corrupt duplicates before deletion.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const match = await env.DB.prepare(`SELECT * FROM pvp_matches
      WHERE status='active' AND (inviter_account_id=? OR invitee_account_id=?)
      ORDER BY updated_at DESC LIMIT 1`).bind(departing, departing).first();
    if (!match) return;
    const opponent = Number(match.inviter_account_id) === departing
      ? Number(match.invitee_account_id) : Number(match.inviter_account_id);
    const results = await completeMatch(env, match, opponent, 'friend_removed', true);
    if (!Number(results?.[0]?.meta?.changes || 0)) continue;
  }
  const remaining = await env.DB.prepare(`SELECT 1 AS active FROM pvp_matches
    WHERE status='active' AND (inviter_account_id=? OR invitee_account_id=?) LIMIT 1`)
    .bind(departing, departing).first();
  if (remaining) throw new Error('pvp_account_departure_settlement_conflict');
}

async function cancelActiveMatch(env, match, reason) {
  return env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason=?,
      updated_at=datetime('now'),
      state_revision=state_revision+1
    WHERE id=? AND status='active' AND round_number=? AND state_revision=?
      ${activeMatchEligibilitySql()}`)
    .bind(reason, match.id, match.round_number, match.state_revision).run();
}

export async function resolveMatch(env, match, now = Date.now()) {
  if (!match || match.status !== 'active') return;
  const pending = parseForfeitIntent(match);
  if (pending) {
    return settlePvPForfeit(env, pending.forfeiter, pending.winner, pending.reason);
  }
  if (now < Number(match.phase_starts_at || 0)) return;
  const scores = await env.DB.prepare(`SELECT account_id,tap_count,reaction_ms FROM pvp_round_scores
    WHERE match_id=? AND round_number=?`).bind(match.id, match.round_number).all();
  const byAccount = new Map((scores.results || []).map((row) => [Number(row.account_id), row]));
  const first = byAccount.get(Number(match.inviter_account_id));
  const second = byAccount.get(Number(match.invitee_account_id));
  // Allow the final cumulative score to cross the network after the visible
  // timer reaches zero. verifiedPvPTapCount still clamps its rate calculation
  // to phase_ends_at, so this grace period cannot manufacture extra taps.
  if (match.phase === 'tap' && now < tapSettlementReadyAt(match)) return;
  if (match.phase === 'quick_draw' && match.quick_draw_issued_at == null) return;
  if (match.phase === 'quick_draw' && !(first?.reaction_ms != null && second?.reaction_ms != null)
      && now < Number(match.phase_ends_at)) return;
  const outcome = decidePvPRound(match.phase, first, second, match.round_number);
  if (outcome.kind === 'cancelled') return cancelActiveMatch(env, match, outcome.reason);
  if (outcome.kind === 'tiebreaker') return scheduleTiebreaker(env, match, now);
  return completeMatch(env, match, outcome.comparison > 0
    ? Number(match.inviter_account_id) : Number(match.invitee_account_id), outcome.reason || null);
}

async function matchById(env, matchId, accountId) {
  if (!validMatchId(matchId)) return null;
  return env.DB.prepare(`SELECT * FROM pvp_matches WHERE id=?
    AND (inviter_account_id=? OR invitee_account_id=?)`).bind(matchId, accountId, accountId).first();
}

async function pvpRows(env, accountId) {
  const active = await env.DB.prepare(`SELECT * FROM pvp_matches WHERE status='active'
    AND (inviter_account_id=? OR invitee_account_id=?) LIMIT 4`).bind(accountId, accountId).all();
  for (let match of active.results || []) {
    const now = Date.now();
    if (match.phase === 'quick_draw' && match.quick_draw_issued_at == null
        && now >= Number(match.draw_at) + QUICK_DRAW_REST_FAILOVER_MS) {
      // REST is recovery, not the primary clock. It may claim DRAW only after
      // the server-push transport has had its bounded delivery interval.
      const issued = await env.DB.prepare(`UPDATE pvp_matches SET quick_draw_issued_at=?,phase_ends_at=?,
          state_revision=state_revision+1,updated_at=datetime('now')
        WHERE id=? AND status='active' AND phase='quick_draw' AND round_number=?
          AND state_revision=? AND quick_draw_issued_at IS NULL
          ${activeMatchEligibilitySql()}`)
        .bind(now, now + QUICK_DRAW_WINDOW_MS, match.id, match.round_number,
          match.state_revision).run();
      if (Number(issued?.meta?.changes || 0)) {
        match = await matchById(env, match.id, accountId) || match;
        await initializeQuickDrawRoom(env, match.id);
      }
    }
    await resolveMatch(env, match, now);
  }
  const loadRows = () => env.DB.prepare(`SELECT m.*,
      opponent.username AS opponent_username,op.friend_code AS opponent_code,
      mine.tap_count AS my_tap_count,mine.reaction_ms AS my_reaction_ms,
      theirs.tap_count AS opponent_tap_count,theirs.reaction_ms AS opponent_reaction_ms,
      reward.mentality_amount AS reward_amount
    FROM pvp_matches m
    JOIN accounts opponent ON opponent.id=CASE WHEN m.inviter_account_id=? THEN m.invitee_account_id ELSE m.inviter_account_id END
    JOIN account_profiles op ON op.account_id=opponent.id
    LEFT JOIN pvp_round_scores mine ON mine.match_id=m.id AND mine.round_number=m.round_number AND mine.account_id=?
    LEFT JOIN pvp_round_scores theirs ON theirs.match_id=m.id AND theirs.round_number=m.round_number
      AND theirs.account_id=CASE WHEN m.inviter_account_id=? THEN m.invitee_account_id ELSE m.inviter_account_id END
    LEFT JOIN pvp_rewards reward ON reward.match_id=m.id
    WHERE (m.inviter_account_id=? OR m.invitee_account_id=?)
      AND m.status<>'declined'
      AND NOT (m.status='cancelled' AND m.round_number=0)
    ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,m.updated_at DESC
    LIMIT ?`).bind(accountId, accountId, accountId, accountId, accountId,
      MAX_PVP_MATCH_HISTORY).all();
  let rows = await loadRows();
  const staleInvite = (rows.results || []).some((row) => {
    if (row.status !== 'invited') return false;
    const createdAt = Date.parse(`${String(row.created_at).replace(' ', 'T')}Z`);
    return Number.isFinite(createdAt) && createdAt < Date.now() - 86_400_000;
  });
  if (staleInvite) {
    // This is the only state-GET cleanup path. It is scoped to the requesting
    // account and runs only after a read proves an invite is already stale,
    // rather than issuing three global UPDATEs on every 200-500 ms poll.
    await expireStaleMatches(env, [accountId]);
    rows = await loadRows();
  }
  return rows.results || [];
}

export function projectPublicMatch(row, accountId, now = Date.now()) {
  const quickDraw = row.phase === 'quick_draw';
  const drawReady = quickDraw && row.status === 'active'
    && row.quick_draw_issued_at != null
    && Number.isFinite(Number(row.quick_draw_issued_at))
    && Number(now) >= Number(row.quick_draw_issued_at);
  // Before DRAW, the real phase end would reveal draw_at by subtraction. Give
  // clients only the latest possible close time until the server says ready.
  const safePhaseEndsAt = quickDraw && !drawReady
    ? Number(row.phase_starts_at) + QUICK_DRAW_MAX_DELAY_MS
      + QUICK_DRAW_REST_FAILOVER_MS + QUICK_DRAW_WINDOW_MS
    : row.phase_ends_at == null ? null : Number(row.phase_ends_at);
  const bothDrawsCommitted = row.my_reaction_ms != null && row.opponent_reaction_ms != null;
  const terminal = row.status === 'completed' || row.status === 'cancelled';
  return {
    id: String(row.id),
    opponentCode: String(row.opponent_code || ''),
    opponentName: String(row.opponent_username),
    invitedByMe: Number(row.inviter_account_id) === Number(accountId),
    mode: String(row.mode),
    durationSeconds: Number(row.duration_seconds),
    status: String(row.status),
    phase: row.phase ? String(row.phase) : null,
    roundNumber: Number(row.round_number),
    phaseStartsAt: row.phase_starts_at == null ? null : Number(row.phase_starts_at),
    phaseEndsAt: safePhaseEndsAt,
    drawReady,
    myTapCount: Number(row.my_tap_count) || 0,
    // Never expose a live opponent counter: it lets a modified client poll and
    // submit exactly one more tap at the deadline. Both final scores become
    // visible only after the server has made the result terminal.
    opponentTapCount: terminal ? Number(row.opponent_tap_count) || 0 : null,
    myReactionMs: row.my_reaction_ms == null ? null : Number(row.my_reaction_ms),
    // A player must commit their own draw before learning the opponent's
    // result; otherwise polling can be used to withhold an impending loss.
    opponentReactionMs: !terminal && !bothDrawsCommitted
      ? null : row.opponent_reaction_ms == null ? null : Number(row.opponent_reaction_ms),
    won: row.status === 'completed' ? Number(row.winner_account_id) === Number(accountId) : null,
    resultReason: row.result_reason ? String(row.result_reason)
      : row.status === 'cancelled' ? 'stale_timeout' : null,
    rewardAmount: row.status === 'completed' && Number(row.winner_account_id) === Number(accountId)
      ? Number(row.reward_amount) || 0 : 0,
  };
}

async function multiplayerState(env, account) {
  const [friendCode, relationships, matches] = await Promise.all([
    ensureFriendCode(env, account.id), friendRows(env, account.id), pvpRows(env, account.id),
  ]);
  const serverNow = Date.now();
  return json({
    ok: true,
    serverNow,
    friendCode,
    friends: relationships.filter((row) => row.status === 'accepted'),
    incomingRequests: relationships.filter((row) => row.status === 'pending' && row.direction === 'incoming'),
    outgoingRequests: relationships.filter((row) => row.status === 'pending' && row.direction === 'outgoing'),
    matches: matches.map((row) => projectPublicMatch(row, account.id, serverNow)),
  });
}

async function expireStaleMatches(env, rawAccountIds) {
  const accountIds = [...new Set((rawAccountIds || [])
    .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 2);
  if (!accountIds.length) return;
  const placeholders = accountIds.map(() => '?').join(',');
  const playerScope = `(inviter_account_id IN (${placeholders})
        OR invitee_account_id IN (${placeholders}))`;
  const bindScope = (statement) => statement.bind(...accountIds, ...accountIds);
  await env.DB.batch([
    // Defensive catch-up for any pre-lock Worker write that survived a failed
    // or manually performed rollout. A legitimate invited/active match always
    // owns exactly one lock for each of its two players.
    env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason='rollout_recovery',
        updated_at=datetime('now'),state_revision=state_revision+1
      WHERE status IN ('invited','active')
        AND ${playerScope}
        AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
          WHERE deleting.account_id=pvp_matches.inviter_account_id
             OR deleting.account_id=pvp_matches.invitee_account_id)
        AND 2<>(SELECT COUNT(*) FROM pvp_player_locks l WHERE l.match_id=pvp_matches.id)`),
    env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason='stale_timeout',
        updated_at=datetime('now'),state_revision=state_revision+1
      WHERE status='invited' AND ${playerScope}
        AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
          WHERE deleting.account_id=pvp_matches.inviter_account_id
             OR deleting.account_id=pvp_matches.invitee_account_id)
        AND created_at<datetime('now','-1 day')`),
    env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason='stale_timeout',
        updated_at=datetime('now'),state_revision=state_revision+1
      WHERE status='active' AND ${playerScope}
        AND updated_at<datetime('now','-30 minutes')
        ${activeMatchEligibilitySql()}`),
  ].map(bindScope));
}

async function inviteMatch(req, env, account) {
  const body = await req.json().catch(() => ({}));
  const target = await accountByFriendCode(env, body.playerCode);
  const config = validatePvPInvite(body.mode, body.durationSeconds);
  if (!target || !config) return json({ ok: false, error: 'invalid_pvp_invite' }, 400);
  await expireStaleMatches(env, [account.id, target.id]);
  const [low, high] = pair(account.id, target.id);
  const id = randomHex(16);
  try {
    // The database trigger acquires both PRIMARY KEY player locks inside this
    // INSERT statement. A competing invite therefore aborts atomically, and
    // even a temporarily running older Worker cannot create a lockless match.
    const inserted = await env.DB.prepare(`INSERT INTO pvp_matches(
        id,inviter_account_id,invitee_account_id,mode,duration_seconds
      ) SELECT ?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM friendships
        WHERE account_low_id=? AND account_high_id=? AND status='accepted')
        AND NOT EXISTS (SELECT 1 FROM account_blocks
          WHERE (blocker_account_id=? AND blocked_account_id=?)
             OR (blocker_account_id=? AND blocked_account_id=?))
        AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
          WHERE deleting.account_id=? OR deleting.account_id=?)`).bind(
      id, account.id, target.id, config.mode, config.durationSeconds, low, high,
      account.id, target.id, target.id, account.id,
      account.id, target.id,
    ).run();
    if (!Number(inserted?.meta?.changes || 0))
      return json({ ok: false, error: 'friend_required' }, 409);
  } catch {
    const busy = await env.DB.prepare(`SELECT account_id FROM pvp_player_locks
      WHERE account_id IN (?,?) LIMIT 1`).bind(account.id, target.id).first();
    if (busy) return json({ ok: false, error: 'player_busy' }, 409);
    return json({ ok: false, error: 'pvp_invite_unavailable' }, 503);
  }
  return json({ ok: true, matchId: id }, 201);
}

async function respondMatch(req, env, account, matchId) {
  await expireStaleMatches(env, [account.id]);
  const match = await matchById(env, matchId, account.id);
  if (!match || match.status !== 'invited' || Number(match.invitee_account_id) !== Number(account.id))
    return json({ ok: false, error: 'pvp_invite_not_found' }, 404);
  const { accept } = await req.json().catch(() => ({}));
  if (accept !== true) {
    const result = await env.DB.prepare(`UPDATE pvp_matches SET status='declined',
        updated_at=datetime('now'),state_revision=state_revision+1
      WHERE id=? AND status='invited' AND invitee_account_id=? AND state_revision=?
        AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
          WHERE deleting.account_id=pvp_matches.inviter_account_id
             OR deleting.account_id=pvp_matches.invitee_account_id)`)
      .bind(matchId, account.id, match.state_revision).run();
    if (!Number(result?.meta?.changes || 0))
      return json({ ok: false, error: 'pvp_invite_changed' }, 409);
    return json({ ok: true, accepted: false });
  }
  const now = Date.now();
  const schedule = phaseSchedule(match.mode, Number(match.duration_seconds), now);
  const [low, high] = pair(match.inviter_account_id, match.invitee_account_id);
  const result = await env.DB.prepare(`UPDATE pvp_matches SET status='active',phase=?,round_number=1,
      phase_starts_at=?,phase_ends_at=?,draw_at=?,quick_draw_issued_at=NULL,
      updated_at=datetime('now'),
      state_revision=state_revision+1
    WHERE id=? AND status='invited' AND invitee_account_id=? AND state_revision=?
      AND EXISTS (SELECT 1 FROM friendships f WHERE f.account_low_id=?
        AND f.account_high_id=? AND f.status='accepted')
      AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
        WHERE deleting.account_id=pvp_matches.inviter_account_id
           OR deleting.account_id=pvp_matches.invitee_account_id)
      AND 2=(SELECT COUNT(*) FROM pvp_player_locks l WHERE l.match_id=pvp_matches.id)`)
    .bind(schedule.phase, schedule.startsAt, schedule.endsAt, schedule.drawAt,
      matchId, account.id, match.state_revision, low, high).run();
  if (!Number(result?.meta?.changes || 0))
    return json({ ok: false, error: 'pvp_invite_changed' }, 409);
  if (schedule.phase === 'quick_draw') await initializeQuickDrawRoom(env, matchId);
  return json({ ok: true, accepted: true });
}

async function cancelMatch(env, account, matchId) {
  await expireStaleMatches(env, [account.id]);
  const match = await matchById(env, matchId, account.id);
  if (!match || match.status !== 'invited' || Number(match.inviter_account_id) !== Number(account.id))
    return json({ ok: false, error: 'pvp_invite_not_found' }, 404);
  const result = await env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',
      result_reason='cancelled_by_inviter',updated_at=datetime('now'),state_revision=state_revision+1
    WHERE id=? AND status='invited' AND inviter_account_id=? AND state_revision=?
      AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deleting
        WHERE deleting.account_id=pvp_matches.inviter_account_id
           OR deleting.account_id=pvp_matches.invitee_account_id)`)
    .bind(matchId, account.id, match.state_revision).run();
  if (!Number(result?.meta?.changes || 0))
    return json({ ok: false, error: 'pvp_invite_changed' }, 409);
  return json({ ok: true, cancelled: true });
}

async function recordTaps(req, env, account, matchId) {
  const { count } = await req.json().catch(() => ({}));
  const submittedAt = Date.now();
  const requested = Number(count);
  if (!Number.isFinite(requested) || requested < 0 || Math.trunc(requested) !== requested)
    return json({ ok: false, error: 'unverified_pvp_tap_rate' }, 422);
  // Arm a short, bounded commit barrier before reading the match. This write
  // serializes against settlement in D1: if it wins first, its revision bump
  // invalidates an already-read resolver and the next resolver observes the
  // barrier. A request cannot extend settlement beyond the fixed grace plus
  // one barrier window. The SQL rate check rejects junk scores, while the
  // stored-score predicate makes an equal/lower replay a true read-only retry
  // instead of write-amplifying the match revision or delaying settlement.
  // A shared minimum barrier advance also bounds concurrent modified clients
  // before either score row has committed.
  await env.DB.prepare(`UPDATE pvp_matches
    SET tap_commit_barrier_until=MAX(COALESCE(tap_commit_barrier_until,0),?),
      state_revision=state_revision+1
    WHERE id=? AND status='active' AND phase='tap'
      AND (inviter_account_id=? OR invitee_account_id=?)
      AND ?>=phase_ends_at-? AND ?<=phase_ends_at+?
      AND ?>=COALESCE(tap_commit_barrier_until,0)+?
      AND ?>=0
      AND ?<=5 + (MAX(0,MIN(?,phase_ends_at)-phase_starts_at)*?)/1000
      ${activeMatchEligibilitySql()}
      AND NOT EXISTS (SELECT 1 FROM pvp_round_scores stored
        WHERE stored.match_id=pvp_matches.id
          AND stored.round_number=pvp_matches.round_number
          AND stored.account_id=? AND stored.tap_count>=?)`)
    .bind(submittedAt + TAP_COMMIT_BARRIER_MS, matchId, account.id, account.id,
      submittedAt, TAP_COMMIT_ARM_LEAD_MS, submittedAt, TAP_SUBMISSION_GRACE_MS,
      submittedAt + TAP_COMMIT_BARRIER_MS, PVP_TAP_MIN_WRITE_INTERVAL_MS,
      requested, requested, submittedAt, MAX_PVP_TAPS_PER_SECOND,
      account.id, requested).run();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = await matchById(env, matchId, account.id);
    if (!match || match.status !== 'active' || match.phase !== 'tap')
      return json({ ok: false, error: 'tap_phase_unavailable' }, 409);
    if (submittedAt < Number(match.phase_starts_at)
        || submittedAt > Number(match.phase_ends_at) + TAP_SUBMISSION_GRACE_MS)
      return json({ ok: false, error: 'tap_phase_closed' }, 409);
    const verified = verifiedPvPTapCount(
      count, match.phase_starts_at, match.phase_ends_at, submittedAt,
    );
    if (verified === null)
      return json({ ok: false, error: 'unverified_pvp_tap_rate' }, 422);
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO pvp_round_scores(
          match_id,round_number,account_id,tap_count,updated_at_ms
        ) SELECT id,round_number,?,?,? FROM pvp_matches
        WHERE id=? AND status='active' AND phase='tap' AND round_number=? AND state_revision=?
          ${activeMatchEligibilitySql()}
          AND NOT EXISTS (SELECT 1 FROM pvp_round_scores recent
            WHERE recent.match_id=pvp_matches.id
              AND recent.round_number=pvp_matches.round_number
              AND recent.account_id=?
              AND recent.updated_at_ms>?
              AND NOT (? >= pvp_matches.phase_ends_at
                AND recent.updated_at_ms < pvp_matches.phase_ends_at))
        ON CONFLICT(match_id,round_number,account_id) DO UPDATE SET
          tap_count=excluded.tap_count,updated_at_ms=excluded.updated_at_ms
          WHERE excluded.tap_count>pvp_round_scores.tap_count`)
        .bind(account.id, verified, submittedAt, matchId, match.round_number, match.state_revision,
          account.id, submittedAt - PVP_TAP_MIN_WRITE_INTERVAL_MS, submittedAt),
      env.DB.prepare(`UPDATE pvp_matches SET state_revision=state_revision+1
        WHERE id=? AND status='active' AND phase='tap' AND round_number=? AND state_revision=?
          ${activeMatchEligibilitySql()}
          AND EXISTS (SELECT 1 FROM pvp_round_scores s
            WHERE s.match_id=? AND s.round_number=? AND s.account_id=? AND s.updated_at_ms=?)`)
        .bind(matchId, match.round_number, match.state_revision,
          matchId, match.round_number, account.id, submittedAt),
    ]);
    if (Number(results?.[1]?.meta?.changes || 0))
      return json({ ok: true, acceptedTaps: verified, serverNow: submittedAt });
    const stored = await env.DB.prepare(`SELECT tap_count,updated_at_ms FROM pvp_round_scores
      WHERE match_id=? AND round_number=? AND account_id=?`)
      .bind(matchId, match.round_number, account.id).first();
    if (stored && Number(stored.tap_count) >= verified)
      return json({ ok: true, acceptedTaps: Number(stored.tap_count), serverNow: submittedAt });
    if (stored
        && submittedAt - Number(stored.updated_at_ms) < PVP_TAP_MIN_WRITE_INTERVAL_MS
        && !(submittedAt >= Number(match.phase_ends_at)
          && Number(stored.updated_at_ms) < Number(match.phase_ends_at))) {
      return json({
        ok: false,
        error: 'pvp_tap_coalesced',
        retryAfterMs: Math.max(1,
          PVP_TAP_MIN_WRITE_INTERVAL_MS - (submittedAt - Number(stored.updated_at_ms))),
      }, 429);
    }
  }
  return json({ ok: false, error: 'pvp_state_changed' }, 409);
}

export async function commitQuickDrawScore(env, {
  matchId, accountId, roundNumber, submittedAt, reactionMs,
  rawReactionMs = reactionMs, rttAdjustmentMs = 0, transport = 'rest',
}) {
  if (!validMatchId(matchId) || !Number.isSafeInteger(Number(accountId))
      || !Number.isSafeInteger(Number(roundNumber))
      || !Number.isFinite(Number(submittedAt))
      || !Number.isFinite(Number(reactionMs))
      || !Number.isFinite(Number(rawReactionMs))
      || !Number.isFinite(Number(rttAdjustmentMs))
      || !['websocket', 'rest'].includes(transport))
    return { ok: false, error: 'invalid_quick_draw_score' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = await matchById(env, matchId, accountId);
    if (!match || match.status !== 'active' || match.phase !== 'quick_draw')
      return { ok: false, error: 'quick_draw_unavailable' };
    if (Number(match.round_number) !== Number(roundNumber))
      return { ok: false, error: 'quick_draw_changed' };
    if (submittedAt < Number(match.phase_starts_at) || submittedAt > Number(match.phase_ends_at))
      return { ok: false, error: 'quick_draw_closed' };
    if (Number(rawReactionMs) >= 0 && (match.quick_draw_issued_at == null
        || submittedAt < Number(match.quick_draw_issued_at)))
      return { ok: false, error: 'quick_draw_not_issued' };
    // The caller supplies only the early-foul signal. A valid response's score
    // is recomputed from the server's own receipt and issue timestamps here.
    const normalizedRaw = Number(rawReactionMs) < 0 ? -1
      : Math.max(0, Math.trunc(submittedAt - Number(match.quick_draw_issued_at)));
    // Competitive Quick Draw is based only on authoritative server receipt
    // time. RTT sampling remains recorded telemetry and never changes who won.
    const normalizedReaction = normalizedRaw;
    const normalizedAdjustment = Math.max(0, Math.trunc(Number(rttAdjustmentMs)));
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO pvp_round_scores(
          match_id,round_number,account_id,reaction_ms,raw_reaction_ms,
          rtt_adjustment_ms,reaction_transport,updated_at_ms
        ) SELECT id,round_number,?,?,?,?,?,? FROM pvp_matches
        WHERE id=? AND status='active' AND phase='quick_draw'
          AND round_number=? AND state_revision=?
          ${activeMatchEligibilitySql()}`)
        .bind(accountId, normalizedReaction, normalizedRaw, normalizedAdjustment,
          transport, submittedAt, matchId, match.round_number, match.state_revision),
      env.DB.prepare(`UPDATE pvp_matches SET state_revision=state_revision+1
        WHERE id=? AND status='active' AND phase='quick_draw'
          AND round_number=? AND state_revision=?
          ${activeMatchEligibilitySql()}
          AND EXISTS (SELECT 1 FROM pvp_round_scores s
            WHERE s.match_id=? AND s.round_number=? AND s.account_id=? AND s.updated_at_ms=?)`)
        .bind(matchId, match.round_number, match.state_revision,
          matchId, match.round_number, accountId, submittedAt),
    ]);
    if (!Number(results?.[1]?.meta?.changes || 0)) {
      const prior = await env.DB.prepare(`SELECT reaction_ms FROM pvp_round_scores
        WHERE match_id=? AND round_number=? AND account_id=?`)
        .bind(matchId, match.round_number, accountId).first();
      if (prior?.reaction_ms !== null && prior?.reaction_ms !== undefined) {
        const updated = await matchById(env, matchId, accountId);
        await resolveMatch(env, updated, submittedAt);
        return { ok: true, reactionMs: Number(prior.reaction_ms), alreadyRecorded: true };
      }
      continue;
    }
    const stored = await env.DB.prepare(`SELECT reaction_ms FROM pvp_round_scores
      WHERE match_id=? AND round_number=? AND account_id=?`)
      .bind(matchId, match.round_number, accountId).first();
    const updated = await matchById(env, matchId, accountId);
    await resolveMatch(env, updated, submittedAt);
    return { ok: true, reactionMs: Number(stored?.reaction_ms), alreadyRecorded: false };
  }
  return { ok: false, error: 'pvp_state_changed' };
}

async function recordDraw(env, account, matchId) {
  const submittedAt = Date.now();
  const match = await matchById(env, matchId, account.id);
  if (!match || match.status !== 'active' || match.phase !== 'quick_draw')
    return json({ ok: false, error: 'quick_draw_unavailable' }, 409);
  if (submittedAt < Number(match.phase_starts_at) || submittedAt > Number(match.phase_ends_at))
    return json({ ok: false, error: 'quick_draw_closed' }, 409);
  const issuedAt = match.quick_draw_issued_at == null
    ? null : Number(match.quick_draw_issued_at);
  const rawReaction = issuedAt == null ? -1 : submittedAt - issuedAt;
  const result = await commitQuickDrawScore(env, {
    matchId, accountId: account.id, roundNumber: match.round_number,
    submittedAt, reactionMs: rawReaction, rawReactionMs: rawReaction,
    rttAdjustmentMs: 0, transport: 'rest',
  });
  return result.ok
    ? json({ ok: true, reactionMs: result.reactionMs, serverNow: submittedAt })
    : json({ ok: false, error: result.error }, 409);
}

async function quickDrawTicket(env, account, matchId) {
  const match = await matchById(env, matchId, account.id);
  if (!match || match.status !== 'active' || match.phase !== 'quick_draw')
    return json({ ok: false, error: 'quick_draw_unavailable' }, 409);
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.min(Date.now() + QUICK_DRAW_TICKET_TTL_MS,
    Number(match.phase_ends_at) + 1000);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM pvp_socket_tickets
      WHERE account_id=? AND match_id=?`).bind(account.id, matchId),
    env.DB.prepare(`INSERT INTO pvp_socket_tickets(
        token_hash,match_id,account_id,expires_at_ms)
      VALUES(?,?,?,?)`).bind(tokenHash, matchId, account.id, expiresAt),
  ]);
  return json({ ok: true, ticket: token, expiresAt });
}

export async function handleQuickDrawSocket(req, url, env) {
  const route = url.pathname.match(/^\/v1\/pvp\/([0-9a-f]{32})\/quick-draw\/socket$/);
  if (!route) return null;
  if (req.method !== 'GET' || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    return json({ ok: false, error: 'websocket_upgrade_required' }, 426);
  if (!env.QUICK_DRAW_ROOMS)
    return json({ ok: false, error: 'quick_draw_realtime_unavailable' }, 503);
  const ticket = url.searchParams.get('ticket') || '';
  if (!/^[0-9a-f]{64}$/.test(ticket))
    return json({ ok: false, error: 'invalid_socket_ticket' }, 401);
  const tokenHash = await sha256Hex(ticket);
  const record = await env.DB.prepare(`SELECT ticket.account_id,
      deletion.account_id AS deletion_pending
    FROM pvp_socket_tickets ticket
    LEFT JOIN account_deletion_jobs deletion ON deletion.account_id=ticket.account_id
    WHERE ticket.token_hash=? AND ticket.match_id=?
      AND ticket.used_at_ms IS NULL AND ticket.expires_at_ms>=?`)
    .bind(tokenHash, route[1], Date.now()).first();
  if (!record) return json({ ok: false, error: 'invalid_socket_ticket' }, 401);
  if (record.deletion_pending != null)
    return json({ ok: false, error: 'account_deletion_pending' }, 409);
  const usedAt = Date.now();
  const consumed = await env.DB.prepare(`UPDATE pvp_socket_tickets SET used_at_ms=?
    WHERE token_hash=? AND match_id=? AND account_id=? AND used_at_ms IS NULL
      AND expires_at_ms>=?
      AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs deletion
        WHERE deletion.account_id=pvp_socket_tickets.account_id)`).bind(
    usedAt, tokenHash, route[1], record.account_id, usedAt,
  ).run();
  if (!Number(consumed?.meta?.changes || 0))
    return json({ ok: false, error: 'invalid_socket_ticket' }, 401);
  const headers = new Headers({
    Upgrade: 'websocket',
    'X-DISCIPLINE-Match-Id': route[1],
    'X-DISCIPLINE-Account-Id': String(record.account_id),
  });
  try {
    return await env.QUICK_DRAW_ROOMS.getByName(route[1]).fetch(
      new Request('https://quick-draw.internal/connect', { headers }),
    );
  } catch (error) {
    console.error('quick_draw_socket_proxy_failed', route[1], error);
    return json({ ok: false, error: 'quick_draw_realtime_unavailable' }, 503);
  }
}

export async function handleMultiplayerRoute(req, url, env, account, termsVersion) {
  if (url.pathname === '/v1/multiplayer' && req.method === 'GET')
    return multiplayerState(env, account);
  if (url.pathname === '/v1/friends/request' && req.method === 'POST')
    return requestFriend(req, env, account, termsVersion);
  if (url.pathname === '/v1/friends/respond' && req.method === 'POST')
    return respondFriend(req, env, account);
  if (url.pathname.startsWith('/v1/friends/') && req.method === 'DELETE')
    return removeFriend(env, account, decodeURIComponent(url.pathname.slice('/v1/friends/'.length)));
  if (url.pathname === '/v1/pvp/invite' && req.method === 'POST')
    return inviteMatch(req, env, account);
  const quickDraw = url.pathname.match(/^\/v1\/pvp\/([0-9a-f]{32})\/quick-draw\/ticket$/);
  if (quickDraw && req.method === 'POST') return quickDrawTicket(env, account, quickDraw[1]);
  const route = url.pathname.match(/^\/v1\/pvp\/([0-9a-f]{32})\/(respond|tap|draw|cancel)$/);
  if (!route || req.method !== 'POST') return null;
  if (route[2] === 'respond') return respondMatch(req, env, account, route[1]);
  if (route[2] === 'tap') return recordTaps(req, env, account, route[1]);
  if (route[2] === 'draw') return recordDraw(env, account, route[1]);
  return cancelMatch(env, account, route[1]);
}
