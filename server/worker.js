// DISCIPLINE. backend — Cloudflare Worker + D1.
// Handles unique username claims (atomic via UNIQUE constraint) and the
// worldwide All-Time Taps leaderboard.
//
// Deploy (free tier, ~2 minutes once you have a Cloudflare account):
//   npm i -g wrangler
//   wrangler d1 create discipline-db          # paste the id into wrangler.toml
//   wrangler d1 execute discipline-db --file=server/schema.sql --remote
//   wrangler deploy server/worker.js
// Then set API_URL in src/config.ts to the worker URL and rebuild.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const NAME_RE = /^[A-Za-z0-9_]{3,14}$/;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    try {
      if (req.method === 'POST' && url.pathname === '/claim') {
        const { name, old } = await req.json();
        if (typeof name !== 'string' || !NAME_RE.test(name)) return json({ ok: false, error: 'invalid' }, 400);
        try {
          // UNIQUE(lower_name) makes this atomic — two racers can't both win
          await env.DB.prepare('INSERT INTO names (name, lower_name) VALUES (?, ?)')
            .bind(name, name.toLowerCase()).run();
        } catch {
          return json({ ok: false, error: 'taken' }, 409);
        }
        if (typeof old === 'string' && NAME_RE.test(old)) {
          await env.DB.prepare('DELETE FROM names WHERE lower_name = ?').bind(old.toLowerCase()).run();
          await env.DB.prepare('UPDATE scores SET name = ?, lower_name = ? WHERE lower_name = ?')
            .bind(name, name.toLowerCase(), old.toLowerCase()).run();
        }
        return json({ ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/score') {
        const { name, taps } = await req.json();
        if (typeof name !== 'string' || !NAME_RE.test(name)) return json({ ok: false }, 400);
        const t = Math.max(0, Math.floor(Number(taps) || 0));
        if (t > 10_000_000_000) return json({ ok: false }, 400); // sanity ceiling
        await env.DB.prepare(`INSERT INTO scores (lower_name, name, taps) VALUES (?, ?, ?)
          ON CONFLICT(lower_name) DO UPDATE SET taps = MAX(taps, excluded.taps), name = excluded.name`)
          .bind(name.toLowerCase(), name, t).run();
        return json({ ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/board') {
        const me = (url.searchParams.get('name') ?? '').toLowerCase();
        const top = await env.DB.prepare('SELECT name, taps FROM scores ORDER BY taps DESC LIMIT 10').all();
        let mine = null;
        if (me) {
          const row = await env.DB.prepare('SELECT name, taps FROM scores WHERE lower_name = ?').bind(me).first();
          if (row) {
            const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE taps > ?').bind(row.taps).first();
            const near = await env.DB.prepare(
              `SELECT name, taps FROM scores WHERE taps >= ? AND lower_name != ? ORDER BY taps ASC LIMIT 2`)
              .bind(row.taps, me).all();
            const below = await env.DB.prepare(
              `SELECT name, taps FROM scores WHERE taps < ? ORDER BY taps DESC LIMIT 2`).bind(row.taps).all();
            mine = { rank: (above?.n ?? 0) + 1, name: row.name, taps: row.taps,
              near: [...(near?.results ?? []).reverse(), ...(below?.results ?? [])] };
          }
        }
        return json({ top: top?.results ?? [], me: mine });
      }
    } catch (e) {
      return json({ ok: false, error: 'server' }, 500);
    }
    return json({ ok: false, error: 'not found' }, 404);
  },
};
