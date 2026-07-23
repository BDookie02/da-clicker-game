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
const AD_M_REWARD = 5;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UPGRADE_LIMITS = Object.freeze({ focus: 1_000_000, grip: 1_000_000, wrist: 1_000_000, posture: 1_000_000, eyecont: 8, mindset: 1_000_000 });
const CREW_IDS = Object.freeze(['hypeman', 'backseat', 'camera', 'editor', 'coach', 'monk']);
const LAB_COSTS = Object.freeze({ lab_grip: 120, lab_offline: 200, lab_boost: 300, lab_mental: 450 });
const COSMETICS = Object.freeze({
  orn_napkin: [50, 'ornament'], decal_ment: [75, 'decal'], decal_disc: [75, 'decal'],
  goop_gold: [200, 'goop'], goop_slime: [200, 'goop'], sky_sunset: [125, 'sky'], sky_vapor: [125, 'sky'],
  horn_sad: [150, 'horn'], orn_cowboy: [175, 'ornament'], decal_aura: [125, 'decal'],
  decal_engage: [125, 'decal'], goop_pink: [225, 'goop'], goop_blue: [225, 'goop'], goop_oil: [300, 'goop'],
  sky_storm: [150, 'sky'], sky_noir: [150, 'sky'], sky_toxic: [150, 'sky'], sky_mint: [150, 'sky'],
  orn_cone: [125, 'ornament'], orn_monk: [225, 'ornament'], horn_air: [175, 'horn'],
  dangle_dice: [90, 'dangler'], dangle_beads: [110, 'dangler'], dangle_yinyang: [140, 'dangler'],
  dangle_fire: [175, 'dangler'], dangle_censored: [225, 'dangler'], dangle_testing_coals: [200, 'dangler'],
  dangle_goop: [250, 'dangler'], roof_taxi: [175, 'roof'],
});
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
  return env.DB.prepare(`SELECT a.id, a.username, a.lower_username,
      CAST(strftime('%s',a.created_at) AS INTEGER) AS created_epoch
    FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
}
const accountJson = (row) => ({ id: String(row.id), username: row.username });
function validSave(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(Number(value.totalTaps)) && Number(value.totalTaps) >= 0;
}

const integer = (value, min, max, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
};
const knownList = (value, allowed) => Array.isArray(value)
  ? [...new Set(value.filter((id) => typeof id === 'string' && Object.hasOwn(allowed, id)))] : [];
const levelMap = (value, limits) => {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, limit] of Object.entries(limits)) {
    const level = integer(value[id], 0, limit);
    if (level) result[id] = level;
  }
  return result;
};

/** The client owns ordinary offline clicker progress. Premium currency and
 * durable entitlements come only from the server's verified ad/purchase
 * ledger, and owned items can never disappear because a stale device saves. */
export function sanitizeSave(value, authority, previous = null, username = null) {
  if (!validSave(value)) throw new Error('invalid_save');
  const priorOwned = knownList(previous?.ownedCosmetics, COSMETICS);
  const requestedOwned = knownList(value.ownedCosmetics, COSMETICS);
  const ownedCosmetics = [...new Set([...priorOwned, ...requestedOwned])];
  const priorLabs = knownList(previous?.labOwned, LAB_COSTS);
  const requestedLabs = knownList(value.labOwned, LAB_COSTS);
  const labOwned = [...new Set([...priorLabs, ...requestedLabs])];
  const premiumSpent = ownedCosmetics.reduce((sum, id) => sum + COSMETICS[id][0], 0)
    + labOwned.reduce((sum, id) => sum + LAB_COSTS[id], 0);
  const earnedMentality = integer(authority.earnedMentality, 0, MAX_SAFE);
  if (premiumSpent > earnedMentality) throw new Error('unverified_premium_spend');

  const dashboardSlots = [];
  for (const id of Array.isArray(value.dashboardSlots) ? value.dashboardSlots.slice(0, 6) : []) {
    const valid = typeof id === 'string' && ownedCosmetics.includes(id)
      && ['ornament', 'dash'].includes(COSMETICS[id]?.[1]) && !dashboardSlots.includes(id);
    dashboardSlots.push(valid ? id : null);
  }
  while (dashboardSlots.length < 6) dashboardSlots.push(null);
  const equippedCosmetics = {};
  if (value.equippedCosmetics && typeof value.equippedCosmetics === 'object' && !Array.isArray(value.equippedCosmetics)) {
    for (const [slot, id] of Object.entries(value.equippedCosmetics)) {
      if (typeof id === 'string' && ownedCosmetics.includes(id) && COSMETICS[id]?.[1] === slot)
        equippedCosmetics[slot] = id;
    }
  }
  const crewLimits = Object.fromEntries(CREW_IDS.map((id) => [id, 1_000_000]));
  const now = Date.now();
  return {
    economyVersion: 1,
    username,
    prestiges: integer(value.prestiges, 0, 1_000_000),
    respect: integer(value.respect, 0, MAX_SAFE),
    mentality: earnedMentality - premiumSpent,
    totalTaps: integer(authority.totalTaps, 0, 10_000_000_000_000),
    opponentIndex: integer(value.opponentIndex, 0, 10_000),
    opponentProgress: integer(value.opponentProgress, 0, MAX_SAFE),
    upgradeLevels: levelMap(value.upgradeLevels, UPGRADE_LIMITS),
    crewCounts: levelMap(value.crewCounts, crewLimits),
    ownedCosmetics,
    labOwned,
    equippedCosmetics,
    dashboardSlots,
    boostMult: [1, 2, 5, 10].includes(Number(value.boostMult)) ? Number(value.boostMult) : 1,
    boostEndsAt: integer(value.boostEndsAt, 0, now + 7 * 24 * 60 * 60 * 1000),
    lastSeen: integer(value.lastSeen, 0, now + 5 * 60 * 1000, now),
    adsWatched: integer(authority.adCount, 0, MAX_SAFE),
    infiniteCurrency: false,
    appliedPurchases: [...new Set(authority.purchaseIds || [])].slice(-500),
    textSizeTier: integer(value.textSizeTier, 0, 3),
    tutorialComplete: Boolean(value.tutorialComplete),
  };
}

async function economyAuthority(env, accountId) {
  const [purchases, ads, ids] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(mentality_amount),0) AS amount FROM purchases WHERE account_id=?').bind(accountId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN kind='m' THEN 1 ELSE 0 END),0) AS m_count FROM ad_rewards WHERE account_id=?`).bind(accountId).first(),
    env.DB.prepare('SELECT transaction_id FROM purchases WHERE account_id=? ORDER BY verified_at ASC').bind(accountId).all(),
  ]);
  return {
    earnedMentality: integer(purchases?.amount, 0, MAX_SAFE) + integer(ads?.m_count, 0, MAX_SAFE) * AD_M_REWARD,
    adCount: integer(ads?.count, 0, MAX_SAFE),
    purchaseIds: (ids?.results || []).map((row) => String(row.transaction_id)),
  };
}

