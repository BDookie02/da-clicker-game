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
export const TAP_DURATIONS = Object.freeze([30, 60, 90]);
export const MAX_PVP_TAPS_PER_SECOND = 25;
export const TAP_SUBMISSION_GRACE_MS = 2500;
const ACTIVE_MATCH_STATUSES = Object.freeze(['invited', 'active']);
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

async function ensureFriendCode(env, accountId) {
  let profile = await env.DB.prepare('SELECT friend_code FROM account_profiles WHERE account_id=?')
    .bind(accountId).first();
  if (profile?.friend_code) return String(profile.friend_code);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomHex(4).toUpperCase();
    try {
      await env.DB.prepare(`UPDATE account_profiles SET friend_code=?,updated_at=datetime('now')
        WHERE account_id=? AND friend_code IS NULL`).bind(code, accountId).run();
    } catch { /* unique collision; generate another */ }
    profile = await env.DB.prepare('SELECT friend_code FROM account_profiles WHERE account_id=?')
      .bind(accountId).first();
    if (profile?.friend_code) return String(profile.friend_code);
  }
  throw new Error('friend_code_unavailable');
}

const pair = (first, second) => Number(first) < Number(second)
  ? [Number(first), Number(second)] : [Number(second), Number(first)];

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
    ORDER BY f.updated_at DESC`).bind(accountId, accountId, accountId).all();
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
    await env.DB.prepare(`UPDATE friendships SET status='accepted',updated_at=datetime('now')
      WHERE account_low_id=? AND account_high_id=?`).bind(low, high).run();
    return json({ ok: true, accepted: true });
  }
  await env.DB.prepare(`INSERT INTO friendships(account_low_id,account_high_id,requested_by_account_id)
    VALUES(?,?,?) ON CONFLICT(account_low_id,account_high_id) DO UPDATE SET
    requested_by_account_id=excluded.requested_by_account_id,status='pending',updated_at=datetime('now')`)
    .bind(low, high, account.id).run();
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
    await env.DB.prepare(`UPDATE friendships SET status='accepted',updated_at=datetime('now')
      WHERE account_low_id=? AND account_high_id=?`).bind(low, high).run();
  } else {
    await env.DB.prepare('DELETE FROM friendships WHERE account_low_id=? AND account_high_id=?')
      .bind(low, high).run();
  }
  return json({ ok: true, accepted: accept === true });
}

async function removeFriend(env, account, rawCode) {
  const target = await accountByFriendCode(env, rawCode);
  if (!target) return json({ ok: false, error: 'friend_not_found' }, 404);
  const [low, high] = pair(account.id, target.id);
  await env.DB.prepare('DELETE FROM friendships WHERE account_low_id=? AND account_high_id=?')
    .bind(low, high).run();
  return json({ ok: true, removed: true });
}

function phaseSchedule(phase, durationSeconds, now) {
  const startsAt = now + 3000;
  if (phase === 'tap') return {
    phase: 'tap', startsAt, endsAt: startsAt + durationSeconds * 1000, drawAt: null,
  };
  const drawAt = startsAt + randomBetween(1800, 4200);
  return { phase: 'quick_draw', startsAt, endsAt: drawAt + 5000, drawAt };
}

async function scheduleTiebreaker(env, match, now) {
  const phase = nextTiebreakerPhase(match.phase);
  const duration = phase === 'tap' ? 30 : 0;
  const schedule = phaseSchedule(phase, duration, now);
  await env.DB.prepare(`UPDATE pvp_matches SET phase=?,duration_seconds=?,round_number=round_number+1,
      phase_starts_at=?,phase_ends_at=?,draw_at=?,updated_at=datetime('now')
    WHERE id=? AND status='active' AND round_number=?`)
    .bind(schedule.phase, duration, schedule.startsAt, schedule.endsAt, schedule.drawAt,
      match.id, match.round_number).run();
}

async function completeMatch(env, match, winnerAccountId) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE pvp_matches SET status='completed',winner_account_id=?,
      completed_at=datetime('now'),updated_at=datetime('now')
      WHERE id=? AND status='active'`).bind(winnerAccountId, match.id),
    env.DB.prepare(`INSERT OR IGNORE INTO pvp_rewards(match_id,winner_account_id,mentality_amount)
      SELECT id,winner_account_id,? FROM pvp_matches
      WHERE id=? AND status='completed' AND winner_account_id=?`)
      .bind(PVP_REWARD_MENTALITY, match.id, winnerAccountId),
  ]);
}

