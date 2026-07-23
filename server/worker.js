// DISCIPLINE account API — Cloudflare Worker + D1.
// The Discipline account is platform-neutral: Android and iOS use the same
// login, save, inventory, leaderboard identity, and verified purchase ledger.

import { validateUsername } from './username-policy.js';
import { deletionPage, privacyPage } from './legal-pages.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
});
const html = (body) => new Response(body, {
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
});
const PASSWORD_MIN = 10;
const SESSION_SECONDS = 60 * 60 * 24 * 90;
const PRODUCTS = Object.freeze({
  m_handful: 120, m_stack: 280, m_pouch: 800, m_crate: 1800,
  m_vault: 4000, m_hoard: 11000, m_empire: 25000,
});
const ADMOB_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const ADMOB_REWARD_ITEM = 'completed_ad';
const ADMOB_REWARD_AMOUNT = 1;
let admobKeyCache = { expiresAt: 0, keys: new Map() };

const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
async function accountToken(accountId) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`discipline-account:${accountId}`))).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = bytesToHex(digest);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
const randomHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return bytesToHex(b); };
const base64url = (value) => btoa(typeof value === 'string' ? value : String.fromCharCode(...value))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha256 = async (value) => bytesToHex(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value),
)));
function base64urlBytes(value) {
  const text = String(value || '');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
function readDerLength(bytes, offset) {
  const first = bytes[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count < 1 || count > 2 || offset + count >= bytes.length) throw new Error('invalid_signature');
  let length = 0;
  for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset + 1 + i];
  return { length, next: offset + 1 + count };
}
function derEcdsaToRaw(der, width = 32) {
  let at = 0;
  if (der[at++] !== 0x30) throw new Error('invalid_signature');
  const sequence = readDerLength(der, at); at = sequence.next;
  if (sequence.length !== der.length - at || der[at++] !== 0x02) throw new Error('invalid_signature');
  const rLength = readDerLength(der, at); at = rLength.next;
  let r = der.slice(at, at + rLength.length); at += rLength.length;
  if (der[at++] !== 0x02) throw new Error('invalid_signature');
  const sLength = readDerLength(der, at); at = sLength.next;
  let s = der.slice(at, at + sLength.length); at += sLength.length;
  if (at !== der.length) throw new Error('invalid_signature');
  while (r.length > width && r[0] === 0) r = r.slice(1);
  while (s.length > width && s[0] === 0) s = s.slice(1);
  if (r.length > width || s.length > width) throw new Error('invalid_signature');
  const raw = new Uint8Array(width * 2);
  raw.set(r, width - r.length); raw.set(s, width * 2 - s.length);
  return raw;
}
async function admobKeys() {
  if (Date.now() < admobKeyCache.expiresAt && admobKeyCache.keys.size) return admobKeyCache.keys;
  const response = await fetch(ADMOB_KEYS_URL);
  if (!response.ok) throw new Error('admob_keys_unavailable');
  const body = await response.json();
  const keys = new Map();
  for (const item of body.keys || []) {
    if (!Number.isInteger(Number(item.keyId)) || typeof item.base64 !== 'string') continue;
    keys.set(String(item.keyId), await crypto.subtle.importKey(
      'spki', Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0)),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    ));
  }
  if (!keys.size) throw new Error('admob_keys_unavailable');
  admobKeyCache = { expiresAt: Date.now() + 23 * 60 * 60 * 1000, keys };
  return keys;
}
async function verifyAdmobCallback(req, env) {
  const url = new URL(req.url);
  const rawQuery = url.search.slice(1);
  const signatureAt = rawQuery.indexOf('&signature=');
  if (signatureAt < 1) return json({ ok: false, error: 'invalid_admob_callback' }, 400);
  const signedContent = rawQuery.slice(0, signatureAt);
  const params = url.searchParams;
  const signature = params.get('signature');
  const key = (await admobKeys()).get(String(params.get('key_id')));
  if (!key || !signature) return json({ ok: false, error: 'invalid_admob_signature' }, 400);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    derEcdsaToRaw(base64urlBytes(signature)), new TextEncoder().encode(signedContent),
  );
  if (!valid) return json({ ok: false, error: 'invalid_admob_signature' }, 400);

  const expectedAdUnit = String(env.ADMOB_REWARDED_AD_UNIT_ID || '2001670311');
  const timestamp = Number(params.get('timestamp'));
  const transactionId = params.get('transaction_id') || '';
  if (params.get('ad_unit') !== expectedAdUnit
      || Number(params.get('reward_amount')) !== ADMOB_REWARD_AMOUNT
      || params.get('reward_item') !== ADMOB_REWARD_ITEM
      || !/^[A-Fa-f0-9]{16,128}$/.test(transactionId)
      || !Number.isFinite(timestamp)
      || Math.abs(Date.now() - timestamp) > 48 * 60 * 60 * 1000)
    return json({ ok: false, error: 'invalid_admob_reward' }, 400);

  let custom;
  try { custom = JSON.parse(params.get('custom_data') || ''); }
  catch { return json({ ok: false, error: 'invalid_admob_custom_data' }, 400); }
  if (custom?.v !== 1 || !/^[0-9]+$/.test(String(custom.accountId || ''))
      || !/^[0-9a-f-]{36}$/i.test(String(custom.nonce || ''))
      || !['m', 'boost', 'offline'].includes(custom.kind))
    return json({ ok: false, error: 'invalid_admob_custom_data' }, 400);
  const account = await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(custom.accountId).first();
  if (!account || params.get('user_id') !== await accountToken(account.id))
    return json({ ok: false, error: 'invalid_admob_user' }, 400);
  try {
    await env.DB.prepare(`INSERT INTO ad_rewards(transaction_id,account_id,nonce,kind,ad_network,ad_unit,reward_amount,reward_item,rewarded_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(transactionId, account.id, custom.nonce, custom.kind,
      params.get('ad_network') || '', params.get('ad_unit'), ADMOB_REWARD_AMOUNT, ADMOB_REWARD_ITEM, timestamp).run();
  } catch {
    // Google retries callbacks. A duplicate transaction is already durable and
    // must still receive HTTP 200 so retries stop without creating two grants.
    const prior = await env.DB.prepare('SELECT transaction_id FROM ad_rewards WHERE transaction_id=?')
      .bind(transactionId).first();
    if (!prior) return json({ ok: false, error: 'reward_ledger_conflict' }, 409);
  }
  return json({ ok: true });
}
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
  const usernameError = validateUsername(username);
  if (usernameError) return json({ ok: false, error: usernameError }, 400);
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

async function renameAccount(req, env, account) {
  const { username } = await req.json();
  const usernameError = validateUsername(username);
  if (usernameError) return json({ ok: false, error: usernameError }, 400);
  try {
    // One UPDATE is atomic under D1's UNIQUE(lower_username) constraint. On
    // success the old value ceases to exist and can immediately be claimed.
    await env.DB.prepare(`UPDATE accounts SET username=?,lower_username=?,updated_at=datetime('now') WHERE id=?`)
      .bind(username, username.toLowerCase(), account.id).run();
  } catch { return json({ ok: false, error: 'username_taken' }, 409); }
  return json({ ok: true, account: { id: String(account.id), username } });
}

async function deleteAccount(env, account) {
  // Explicit deletes make the privacy guarantee independent of connection-
  // scoped foreign-key settings and leave no orphaned leaderboard/save data.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ad_rewards WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM purchases WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM scores WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM cloud_saves WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(account.id),
  ]);
  return json({ ok: true, deleted: true });
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
  // Purchases started while signed in carry an obfuscated account id. Verify
  // it against the authenticated Discipline account, never against client
  // input. Purchases made before login legitimately have no account id and
  // are bound by the first successful ledger claim instead.
  if (purchase.obfuscatedExternalAccountId
      && purchase.obfuscatedExternalAccountId !== await accountToken(account.id))
    return json({ ok: false, error: 'purchase_account_mismatch' }, 409);
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

function decodeJwsPayload(jws) {
  const part = String(jws || '').split('.')[1];
  if (!part) throw new Error('invalid_apple_response');
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))));
}

async function appleAccessToken(env) {
  if (!env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY)
    throw new Error('apple_billing_not_configured');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: env.APPLE_ISSUER_ID, iat: now, exp: now + 900,
    aud: 'appstoreconnect-v1', bid: env.APPLE_BUNDLE_ID || 'com.nosiah.discipline',
  }));
  const pem = String(env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n');
  const binary = atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

async function verifyIosPurchase(req, env, account) {
  const { productId, transactionId } = await req.json();
  const amount = PRODUCTS[productId];
  if (!amount || typeof transactionId !== 'string' || transactionId.length < 5)
    return json({ ok: false, error: 'invalid_purchase' }, 400);
  const token = await appleAccessToken(env);
  const paths = [
    'https://api.storekit.itunes.apple.com/inApps/v1/transactions/',
    'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/',
  ];
  let response = null;
  for (const root of paths) {
    response = await fetch(`${root}${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) break;
    if (response.status !== 404) break;
  }
  if (!response?.ok) return json({ ok: false, error: 'purchase_not_verified' }, 422);
  const result = await response.json();
  const transaction = decodeJwsPayload(result.signedTransactionInfo);
  const bundleId = env.APPLE_BUNDLE_ID || 'com.nosiah.discipline';
  if (String(transaction.transactionId) !== transactionId || transaction.productId !== productId
      || transaction.bundleId !== bundleId || transaction.revocationDate)
    return json({ ok: false, error: 'purchase_not_completed' }, 422);
  // Verify StoreKit's token against the authenticated server account. A
  // purchase made before login has no token and is bound by first ledger claim.
  if (transaction.appAccountToken && transaction.appAccountToken !== await accountToken(account.id))
    return json({ ok: false, error: 'purchase_account_mismatch' }, 409);
  try {
    await env.DB.prepare(`INSERT INTO purchases(account_id,platform,product_id,transaction_id,mentality_amount)
      VALUES(?,'ios',?,?,?)`).bind(account.id, productId, transactionId, amount).run();
  } catch {
    const prior = await env.DB.prepare(`SELECT account_id FROM purchases WHERE platform='ios' AND transaction_id=?`)
      .bind(transactionId).first();
    if (prior?.account_id === account.id) return json({ ok: true, alreadyRecorded: true, amount, transactionId });
    return json({ ok: false, error: 'purchase_already_claimed' }, 409);
  }
  return json({ ok: true, amount, transactionId });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/privacy') return html(privacyPage());
      if (req.method === 'GET' && url.pathname === '/account-deletion') return html(deletionPage());
      if (req.method === 'GET' && url.pathname === '/v1/admob/reward') return verifyAdmobCallback(req, env);
      if (req.method === 'POST' && url.pathname === '/v1/auth/register') return register(req, env);
      if (req.method === 'POST' && url.pathname === '/v1/auth/login') return login(req, env);
      const account = await authenticated(req, env);
      if (req.method === 'GET' && url.pathname === '/v1/board') return board(url, env, account);
      if (!account) return json({ ok: false, error: 'unauthorized' }, 401);
      if (req.method === 'GET' && url.pathname === '/v1/account') return json({ account: accountJson(account) });
      if (req.method === 'DELETE' && url.pathname === '/v1/account') return deleteAccount(env, account);
      if (req.method === 'PUT' && url.pathname === '/v1/account/username') return renameAccount(req, env, account);
      if (req.method === 'GET' && url.pathname === '/v1/save') {
        const row = await env.DB.prepare('SELECT revision,save_json,updated_at FROM cloud_saves WHERE account_id=?').bind(account.id).first();
        return json({ revision: row?.revision || 0, save: row ? JSON.parse(row.save_json) : null, updatedAt: row?.updated_at || null });
      }
      if (req.method === 'PUT' && url.pathname === '/v1/save') return saveGame(req, env, account);
      if (req.method === 'GET' && url.pathname === '/v1/purchases') return purchases(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/purchases/android/verify') return verifyAndroidPurchase(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/purchases/ios/verify') return verifyIosPurchase(req, env, account);
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
