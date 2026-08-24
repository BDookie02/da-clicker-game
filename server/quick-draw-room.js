import {
  QUICK_DRAW_WINDOW_MS,
  commitQuickDrawScore,
} from './multiplayer.js';

export const QUICK_DRAW_RTT_SAMPLE_TARGET = 5;
export const QUICK_DRAW_MIN_RTT_SAMPLES = 3;
export const QUICK_DRAW_MAX_RTT_ADJUSTMENT_MS = 75;
const MAX_SOCKET_MESSAGE_CHARS = 512;

const randomHex = (bytes) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export function boundedQuickDrawRttAdjustment(samples) {
  const valid = (Array.isArray(samples) ? samples : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 2000)
    .slice(0, QUICK_DRAW_RTT_SAMPLE_TARGET)
    .sort((a, b) => a - b);
  if (valid.length < QUICK_DRAW_MIN_RTT_SAMPLES) return 0;
  const middle = Math.floor(valid.length / 2);
  const median = valid.length % 2
    ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
  return Math.min(QUICK_DRAW_MAX_RTT_ADJUSTMENT_MS,
    Math.max(0, Math.round(median / 2)));
}

const send = (socket, body) => {
  try { socket.send(JSON.stringify(body)); } catch { /* REST polling recovers state */ }
};

const socketAttachment = (socket) => {
  try { return socket.deserializeAttachment() || null; } catch { return null; }
};

