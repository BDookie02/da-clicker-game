// DISCIPLINE account API — Cloudflare Worker + D1.
// The Discipline account is platform-neutral: Android and iOS use the same
// login, save, inventory, leaderboard identity, and verified purchase ledger.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});
const USER_RE = /^[A-Za-z0-9_]{3,14}$/;
const PASSWORD_MIN = 10;
const SESSION_SECONDS = 60 * 60 * 24 * 90;
const PRODUCTS = Object.freeze({
  m_handful: 120, m_stack: 280, m_pouch: 800, m_crate: 1800,
  m_vault: 4000, m_hoard: 11000, m_empire: 25000,
});

const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
const randomHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return bytesToHex(b); };
const base64url = (value) => btoa(typeof value === 'string' ? value : String.fromCharCode(...value))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha256 = async (value) => bytesToHex(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value),
)));
async function passwordHash(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: 210000 }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function createSession(env, accountId) {
  const token = randomHex(32); const tokenHash = await sha256(token);
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await env.DB.prepare('INSERT INTO sessions(token_hash, account_id, expires_at) VALUES(?,?,?)')
    .bind(tokenHash, accountId, expires).run();
  return { token, expires };
}
async function authenticated(req, env) {
  const raw = req.headers.get('Authorization') || '';
  if (!raw.startsWith('Bearer ')) return null;
  const tokenHash = await sha256(raw.slice(7));
  return env.DB.prepare(`SELECT a.id, a.username, a.lower_username
    FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
}
const accountJson = (row) => ({ id: String(row.id), username: row.username });
function validSave(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(Number(value.totalTaps)) && Number(value.totalTaps) >= 0;
}

async function register(req, env) {
  const { username, password } = await req.json();
  if (!USER_RE.test(username || '')) return json({ ok: false, error: 'invalid_username' }, 400);
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 128)
    return json({ ok: false, error: 'weak_password' }, 400);
  const salt = randomHex(16); const hash = await passwordHash(password, salt);
  try {
    await env.DB.prepare(`INSERT INTO accounts(username,lower_username,password_salt,password_hash)
      VALUES(?,?,?,?)`).bind(username, username.toLowerCase(), salt, hash).run();
  } catch { return json({ ok: false, error: 'username_taken' }, 409); }
  const account = await env.DB.prepare('SELECT id,username FROM accounts WHERE lower_username=?')
    .bind(username.toLowerCase()).first();
  const session = await createSession(env, account.id);
  return json({ ok: true, account: accountJson(account), ...session }, 201);
}
async function login(req, env) {
  const { username, password } = await req.json();
  const account = await env.DB.prepare(`SELECT id,username,password_salt,password_hash
    FROM accounts WHERE lower_username=?`).bind(String(username || '').toLowerCase()).first();
  if (!account || typeof password !== 'string') return json({ ok: false, error: 'invalid_login' }, 401);
  const candidate = await passwordHash(password, account.password_salt);
  if (!constantTimeEqual(candidate, account.password_hash)) return json({ ok: false, error: 'invalid_login' }, 401);
  const session = await createSession(env, account.id);
  return json({ ok: true, account: accountJson(account), ...session });
}

async function saveGame(req, env, account) {
  const { save, revision } = await req.json();
  if (!validSave(save)) return json({ ok: false, error: 'invalid_save' }, 400);
  const encoded = JSON.stringify(save);
  if (encoded.length > 256000) return json({ ok: false, error: 'save_too_large' }, 413);
  const current = await env.DB.prepare('SELECT revision FROM cloud_saves WHERE account_id=?').bind(account.id).first();
  if (current && Number(revision) !== Number(current.revision))
    return json({ ok: false, error: 'save_conflict', revision: current.revision }, 409);
  const next = (current?.revision || 0) + 1;
  const taps = Math.min(10_000_000_000_000, Math.floor(Number(save.totalTaps)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_saves(account_id,revision,save_json) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,save_json=excluded.save_json,updated_at=datetime('now')`)
      .bind(account.id, next, encoded),
    env.DB.prepare(`INSERT INTO scores(account_id,taps) VALUES(?,?)
      ON CONFLICT(account_id) DO UPDATE SET taps=MAX(taps,excluded.taps),updated_at=datetime('now')`)
      .bind(account.id, taps),
  ]);
  return json({ ok: true, revision: next });
}