export function verifiedTapTotal(requested, prior, anchorSeconds, nowSeconds) {
  const priorTaps = integer(prior, 0, 10_000_000_000_000);
  const requestedTaps = integer(requested, 0, 10_000_000_000_000);
  const anchor = integer(anchorSeconds, 0, nowSeconds, nowSeconds);
  const maximumTaps = priorTaps + 5 + Math.max(0, nowSeconds - anchor) * 25;
  if (requestedTaps > maximumTaps) return null;
  return Math.max(priorTaps, requestedTaps);
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
  if (JSON.stringify(save).length > 256000) return json({ ok: false, error: 'save_too_large' }, 413);
  const [current, score, economy] = await Promise.all([
    env.DB.prepare('SELECT revision,save_json FROM cloud_saves WHERE account_id=?').bind(account.id).first(),
    env.DB.prepare(`SELECT taps,CAST(strftime('%s',updated_at) AS INTEGER) AS updated_epoch FROM scores WHERE account_id=?`).bind(account.id).first(),
    economyAuthority(env, account.id),
  ]);
  if (current && Number(revision) !== Number(current.revision))
    return json({ ok: false, error: 'save_conflict', revision: current.revision }, 409);
  const next = (current?.revision || 0) + 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const anchor = integer(score?.updated_epoch || account.created_epoch, 0, nowSeconds, nowSeconds);
  // Raw-tap rankings are intentionally independent from boosters and idle
  // Respect. A generous 25 taps/second bound preserves legitimate multi-touch
  // play while preventing a modified client from uploading an arbitrary score.
  const taps = verifiedTapTotal(save.totalTaps, score?.taps, anchor, nowSeconds);
  if (taps === null)
    return json({ ok: false, error: 'unverified_tap_rate', acceptedTaps: integer(score?.taps, 0, 10_000_000_000_000) }, 422);
  let previous = null;
  try { previous = current?.save_json ? JSON.parse(current.save_json) : null; } catch { previous = null; }
  let clean;
  try { clean = sanitizeSave(save, { ...economy, totalTaps: taps }, previous, account.username); }
  catch (error) {
    const code = error?.message === 'unverified_premium_spend' ? 409 : 400;
    return json({ ok: false, error: error?.message || 'invalid_save' }, code);
  }
  const encoded = JSON.stringify(clean);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_saves(account_id,revision,save_json) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,save_json=excluded.save_json,updated_at=datetime('now')`)
      .bind(account.id, next, encoded),
    env.DB.prepare(`INSERT INTO scores(account_id,taps) VALUES(?,?)
      ON CONFLICT(account_id) DO UPDATE SET taps=excluded.taps,updated_at=datetime('now')
      WHERE excluded.taps>scores.taps`)
      .bind(account.id, taps),
  ]);
  return json({ ok: true, revision: next, mentality: clean.mentality, totalTaps: taps });
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
        if (!row) return json({ revision: 0, save: null, updatedAt: null });
        const [economy, score] = await Promise.all([
          economyAuthority(env, account.id),
          env.DB.prepare('SELECT taps FROM scores WHERE account_id=?').bind(account.id).first(),
        ]);
        const stored = JSON.parse(row.save_json);
        const save = sanitizeSave(stored, { ...economy, totalTaps: score?.taps || stored.totalTaps }, stored, account.username);
        return json({ revision: row.revision || 0, save, updatedAt: row.updated_at || null });
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