// A plain exported class is deliberately used so the existing Node unit suite
// can import the Worker module. Cloudflare's current Workers test API supports
// this Durable Object class shape; the runtime supplies ctx and env.
export class QuickDrawRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async match(matchId) {
    return this.env.DB.prepare(`SELECT * FROM pvp_matches WHERE id=?`)
      .bind(matchId).first();
  }

  async resetRound(match) {
    const roundKey = `${match.id}:${match.round_number}`;
    const stored = await this.ctx.storage.get('roundKey');
    // Keep the alarm lookup key repairable even if an earlier object write was
    // interrupted between the two storage operations.
    await this.ctx.storage.put('matchId', String(match.id));
    if (stored === roundKey) return;
    await this.ctx.storage.put('roundKey', roundKey);
    await this.ctx.storage.delete('nonce');
    await this.ctx.storage.delete('issuedAt');
  }

  async initialize(matchId) {
    const match = await this.match(matchId);
    if (!match || match.status !== 'active' || match.phase !== 'quick_draw') return null;
    await this.resetRound(match);
    if (match.quick_draw_issued_at != null) await this.issueDraw(match);
    else await this.ctx.storage.setAlarm(Math.max(Date.now(), Number(match.draw_at)));
    return match;
  }

  async claimIssuedAt(match) {
    if (match.quick_draw_issued_at != null) return match;
    const issuedAt = Date.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (issuedAt < Number(match.draw_at)) {
        await this.ctx.storage.setAlarm(Number(match.draw_at));
        return null;
      }
      const result = await this.env.DB.prepare(`UPDATE pvp_matches
        SET quick_draw_issued_at=?,phase_ends_at=?,state_revision=state_revision+1,
          updated_at=datetime('now')
        WHERE id=? AND status='active' AND phase='quick_draw' AND round_number=?
          AND state_revision=? AND quick_draw_issued_at IS NULL`).bind(
        issuedAt, issuedAt + QUICK_DRAW_WINDOW_MS, match.id,
        match.round_number, match.state_revision,
      ).run();
      const updated = await this.match(match.id);
      if (Number(result?.meta?.changes || 0) || updated?.quick_draw_issued_at != null)
        return updated;
      if (!updated || updated.status !== 'active' || updated.phase !== 'quick_draw') return null;
      match = updated;
    }
    return null;
  }

  async issueDraw(rawMatch) {
    const match = await this.claimIssuedAt(rawMatch);
    if (!match?.quick_draw_issued_at) return;
    await this.resetRound(match);
    let nonce = await this.ctx.storage.get('nonce');
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) {
      nonce = randomHex(16);
      await this.ctx.storage.put('nonce', nonce);
    }
    const issuedAt = Number(match.quick_draw_issued_at);
    await this.ctx.storage.put('issuedAt', issuedAt);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(socket);
      if (!attachment || String(attachment.matchId) !== String(match.id)
          || Number(attachment.roundNumber) !== Number(match.round_number)) continue;
      attachment.drawIssued = true;
      socket.serializeAttachment(attachment);
      send(socket, {
        type: 'draw', nonce, roundNumber: Number(match.round_number),
        serverNow: Date.now(), phaseEndsAt: Number(match.phase_ends_at),
      });
    }
  }

  startPing(socket, attachment) {
    if (attachment.drawIssued || attachment.responded
        || attachment.rttSamples.length >= QUICK_DRAW_RTT_SAMPLE_TARGET) return;
    attachment.pingId = randomHex(8);
    attachment.pingSentAt = Date.now();
    socket.serializeAttachment(attachment);
    send(socket, { type: 'ping', id: attachment.pingId });
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') {
      try {
        // These zero/one-row reads force the live DO's D1 binding to resolve
        // every column/table introduced by migrations 0013 and 0014. A stale
        // production schema therefore fails readiness before the API reopens.
        await this.env.DB.batch([
          this.env.DB.prepare(`SELECT quick_draw_issued_at,tap_commit_barrier_until
            FROM pvp_matches LIMIT 1`),
          this.env.DB.prepare(`SELECT raw_reaction_ms,rtt_adjustment_ms,reaction_transport
            FROM pvp_round_scores LIMIT 1`),
          this.env.DB.prepare('SELECT token_hash FROM pvp_socket_tickets LIMIT 1'),
        ]);
        return Response.json({ ready: true });
      } catch {
        return Response.json({ ready: false }, { status: 503 });
      }
    }
    const matchId = request.headers.get('X-DISCIPLINE-Match-Id') || '';
    if (!/^[0-9a-f]{32}$/.test(matchId)) return new Response('invalid match', { status: 400 });
    if (pathname === '/init') {
      const match = await this.initialize(matchId);
      return new Response(match ? 'ready' : 'inactive', { status: match ? 200 : 409 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('upgrade required', { status: 426 });
    const accountId = Number(request.headers.get('X-DISCIPLINE-Account-Id'));
    if (!Number.isSafeInteger(accountId) || accountId < 1)
      return new Response('invalid account', { status: 401 });
    const match = await this.match(matchId);
    if (!match || match.status !== 'active' || match.phase !== 'quick_draw'
        || (Number(match.inviter_account_id) !== accountId
          && Number(match.invitee_account_id) !== accountId))
      return new Response('match unavailable', { status: 409 });
    const prior = await this.env.DB.prepare(`SELECT reaction_ms FROM pvp_round_scores
      WHERE match_id=? AND round_number=? AND account_id=?`).bind(
      matchId, match.round_number, accountId,
    ).first();
    for (const existing of this.ctx.getWebSockets(`account:${accountId}`)) {
      try { existing.close(4001, 'Replaced by a newer connection'); } catch { /* disconnected */ }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`account:${accountId}`]);
    const attachment = {
      matchId, accountId, roundNumber: Number(match.round_number),
      rttSamples: [], pingId: '', pingSentAt: 0,
      messageWindowStartedAt: Date.now(), messageCount: 0,
      drawIssued: match.quick_draw_issued_at != null,
      responded: prior?.reaction_ms !== null && prior?.reaction_ms !== undefined,
    };
    server.serializeAttachment(attachment);
    send(server, {
      type: 'ready', roundNumber: attachment.roundNumber,
      phaseStartsAt: Number(match.phase_starts_at), serverNow: Date.now(),
      responded: attachment.responded,
    });
    if (!attachment.drawIssued) this.startPing(server, attachment);
    await this.initialize(matchId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > MAX_SOCKET_MESSAGE_CHARS) {
      try { socket.close(1009, 'Message too large'); } catch { /* disconnected */ }
      return;
    }
    let body;
    try { body = JSON.parse(message); } catch { return; }
    const attachment = socketAttachment(socket);
    if (!attachment || attachment.responded) return;
    const messageNow = Date.now();
    if (messageNow - Number(attachment.messageWindowStartedAt || 0) >= 1000) {
      attachment.messageWindowStartedAt = messageNow;
      attachment.messageCount = 0;
    }
    attachment.messageCount = Number(attachment.messageCount || 0) + 1;
    if (attachment.messageCount > 60) {
      try { socket.close(1008, 'Message rate exceeded'); } catch { /* disconnected */ }
      return;
    }
    socket.serializeAttachment(attachment);
    if (body?.type === 'pong') {
      if (attachment.drawIssued || body.id !== attachment.pingId || !attachment.pingSentAt) return;
      const rtt = Date.now() - Number(attachment.pingSentAt);
      if (Number.isFinite(rtt) && rtt >= 0 && rtt <= 2000)
        attachment.rttSamples = [...attachment.rttSamples, rtt]
          .slice(0, QUICK_DRAW_RTT_SAMPLE_TARGET);
      attachment.pingId = '';
      attachment.pingSentAt = 0;
      socket.serializeAttachment(attachment);
      this.startPing(socket, attachment);
      return;
    }
    const match = await this.match(attachment.matchId);
    if (!match || match.status !== 'active' || match.phase !== 'quick_draw'
        || Number(match.round_number) !== Number(attachment.roundNumber)) return;
    const submittedAt = Date.now();
    let reactionMs;
    let rawReactionMs;
    let adjustment = 0;
    if (body?.type === 'early' && !attachment.drawIssued
        && match.quick_draw_issued_at == null) {
      reactionMs = -1;
      rawReactionMs = -1;
    } else {
      const nonce = await this.ctx.storage.get('nonce');
      const issuedAt = Number(match.quick_draw_issued_at);
      if (body?.type !== 'draw_response' || !attachment.drawIssued
          || typeof nonce !== 'string' || body.nonce !== nonce
          || !Number.isFinite(issuedAt)) {
        send(socket, { type: 'error', code: 'invalid_draw_nonce' });
        return;
      }
      rawReactionMs = Math.max(0, submittedAt - issuedAt);
      adjustment = boundedQuickDrawRttAdjustment(attachment.rttSamples);
      // RTT remains useful audit telemetry, but competitive ordering uses the
      // unadjusted authoritative server-receipt time for both players.
      reactionMs = rawReactionMs;
    }
    const result = await commitQuickDrawScore(this.env, {
      matchId: attachment.matchId, accountId: attachment.accountId,
      roundNumber: attachment.roundNumber, submittedAt,
      reactionMs, rawReactionMs, rttAdjustmentMs: adjustment,
      transport: 'websocket',
    });
    if (!result.ok) {
      send(socket, { type: 'error', code: result.error });
      return;
    }
    attachment.responded = true;
    socket.serializeAttachment(attachment);
    send(socket, {
      type: 'accepted', reactionMs: result.reactionMs,
      serverNow: Date.now(),
    });
  }

  async alarm() {
    const matchId = await this.ctx.storage.get('matchId');
    if (typeof matchId !== 'string') return;
    const match = await this.match(matchId);
    if (!match || match.status !== 'active' || match.phase !== 'quick_draw') return;
    await this.issueDraw(match);
  }

  async webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch { /* already closed */ }
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'WebSocket error'); } catch { /* already closed */ }
  }
}