async function board(url, env, account) {
  const limit = Math.min(100, Math.max(10, Number(url.searchParams.get('limit')) || 50));
  const top = await env.DB.prepare(`SELECT a.username AS name,s.taps,a.id AS account_id
    FROM scores s JOIN accounts a ON a.id=s.account_id ORDER BY s.taps DESC,s.updated_at ASC LIMIT ?`)
    .bind(limit).all();
  let me = null;
  if (account) {
    const row = await env.DB.prepare('SELECT taps FROM scores WHERE account_id=?').bind(account.id).first();
    if (row) {
      const above = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE taps>?').bind(row.taps).first();
      me = { rank: Number(above.n) + 1, name: account.username, taps: row.taps };
    }
  }
  return json({ top: (top.results || []).map((r, i) => ({ rank: i + 1, name: r.name, taps: r.taps, you: account && r.account_id === account.id })), me });
}

async function purchases(req, env, account) {
  const rows = await env.DB.prepare(`SELECT platform,product_id,transaction_id,mentality_amount,verified_at
    FROM purchases WHERE account_id=? ORDER BY verified_at DESC`).bind(account.id).all();
  const spent = await env.DB.prepare('SELECT COALESCE(SUM(mentality_amount),0) AS m FROM purchases WHERE account_id=?')
    .bind(account.id).first();
  return json({ purchases: rows.results || [], purchasedMentality: spent.m });
}

async function googleAccessToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('google_billing_not_configured');
  const service = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: service.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const binary = atob(service.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!res.ok) throw new Error('google_auth_failed');
  return (await res.json()).access_token;
}

async function verifyAndroidPurchase(req, env, account) {
  const { productId, purchaseToken } = await req.json();
  const amount = PRODUCTS[productId];
  if (!amount || typeof purchaseToken !== 'string' || purchaseToken.length < 20)
    return json({ ok: false, error: 'invalid_purchase' }, 400);
  const access = await googleAccessToken(env);
  const root = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.nosiah.discipline';
  const verifyUrl = `${root}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const verified = await fetch(verifyUrl, { headers: { Authorization: `Bearer ${access}` } });
  if (!verified.ok) return json({ ok: false, error: 'purchase_not_verified' }, 422);
  const purchase = await verified.json();
  if (purchase.purchaseState !== 0 || !purchase.orderId)
    return json({ ok: false, error: 'purchase_not_completed' }, 422);
  const tokenHash = await sha256(purchaseToken);
  try {
    await env.DB.prepare(`INSERT INTO purchases(account_id,platform,product_id,transaction_id,purchase_token_hash,mentality_amount)
      VALUES(?,'android',?,?,?,?)`).bind(account.id, productId, purchase.orderId, tokenHash, amount).run();
  } catch {
    const prior = await env.DB.prepare(`SELECT account_id FROM purchases WHERE platform='android' AND transaction_id=?`)
      .bind(purchase.orderId).first();
    if (prior?.account_id === account.id) return json({ ok: true, alreadyRecorded: true, amount, transactionId: purchase.orderId });
    return json({ ok: false, error: 'purchase_already_claimed' }, 409);
  }
  // Consume only after the durable ledger insert. This permits another pack
  // purchase and prevents a crash between granting and consuming from duping M.
  const consume = await fetch(`${verifyUrl}:consume`, { method: 'POST', headers: { Authorization: `Bearer ${access}` } });
  if (!consume.ok) console.error('Google consume failed', await consume.text());
  return json({ ok: true, amount, transactionId: purchase.orderId });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === 'POST' && url.pathname === '/v1/auth/register') return register(req, env);
      if (req.method === 'POST' && url.pathname === '/v1/auth/login') return login(req, env);
      const account = await authenticated(req, env);
      if (req.method === 'GET' && url.pathname === '/v1/board') return board(url, env, account);
      if (!account) return json({ ok: false, error: 'unauthorized' }, 401);
      if (req.method === 'GET' && url.pathname === '/v1/account') return json({ account: accountJson(account) });
      if (req.method === 'GET' && url.pathname === '/v1/save') {
        const row = await env.DB.prepare('SELECT revision,save_json,updated_at FROM cloud_saves WHERE account_id=?').bind(account.id).first();
        return json({ revision: row?.revision || 0, save: row ? JSON.parse(row.save_json) : null, updatedAt: row?.updated_at || null });
      }
      if (req.method === 'PUT' && url.pathname === '/v1/save') return saveGame(req, env, account);
      if (req.method === 'GET' && url.pathname === '/v1/purchases') return purchases(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/purchases/android/verify') return verifyAndroidPurchase(req, env, account);
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