async function resolveMatch(env, match, now = Date.now()) {
  if (!match || match.status !== 'active' || now < Number(match.phase_starts_at || 0)) return;
  const scores = await env.DB.prepare(`SELECT account_id,tap_count,reaction_ms FROM pvp_round_scores
    WHERE match_id=? AND round_number=?`).bind(match.id, match.round_number).all();
  const byAccount = new Map((scores.results || []).map((row) => [Number(row.account_id), row]));
  const first = byAccount.get(Number(match.inviter_account_id));
  const second = byAccount.get(Number(match.invitee_account_id));
  // Allow the final cumulative score to cross the network after the visible
  // timer reaches zero. verifiedPvPTapCount still clamps its rate calculation
  // to phase_ends_at, so this grace period cannot manufacture extra taps.
  if (match.phase === 'tap'
      && now < Number(match.phase_ends_at) + TAP_SUBMISSION_GRACE_MS) return;
  if (match.phase === 'quick_draw' && !(first?.reaction_ms != null && second?.reaction_ms != null)
      && now < Number(match.phase_ends_at)) return;
  const comparison = comparePvPRound(match.phase, first, second);
  if (comparison === 0) return scheduleTiebreaker(env, match, now);
  return completeMatch(env, match,
    comparison > 0 ? Number(match.inviter_account_id) : Number(match.invitee_account_id));
}

async function matchById(env, matchId, accountId) {
  if (!validMatchId(matchId)) return null;
  return env.DB.prepare(`SELECT * FROM pvp_matches WHERE id=?
    AND (inviter_account_id=? OR invitee_account_id=?)`).bind(matchId, accountId, accountId).first();
}

async function pvpRows(env, accountId) {
  const active = await env.DB.prepare(`SELECT * FROM pvp_matches WHERE status='active'
    AND (inviter_account_id=? OR invitee_account_id=?) LIMIT 4`).bind(accountId, accountId).all();
  for (const match of active.results || []) await resolveMatch(env, match);
  const rows = await env.DB.prepare(`SELECT m.*,
      opponent.username AS opponent_username,op.friend_code AS opponent_code,
      mine.tap_count AS my_tap_count,mine.reaction_ms AS my_reaction_ms,
      theirs.tap_count AS opponent_tap_count,theirs.reaction_ms AS opponent_reaction_ms
    FROM pvp_matches m
    JOIN accounts opponent ON opponent.id=CASE WHEN m.inviter_account_id=? THEN m.invitee_account_id ELSE m.inviter_account_id END
    JOIN account_profiles op ON op.account_id=opponent.id
    LEFT JOIN pvp_round_scores mine ON mine.match_id=m.id AND mine.round_number=m.round_number AND mine.account_id=?
    LEFT JOIN pvp_round_scores theirs ON theirs.match_id=m.id AND theirs.round_number=m.round_number
      AND theirs.account_id=CASE WHEN m.inviter_account_id=? THEN m.invitee_account_id ELSE m.inviter_account_id END
    WHERE (m.inviter_account_id=? OR m.invitee_account_id=?)
      AND m.status NOT IN ('declined','cancelled')
    ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,m.updated_at DESC
    LIMIT 20`).bind(accountId, accountId, accountId, accountId, accountId).all();
  return rows.results || [];
}

function publicMatch(row, accountId) {
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
    phaseEndsAt: row.phase_ends_at == null ? null : Number(row.phase_ends_at),
    drawAt: row.draw_at == null ? null : Number(row.draw_at),
    myTapCount: Number(row.my_tap_count) || 0,
    opponentTapCount: Number(row.opponent_tap_count) || 0,
    myReactionMs: row.my_reaction_ms == null ? null : Number(row.my_reaction_ms),
    opponentReactionMs: row.opponent_reaction_ms == null ? null : Number(row.opponent_reaction_ms),
    won: row.status === 'completed' ? Number(row.winner_account_id) === Number(accountId) : null,
    rewardAmount: row.status === 'completed' && Number(row.winner_account_id) === Number(accountId)
      ? PVP_REWARD_MENTALITY : 0,
  };
}

async function multiplayerState(env, account) {
  await env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',updated_at=datetime('now')
    WHERE status='invited' AND created_at<datetime('now','-1 day')`).run();
  await env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',updated_at=datetime('now')
    WHERE status='active' AND updated_at<datetime('now','-30 minutes')`).run();
  const [friendCode, relationships, matches] = await Promise.all([
    ensureFriendCode(env, account.id), friendRows(env, account.id), pvpRows(env, account.id),
  ]);
  return json({
    ok: true,
    serverNow: Date.now(),
    friendCode,
    friends: relationships.filter((row) => row.status === 'accepted'),
    incomingRequests: relationships.filter((row) => row.status === 'pending' && row.direction === 'incoming'),
    outgoingRequests: relationships.filter((row) => row.status === 'pending' && row.direction === 'outgoing'),
    matches: matches.map((row) => publicMatch(row, account.id)),
  });
}

async function inviteMatch(req, env, account) {
  const body = await req.json().catch(() => ({}));
  const target = await accountByFriendCode(env, body.playerCode);
  const config = validatePvPInvite(body.mode, body.durationSeconds);
  if (!target || !config) return json({ ok: false, error: 'invalid_pvp_invite' }, 400);
  const [low, high] = pair(account.id, target.id);
  const friendship = await env.DB.prepare(`SELECT status FROM friendships
    WHERE account_low_id=? AND account_high_id=?`).bind(low, high).first();
  if (friendship?.status !== 'accepted') return json({ ok: false, error: 'friend_required' }, 409);
  const busy = await env.DB.prepare(`SELECT id FROM pvp_matches WHERE status IN ('invited','active')
    AND (inviter_account_id IN (?,?) OR invitee_account_id IN (?,?)) LIMIT 1`)
    .bind(account.id, target.id, account.id, target.id).first();
  if (busy) return json({ ok: false, error: 'player_busy' }, 409);
  const id = randomHex(16);
  await env.DB.prepare(`INSERT INTO pvp_matches(id,inviter_account_id,invitee_account_id,mode,duration_seconds)
    VALUES(?,?,?,?,?)`).bind(id, account.id, target.id, config.mode, config.durationSeconds).run();
  return json({ ok: true, matchId: id }, 201);
}

async function respondMatch(req, env, account, matchId) {
  const match = await matchById(env, matchId, account.id);
  if (!match || match.status !== 'invited' || Number(match.invitee_account_id) !== Number(account.id))
    return json({ ok: false, error: 'pvp_invite_not_found' }, 404);
  const { accept } = await req.json().catch(() => ({}));
  if (accept !== true) {
    await env.DB.prepare(`UPDATE pvp_matches SET status='declined',updated_at=datetime('now') WHERE id=?`)
      .bind(matchId).run();
    return json({ ok: true, accepted: false });
  }
  const now = Date.now();
  const schedule = phaseSchedule(match.mode, Number(match.duration_seconds), now);
  await env.DB.prepare(`UPDATE pvp_matches SET status='active',phase=?,round_number=1,
      phase_starts_at=?,phase_ends_at=?,draw_at=?,updated_at=datetime('now')
    WHERE id=? AND status='invited'`)
    .bind(schedule.phase, schedule.startsAt, schedule.endsAt, schedule.drawAt, matchId).run();
  return json({ ok: true, accepted: true });
}

async function cancelMatch(env, account, matchId) {
  const match = await matchById(env, matchId, account.id);
  if (!match || match.status !== 'invited' || Number(match.inviter_account_id) !== Number(account.id))
    return json({ ok: false, error: 'pvp_invite_not_found' }, 404);
  await env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',updated_at=datetime('now') WHERE id=?`)
    .bind(matchId).run();
  return json({ ok: true, cancelled: true });
}

async function recordTaps(req, env, account, matchId) {
  const match = await matchById(env, matchId, account.id);
  const now = Date.now();
  if (!match || match.status !== 'active' || match.phase !== 'tap')
    return json({ ok: false, error: 'tap_phase_unavailable' }, 409);
  if (now < Number(match.phase_starts_at)
      || now > Number(match.phase_ends_at) + TAP_SUBMISSION_GRACE_MS)
    return json({ ok: false, error: 'tap_phase_closed' }, 409);
  const { count } = await req.json().catch(() => ({}));
  const verified = verifiedPvPTapCount(count, match.phase_starts_at, match.phase_ends_at, now);
  if (verified === null) return json({ ok: false, error: 'unverified_pvp_tap_rate' }, 422);
  await env.DB.prepare(`INSERT INTO pvp_round_scores(match_id,round_number,account_id,tap_count,updated_at_ms)
    VALUES(?,?,?,?,?) ON CONFLICT(match_id,round_number,account_id) DO UPDATE SET
      tap_count=MAX(pvp_round_scores.tap_count,excluded.tap_count),updated_at_ms=excluded.updated_at_ms`)
    .bind(matchId, match.round_number, account.id, verified, now).run();
  return json({ ok: true, acceptedTaps: verified, serverNow: now });
}

async function recordDraw(env, account, matchId) {
  const match = await matchById(env, matchId, account.id);
  const now = Date.now();
  if (!match || match.status !== 'active' || match.phase !== 'quick_draw')
    return json({ ok: false, error: 'quick_draw_unavailable' }, 409);
  if (now < Number(match.phase_starts_at) || now > Number(match.phase_ends_at))
    return json({ ok: false, error: 'quick_draw_closed' }, 409);
  const reaction = now < Number(match.draw_at) ? -1 : now - Number(match.draw_at);
  await env.DB.prepare(`INSERT OR IGNORE INTO pvp_round_scores(
      match_id,round_number,account_id,reaction_ms,updated_at_ms
    ) VALUES(?,?,?,?,?)`).bind(matchId, match.round_number, account.id, reaction, now).run();
  const updated = await matchById(env, matchId, account.id);
  await resolveMatch(env, updated, now);
  return json({ ok: true, reactionMs: reaction, serverNow: now });
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
  const route = url.pathname.match(/^\/v1\/pvp\/([0-9a-f]{32})\/(respond|tap|draw|cancel)$/);
  if (!route || req.method !== 'POST') return null;
  if (route[2] === 'respond') return respondMatch(req, env, account, route[1]);
  if (route[2] === 'tap') return recordTaps(req, env, account, route[1]);
  if (route[2] === 'draw') return recordDraw(env, account, route[1]);
  return cancelMatch(env, account, route[1]);
}
