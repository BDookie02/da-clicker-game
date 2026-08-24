// DISCIPLINE account API — Cloudflare Worker + D1.
// The Discipline account is platform-neutral: Android and iOS use the same
// login, save, inventory, leaderboard identity, and verified purchase ledger.

import { validateUsername } from './username-policy.js';
import { deletionPage, legalConfig, privacyPage, termsPage } from './legal-pages.js';
import {
  handleMultiplayerRoute,
  handleQuickDrawSocket,
  pvpForfeitIntentStatement,
  settlePvPAccountDeparture,
  settlePvPForfeit,
} from './multiplayer.js';
export { QuickDrawRoom } from './quick-draw-room.js';
import { TERMS_VERSION } from './constants.js';
import {
  PlatformProofError,
  GOOGLE_PLAY_ATTRIBUTION_VERSION,
  GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
  parseReferralClaim,
  verifyReferralClaim,
} from './platform-attestation.js';

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

async function quickDrawReadiness(env) {
  if (!env.QUICK_DRAW_ROOMS) return json({ ready: false }, 503);
  try {
    const response = await env.QUICK_DRAW_ROOMS.getByName('release-readiness-v1').fetch(
      new Request('https://quick-draw.internal/health'),
    );
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.ready === true
      ? json({ ready: true }) : json({ ready: false }, 503);
  } catch {
    return json({ ready: false }, 503);
  }
}
const PASSWORD_MIN = 10;
// Cloudflare Workers Web Crypto rejects PBKDF2 iteration counts above 100,000.
// Keep this at the platform maximum so production registration/login works.
const PBKDF2_ITERATIONS = 100000;
const SESSION_SECONDS = 60 * 60 * 24 * 90;
const REPORT_REASONS = Object.freeze(['username', 'cheating', 'harassment', 'other']);
const REPORT_STATUSES = Object.freeze(['open', 'reviewing', 'actioned', 'dismissed']);
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
  orn_napkin: [50, 'ornament'],
  goop_gold: [200, 'goop'], goop_slime: [200, 'goop'], sky_sunset: [125, 'sky'], sky_vapor: [125, 'sky'],
  horn_sad: [150, 'horn'], orn_cowboy: [175, 'ornament'],
  goop_pink: [225, 'goop'], goop_blue: [225, 'goop'], goop_oil: [300, 'goop'],
  sky_storm: [150, 'sky'], sky_noir: [150, 'sky'], sky_toxic: [150, 'sky'], sky_mint: [150, 'sky'],
  orn_cone: [125, 'ornament'], orn_monk: [225, 'ornament'], horn_air: [175, 'horn'],
  dangle_dice: [90, 'dangler'], dangle_beads: [110, 'dangler'], dangle_yinyang: [140, 'dangler'],
  dangle_fire: [175, 'dangler'], dangle_censored: [225, 'dangler'], dangle_testing_coals: [200, 'dangler'],
  dangle_goop: [250, 'dangler'], roof_taxi: [175, 'roof'],
});
const REFERRAL_REWARD_LIMIT = 10;
const REFERRAL_REWARD_IDS = Object.freeze(Object.keys(COSMETICS));
const REFERRAL_CLAIM_RATE_LIMITS = Object.freeze({
  account: 6,
  ip: 60,
  codeIp: 12,
  registerIp: 20,
  windowSeconds: 60 * 60,
});
const REFERRAL_RATE_LIMIT_TEST_HOOK = Symbol.for(
  'discipline.test.referralRateLimits',
);
const ANDROID_PACKAGE_NAME = 'com.nosiah.discipline';
const ANDROID_PUBLISHER_ROOT = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE_NAME}`;
const FINAL_REVERSED_FINANCIAL_STATUSES = Object.freeze([
  'canceled', 'partially_refunded', 'refunded', 'revoked',
]);
let admobKeyCache = { expiresAt: 0, keys: new Map() };
const ADMOB_CALLBACK_TESTER = Object.freeze({
  adNetwork: '5450213213286189855',
  adUnit: '1234567890',
  transactionId: '123456789',
});

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
export function isAdmobCallbackTester(params, now = Date.now()) {
  const timestamp = Number(params.get('timestamp'));
  return params.get('ad_network') === ADMOB_CALLBACK_TESTER.adNetwork
    && params.get('ad_unit') === ADMOB_CALLBACK_TESTER.adUnit
    && params.get('transaction_id') === ADMOB_CALLBACK_TESTER.transactionId
    && Number(params.get('reward_amount')) === ADMOB_REWARD_AMOUNT
    && params.get('reward_item') === ADMOB_REWARD_ITEM
    && Number.isFinite(timestamp)
    && Math.abs(now - timestamp) <= 5 * 60 * 1000;
}
export function parseAdmobSignedQuery(rawQuery) {
  if (typeof rawQuery !== 'string') return null;
  const signatureMarker = '&signature=';
  const keyMarker = '&key_id=';
  const signatureAt = rawQuery.indexOf(signatureMarker);
  if (signatureAt < 1 || signatureAt !== rawQuery.lastIndexOf(signatureMarker)) return null;
  const keyAt = rawQuery.indexOf(keyMarker, signatureAt + signatureMarker.length);
  if (keyAt < 0 || keyAt !== rawQuery.lastIndexOf(keyMarker)) return null;
  const signature = rawQuery.slice(signatureAt + signatureMarker.length, keyAt);
  const keyId = rawQuery.slice(keyAt + keyMarker.length);
  if (!signature || !/^\d+$/.test(keyId)) return null;

  const params = new URLSearchParams(rawQuery);
  const requiredOnce = [
    'ad_network', 'ad_unit', 'reward_amount', 'reward_item',
    'timestamp', 'transaction_id', 'signature', 'key_id',
  ];
  const optionalAtMostOnce = ['custom_data', 'user_id'];
  if (requiredOnce.some((name) => params.getAll(name).length !== 1)
      || optionalAtMostOnce.some((name) => params.getAll(name).length > 1)) return null;
  return {
    signedContent: rawQuery.slice(0, signatureAt),
    signature,
    keyId,
    params,
  };
}
async function verifyAdmobCallback(req, env) {
  const queryAt = req.url.indexOf('?');
  const parsed = parseAdmobSignedQuery(queryAt < 0 ? '' : req.url.slice(queryAt + 1));
  if (!parsed) return json({ ok: false, error: 'invalid_admob_callback' }, 400);
  const { signedContent, signature, keyId, params } = parsed;
  const key = (await admobKeys()).get(keyId);
  if (!key) {
    console.warn('admob_callback_rejected', 'missing_signature_or_key');
    return json({ ok: false, error: 'invalid_admob_signature' }, 400);
  }
  let valid = false;
  try {
    const signatureBytes = base64urlBytes(signature);
    const rawSignatureBytes = derEcdsaToRaw(signatureBytes);
    const signedBytes = new TextEncoder().encode(signedContent);
    const decodedSignedBytes = new TextEncoder().encode(decodeURIComponent(signedContent));
    // Google documents its AdMob signature as ASN.1 DER. Standards-compliant
    // Web Crypto uses IEEE-P1363, while some Workers runtime versions accept
    // DER directly, so support both representations without changing content.
    const validDer = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, signedBytes,
    );
    const validRaw = validDer || await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, rawSignatureBytes, signedBytes,
    );
    // Google's reference verifier uses java.net.URI#getQuery(), which
    // percent-decodes custom_data before verification. Check that documented
    // representation too; the signature still authenticates every parameter.
    const validDecodedDer = validRaw || await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, decodedSignedBytes,
    );
    valid = validDecodedDer || await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, rawSignatureBytes, decodedSignedBytes,
    );
  } catch {
    console.warn('admob_callback_rejected', 'malformed_signature');
    return json({ ok: false, error: 'invalid_admob_signature' }, 400);
  }
  if (!valid) {
    console.warn('admob_callback_rejected', 'invalid_signature');
    return json({ ok: false, error: 'invalid_admob_signature' }, 400);
  }

  // AdMob's console verifier signs fixed sentinel IDs rather than the real ad
  // unit. Acknowledge that exact, fresh payload only after signature
  // verification, and never write it to the reward ledger.
  if (isAdmobCallbackTester(params)) return json({ ok: true, test: true });
  if (params.get('ad_unit') === ADMOB_CALLBACK_TESTER.adUnit)
    console.warn('admob_callback_rejected', 'invalid_callback_tester_payload');

  const expectedAdUnit = String(env.ADMOB_REWARDED_AD_UNIT_ID || '6776690128');
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

async function adRewardStatus(url, env, account) {
  const nonce = url.searchParams.get('nonce') || '';
  const kind = url.searchParams.get('kind') || '';
  if (!/^[0-9a-f-]{36}$/i.test(nonce) || !['m', 'boost', 'offline'].includes(kind))
    return json({ ok: false, error: 'invalid_ad_reward_status' }, 400);
  const reward = await env.DB.prepare(`SELECT transaction_id,rewarded_at FROM ad_rewards
    WHERE account_id=? AND nonce=? AND kind=?`).bind(account.id, nonce, kind).first();
  if (!reward) return json({ ok: true, verified: false, nonce, kind });
  return json({
    ok: true,
    verified: true,
    nonce,
    kind,
    transactionId: reward.transaction_id,
    rewardedAt: reward.rewarded_at,
  });
}
async function passwordHash(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: hexToBytes(saltHex),
    iterations: PBKDF2_ITERATIONS,
  }, key, 256);
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

const ACCOUNT_MUTATION_LEASE_STALE_MS = 15 * 60 * 1000;

async function acquireAccountMutationLease(env, accountId) {
  const now = Date.now();
  const requestId = randomHex(16);
  // A Worker request cannot legitimately remain live for fifteen minutes.
  // Deletion ignores an older crash remnant; normal requests do not issue a
  // cleanup write because request ids are unique and account deletion removes
  // every remaining row explicitly.
  const result = await env.DB.prepare(`INSERT INTO account_mutation_leases(
      request_id,account_id,acquired_at_ms
    ) SELECT ?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM account_deletion_jobs WHERE account_id=?)`)
    .bind(requestId, accountId, now, accountId).run();
  return Number(result?.meta?.changes || 0) === 1 ? requestId : null;
}

async function accountDeletionPending(env, accountId) {
  return Boolean(await env.DB.prepare(
    'SELECT account_id FROM account_deletion_jobs WHERE account_id=?',
  ).bind(accountId).first());
}

async function releaseAccountMutationLease(env, requestId, accountId) {
  await env.DB.prepare(`DELETE FROM account_mutation_leases
    WHERE request_id=? AND account_id=?`).bind(requestId, accountId).run();
}

const AUTHENTICATED_MUTATION_LEASE_ROUTES = new Set([
  'GET /v1/referral',
  'POST /v1/referral/claim',
  'PUT /v1/account/username',
  'PUT /v1/account/terms',
  'POST /v1/reports',
  'POST /v1/blocks',
  'PUT /v1/save',
  'POST /v1/purchases/android/verify',
  'POST /v1/purchases/ios/verify',
]);

function authenticatedMultiplayerRouteKind(method, pathname) {
  if (method === 'GET' && pathname === '/v1/multiplayer') return 'read';
  if (method === 'POST' && [
    '/v1/friends/request', '/v1/friends/respond', '/v1/pvp/invite',
  ].includes(pathname)) return 'leased_mutation';
  if (method === 'DELETE' && /^\/v1\/friends\/[^/]+$/.test(pathname))
    return 'leased_mutation';
  if (method !== 'POST') return null;
  if (/^\/v1\/pvp\/[0-9a-f]{32}\/quick-draw\/ticket$/.test(pathname))
    return 'leased_mutation';
  if (/^\/v1\/pvp\/[0-9a-f]{32}\/tap$/.test(pathname)) return 'guarded_tap';
  if (/^\/v1\/pvp\/[0-9a-f]{32}\/(?:respond|draw|cancel)$/.test(pathname))
    return 'leased_mutation';
  return null;
}

function authenticatedMutationNeedsLease(method, pathname) {
  const route = `${method} ${pathname}`;
  if (AUTHENTICATED_MUTATION_LEASE_ROUTES.has(route)) return true;
  if (method === 'DELETE' && /^\/v1\/blocks\/[^/]+$/.test(pathname)) return true;
  const multiplayerKind = authenticatedMultiplayerRouteKind(method, pathname);
  // Tap snapshots are deliberately lease-exempt: both of their D1 writes use
  // activeMatchEligibilitySql(), which atomically rejects either player's
  // deletion job. Avoiding two lease writes per snapshot is safe and keeps a
  // modified client from using the serialization primitive as a quota DoS.
  return multiplayerKind === 'leased_mutation';
}

const PVP_TAP_BURST_INTERVAL_MS = 250;
const PVP_TAP_BURST_MAX_KEYS = 2048;
const pvpTapBurstByAccountMatch = new Map();

function pvpTapBurstRetryAfter(accountId, pathname, now = Date.now()) {
  const match = pathname.match(/^\/v1\/pvp\/([0-9a-f]{32})\/tap$/);
  if (!match) return 0;
  const key = `${accountId}:${match[1]}`;
  const prior = Number(pvpTapBurstByAccountMatch.get(key) || 0);
  if (prior && now - prior < PVP_TAP_BURST_INTERVAL_MS)
    return PVP_TAP_BURST_INTERVAL_MS - (now - prior);
  pvpTapBurstByAccountMatch.set(key, now);
  if (pvpTapBurstByAccountMatch.size > PVP_TAP_BURST_MAX_KEYS) {
    const staleBefore = now - 60_000;
    for (const [candidate, seenAt] of pvpTapBurstByAccountMatch) {
      if (Number(seenAt) < staleBefore) pvpTapBurstByAccountMatch.delete(candidate);
    }
    while (pvpTapBurstByAccountMatch.size > PVP_TAP_BURST_MAX_KEYS)
      pvpTapBurstByAccountMatch.delete(pvpTapBurstByAccountMatch.keys().next().value);
  }
  return 0;
}

async function ensureAccountProfile(env, accountId) {
  let profile = await env.DB.prepare(`SELECT account_id,public_id,terms_version,terms_accepted_at,leaderboard_status
    FROM account_profiles WHERE account_id=?`).bind(accountId).first();
  if (profile) return profile;
  // A public reference is deliberately opaque: the client can identify a
  // leaderboard row for report/block actions without receiving a database id.
  for (let attempt = 0; attempt < 3 && !profile; attempt++) {
    await env.DB.prepare(`INSERT OR IGNORE INTO account_profiles(account_id,public_id)
      SELECT ?,? WHERE NOT EXISTS (
        SELECT 1 FROM account_deletion_jobs WHERE account_id=?
      )`).bind(accountId, randomHex(16), accountId).run();
    profile = await env.DB.prepare(`SELECT account_id,public_id,terms_version,terms_accepted_at,leaderboard_status
      FROM account_profiles WHERE account_id=?`).bind(accountId).first();
  }
  if (!profile && await accountDeletionPending(env, accountId))
    throw new Error('account_deletion_pending');
  if (!profile) throw new Error('profile_unavailable');
  return profile;
}
const hasCurrentTerms = (profile) => profile?.terms_version === TERMS_VERSION;
const accountJson = (row, profile) => ({
  id: String(row.id),
  username: row.username,
  termsVersion: profile?.terms_version || null,
  termsCurrent: hasCurrentTerms(profile),
});
const legalJson = (env) => ({
  ready: legalConfig(env).ready,
  termsVersion: TERMS_VERSION,
  termsPath: '/terms',
  privacyPath: '/privacy',
});

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
  const referralRewardIds = knownList(authority.referralRewardIds, COSMETICS);
  const priorOwned = knownList(previous?.ownedCosmetics, COSMETICS);
  const requestedOwned = knownList(value.ownedCosmetics, COSMETICS);
  const ownedCosmetics = [...new Set([...priorOwned, ...requestedOwned, ...referralRewardIds])];
  const priorLabs = knownList(previous?.labOwned, LAB_COSTS);
  const requestedLabs = knownList(value.labOwned, LAB_COSTS);
  const labOwned = [...new Set([...priorLabs, ...requestedLabs])];
  const premiumSpent = ownedCosmetics.reduce((sum, id) => sum + (referralRewardIds.includes(id) ? 0 : COSMETICS[id][0]), 0)
    + labOwned.reduce((sum, id) => sum + LAB_COSTS[id], 0);
  const priorPremiumSpent = priorOwned.reduce((sum, id) => sum + (referralRewardIds.includes(id) ? 0 : COSMETICS[id][0]), 0)
    + priorLabs.reduce((sum, id) => sum + LAB_COSTS[id], 0);
  const earnedMentality = integer(authority.earnedMentality, 0, MAX_SAFE);
  if (premiumSpent > earnedMentality) {
    const addsUnverifiedItem = requestedOwned.some((id) =>
      !priorOwned.includes(id) && !referralRewardIds.includes(id))
      || requestedLabs.some((id) => !priorLabs.includes(id));
    // A refunded currency pack can place an existing account in premium debt.
    // Preserve already-owned items, but grant no balance and reject every new
    // premium item until verified earnings cover the prior spend again.
    if (!previous || addsUnverifiedItem || premiumSpent > priorPremiumSpent)
      throw new Error('unverified_premium_spend');
  }

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
    mentality: Math.max(0, earnedMentality - premiumSpent),
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
    appliedAdRewards: [...new Set([
      ...(Array.isArray(previous?.appliedAdRewards) ? previous.appliedAdRewards : []),
      ...(Array.isArray(value.appliedAdRewards) ? value.appliedAdRewards : []),
    ].filter((nonce) => (authority.rewardNonces || []).includes(nonce)))].slice(-500),
    textSizeTier: integer(value.textSizeTier, 0, 3),
    tutorialComplete: Boolean(value.tutorialComplete),
  };
}

async function economyAuthority(env, accountId) {
  const [purchases, ads, ids, rewardNonces, referralRewards, pvpRewards] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(CASE
      WHEN p.platform='ios' OR pc.consumed_at IS NOT NULL THEN p.mentality_amount ELSE 0 END),0) AS amount
      FROM purchases p LEFT JOIN purchase_consumptions pc
      ON pc.platform=p.platform AND pc.transaction_id=p.transaction_id
      LEFT JOIN purchase_financials pf
      ON pf.platform=p.platform AND pf.transaction_id=p.transaction_id
      WHERE p.account_id=? AND pf.revoked_at IS NULL
      AND COALESCE(pf.financial_status,'unavailable')
        NOT IN ('canceled','pending_refund','partially_refunded','refunded','revoked')`).bind(accountId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN kind='m' THEN 1 ELSE 0 END),0) AS m_count FROM ad_rewards WHERE account_id=?`).bind(accountId).first(),
    env.DB.prepare(`SELECT p.transaction_id FROM purchases p LEFT JOIN purchase_consumptions pc
      ON pc.platform=p.platform AND pc.transaction_id=p.transaction_id
      LEFT JOIN purchase_financials pf
      ON pf.platform=p.platform AND pf.transaction_id=p.transaction_id
      WHERE p.account_id=? AND (p.platform='ios' OR pc.consumed_at IS NOT NULL)
      AND pf.revoked_at IS NULL
      AND COALESCE(pf.financial_status,'unavailable')
        NOT IN ('canceled','pending_refund','partially_refunded','refunded','revoked')
      ORDER BY p.verified_at ASC`).bind(accountId).all(),
    env.DB.prepare('SELECT nonce FROM ad_rewards WHERE account_id=? ORDER BY verified_at ASC').bind(accountId).all(),
    env.DB.prepare('SELECT cosmetic_id FROM referral_reward_ledger WHERE referrer_account_id=? ORDER BY reward_index ASC')
      .bind(accountId).all(),
    env.DB.prepare('SELECT COALESCE(SUM(mentality_amount),0) AS amount FROM pvp_rewards WHERE winner_account_id=?')
      .bind(accountId).first(),
  ]);
  return {
    earnedMentality: integer(purchases?.amount, 0, MAX_SAFE)
      + integer(ads?.m_count, 0, MAX_SAFE) * AD_M_REWARD
      + integer(pvpRewards?.amount, 0, MAX_SAFE),
    adCount: integer(ads?.count, 0, MAX_SAFE),
    purchaseIds: (ids?.results || []).map((row) => String(row.transaction_id)),
    rewardNonces: (rewardNonces?.results || []).map((row) => String(row.nonce)),
    referralRewardIds: (referralRewards?.results || []).map((row) => String(row.cosmetic_id)),
  };
}

export function selectReferralRewardId(ownedIds, randomValue) {
  const owned = new Set(knownList(ownedIds, COSMETICS));
  const available = REFERRAL_REWARD_IDS.filter((id) => !owned.has(id));
  if (!available.length) return null;
  const normalized = (Number(randomValue) >>> 0) / 0x1_0000_0000;
  return available[Math.min(available.length - 1, Math.floor(normalized * available.length))];
}

function randomUint32() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

async function referralRewardState(env, accountId) {
  const [rewards, saveRow] = await Promise.all([
    env.DB.prepare(`SELECT cosmetic_id,reward_index FROM referral_reward_ledger
      WHERE referrer_account_id=? ORDER BY reward_index ASC`).bind(accountId).all(),
    env.DB.prepare('SELECT save_json FROM cloud_saves WHERE account_id=?').bind(accountId).first(),
  ]);
  let saveOwned = [];
  try { saveOwned = JSON.parse(String(saveRow?.save_json || '{}')).ownedCosmetics || []; }
  catch { /* invalid stored save is ignored; server sanitization handles it separately */ }
  const rewardIds = (rewards?.results || []).map((row) => String(row.cosmetic_id));
  return {
    rewardIds,
    ownedIds: [...new Set([...knownList(saveOwned, COSMETICS), ...rewardIds])],
  };
}

const LEGACY_ANDROID_REFERRAL_EVIDENCE_VERSION = 'referral_evidence_v1';
const PROVIDER_REFERRAL_EVIDENCE_VERSION = 'referral_evidence_v2';
const REFERRAL_EVIDENCE_KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const REFERRAL_EVIDENCE_KEY_CHECK_CONTEXT = 'discipline_referral_key_check_v1';

function canonicalReferralEvidence(claim) {
  // This exact Android v1 serialization is permanent. Tombstones created
  // before the provider-neutral boundary contain only its HMAC; changing even
  // one byte would make deleted installs replayable.
  if (claim.attributionProvider === GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER
      && claim.attributionVersion === GOOGLE_PLAY_ATTRIBUTION_VERSION) return [
    LEGACY_ANDROID_REFERRAL_EVIDENCE_VERSION,
    `platform=${encodeURIComponent(String(claim.platform))}`,
    `referral_code=${encodeURIComponent(String(claim.referralCode))}`,
    `click_timestamp=${String(claim.firstTouchAt)}`,
    `install_timestamp=${String(claim.installedAt)}`,
  ].join('\n');
  return [
    PROVIDER_REFERRAL_EVIDENCE_VERSION,
    `platform=${encodeURIComponent(String(claim.platform))}`,
    `attribution_provider=${encodeURIComponent(String(claim.attributionProvider))}`,
    `attribution_version=${encodeURIComponent(String(claim.attributionVersion))}`,
    `referral_code=${encodeURIComponent(String(claim.referralCode))}`,
    `evidence_id=${encodeURIComponent(String(claim.evidenceId))}`,
  ].join('\n');
}

function normalizedEvidenceClaim(claimOrPlatform, code, clickTimestamp, installTimestamp) {
  // The positional form is retained for tests and staged Android rollout
  // compatibility. New core code supplies a provider-normalized claim.
  return typeof claimOrPlatform === 'object' && claimOrPlatform !== null
    ? claimOrPlatform
    : {
        platform: claimOrPlatform,
        attributionProvider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
        attributionVersion: GOOGLE_PLAY_ATTRIBUTION_VERSION,
        referralCode: code,
        evidenceId: `${clickTimestamp}:${installTimestamp}`,
        firstTouchAt: clickTimestamp,
        installedAt: installTimestamp,
      };
}

export function referralEvidenceKeyRing(env) {
  let parsed;
  try { parsed = JSON.parse(String(env?.REFERRAL_EVIDENCE_HMAC_KEYRING_JSON || '')); }
  catch { throw new Error('referral_evidence_not_configured'); }
  const current = String(parsed?.current || '');
  const rawKeys = parsed?.keys;
  if (!REFERRAL_EVIDENCE_KEY_ID.test(current) || !rawKeys || Array.isArray(rawKeys)
      || typeof rawKeys !== 'object')
    throw new Error('referral_evidence_not_configured');
  const entries = Object.entries(rawKeys).map(([id, secret]) => ({
    id: String(id), secret: String(secret || ''),
  }));
  if (!entries.length || entries.length > 16
      || entries.some(({ id, secret }) => !REFERRAL_EVIDENCE_KEY_ID.test(id) || secret.length < 32)
      || !entries.some(({ id }) => id === current))
    throw new Error('referral_evidence_not_configured');
  return Object.freeze({
    current,
    keys: Object.freeze([
      entries.find(({ id }) => id === current),
      ...entries.filter(({ id }) => id !== current).sort((a, b) => a.id.localeCompare(b.id)),
    ]),
  });
}

async function referralEvidenceHmac(secret, canonical) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(canonical),
  );
  return base64url(new Uint8Array(signature));
}

async function ensureReferralEvidenceKeyRing(env) {
  const ring = referralEvidenceKeyRing(env);
  const replayPepper = String(env?.REFERRAL_EVIDENCE_REPLAY_PEPPER || '');
  if (replayPepper.length < 32) throw new Error('referral_evidence_not_configured');
  const records = [{
    id: 'replay-pepper-v1',
    verificationTag: await referralEvidenceHmac(
      replayPepper, REFERRAL_EVIDENCE_KEY_CHECK_CONTEXT,
    ),
    legacyUnversioned: 1,
  }];
  await env.DB.prepare(`INSERT OR IGNORE INTO referral_evidence_key_registry(
      key_id,verification_tag,legacy_unversioned
    ) SELECT json_extract(value,'$.id'),json_extract(value,'$.verificationTag'),
        json_extract(value,'$.legacyUnversioned')
      FROM json_each(?)`).bind(JSON.stringify(records)).run();
  const registered = await env.DB.prepare(`SELECT key_id,verification_tag,legacy_unversioned
    FROM referral_evidence_key_registry`).all();
  const registeredPepper = (registered?.results || [])
    .find(row => String(row.key_id) === 'replay-pepper-v1');
  if (!registeredPepper
      || records[0].verificationTag !== String(registeredPepper.verification_tag)
      || Number(registeredPepper.legacy_unversioned) !== 1)
    throw new Error('referral_evidence_not_configured');
  return ring;
}

async function referralReadiness(env) {
  try {
    // This deliberately exercises both secret parsing and the permanent
    // replay-pepper registry. A deploy must not reopen the API merely because
    // the expected secret *names* exist while their values are malformed or
    // the lifetime replay pepper no longer matches its registered tag.
    await ensureReferralEvidenceKeyRing(env);
    // Exercise the live 0017 table and every column used by the throttler.
    // This keeps a partially applied migration from passing the pre-open
    // readiness smoke and then failing registration/referral traffic.
    await env.DB.prepare(`SELECT bucket,subject_hash,window_started_at,request_count
      FROM request_rate_limits LIMIT 1`).all();
    return json({ ready: true });
  } catch {
    return json({ ready: false }, 503);
  }
}

function referralRateLimits(env) {
  const test = env?.[REFERRAL_RATE_LIMIT_TEST_HOOK];
  const result = { ...REFERRAL_CLAIM_RATE_LIMITS };
  if (test && typeof test === 'object') {
    for (const key of Object.keys(result)) {
      const value = Number(test[key]);
      if (Number.isSafeInteger(value) && value > 0) result[key] = value;
    }
  }
  return result;
}

function connectingIp(req) {
  const value = String(req.headers.get('CF-Connecting-IP') || '').trim();
  return value.length >= 3 && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value)
    ? value.toLowerCase() : '';
}

async function rateLimitSubject(env, bucket, value) {
  const pepper = String(env?.REFERRAL_EVIDENCE_REPLAY_PEPPER || '');
  if (pepper.length < 32) throw new Error('rate_limit_not_configured');
  return referralEvidenceHmac(
    pepper,
    `discipline_rate_limit_v1\nbucket=${bucket}\nsubject=${encodeURIComponent(String(value))}`,
  );
}

async function pruneRequestRateLimits(env, nowSeconds) {
  await env.DB.prepare(`DELETE FROM request_rate_limits
    WHERE window_started_at<?`).bind(nowSeconds - 24 * 60 * 60).run();
}

async function consumeRateLimit(
  env, bucket, rawSubject, limit, windowSeconds, nowSeconds,
) {
  const subjectHash = await rateLimitSubject(env, bucket, rawSubject);
  const resetBefore = nowSeconds - windowSeconds;
  const row = await env.DB.prepare(`INSERT INTO request_rate_limits(
      bucket,subject_hash,window_started_at,request_count
    ) VALUES(?,?,?,1)
    ON CONFLICT(bucket,subject_hash) DO UPDATE SET
      window_started_at=CASE
        WHEN request_rate_limits.window_started_at<=?
        THEN excluded.window_started_at ELSE request_rate_limits.window_started_at END,
      request_count=CASE
        WHEN request_rate_limits.window_started_at<=?
        THEN 1 ELSE request_rate_limits.request_count+1 END
    RETURNING request_count`).bind(
    bucket, subjectHash, nowSeconds, resetBefore, resetBefore,
  ).first();
  if (!row) throw new Error('rate_limit_unavailable');
  return Number(row.request_count) <= limit;
}

async function referralClaimRateLimitAllowed(req, env, accountId, referralCode, nowSeconds) {
  const limits = referralRateLimits(env);
  await pruneRequestRateLimits(env, nowSeconds);
  if (!await consumeRateLimit(
    env, 'referral-account-v1', accountId,
    limits.account, limits.windowSeconds, nowSeconds,
  )) return false;
  const ip = connectingIp(req);
  if (!ip) return true;
  if (!await consumeRateLimit(
    env, 'referral-ip-v1', ip,
    limits.ip, limits.windowSeconds, nowSeconds,
  )) return false;
  // A referral code is public and may legitimately go viral. Scope its abuse
  // bucket to the source IP so one attacker cannot exhaust a shared global
  // quota and suppress every legitimate install using that code.
  return consumeRateLimit(
    env, 'referral-code-ip-v1', `${referralCode}\n${ip}`,
    limits.codeIp, limits.windowSeconds, nowSeconds,
  );
}

async function registrationRateLimitAllowed(req, env, nowSeconds) {
  const ip = connectingIp(req);
  if (!ip) return true;
  await ensureReferralEvidenceKeyRing(env);
  await pruneRequestRateLimits(env, nowSeconds);
  const limits = referralRateLimits(env);
  return consumeRateLimit(
    env, 'registration-ip-v1', ip,
    limits.registerIp, limits.windowSeconds, nowSeconds,
  );
}

export async function referralEvidenceKeys(
  env, claimOrPlatform, code, clickTimestamp, installTimestamp,
) {
  const claim = normalizedEvidenceClaim(
    claimOrPlatform, code, clickTimestamp, installTimestamp,
  );
  const ring = referralEvidenceKeyRing(env);
  const replayPepper = String(env?.REFERRAL_EVIDENCE_REPLAY_PEPPER || '');
  if (replayPepper.length < 32) throw new Error('referral_evidence_not_configured');
  const canonical = canonicalReferralEvidence(claim);
  const version = claim.attributionProvider === GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER
      && claim.attributionVersion === GOOGLE_PLAY_ATTRIBUTION_VERSION ? 'h1' : 'h2';
  const signatures = await Promise.all(ring.keys.map(async ({ id, secret }) => ({
    id, signature: await referralEvidenceHmac(secret, canonical),
  })));
  const replaySignature = await referralEvidenceHmac(replayPepper, canonical);
  // The first key is always the current, versioned write key. Retained active
  // keys produce versioned candidates; the permanent pepper alone produces
  // the stable replay fingerprint and exact historical unversioned Android
  // candidate, so active-key rotation cannot reopen replay.
  return [
    ...signatures.map(({ id, signature }) => `${version}k_${id}_${signature}`),
    `p${version.slice(1)}_${replaySignature}`,
    // The permanent replay pepper must initially equal the pre-keyring Worker
    // secret. This exact candidate preserves every historical Android v1
    // tombstone while active signing keys may rotate or be retired safely.
    ...(version === 'h1' ? [`h1_${replaySignature}`] : []),
  ];
}

export async function referralEvidenceKey(
  env, claimOrPlatform, code, clickTimestamp, installTimestamp,
) {
  return (await referralEvidenceKeys(
    env, claimOrPlatform, code, clickTimestamp, installTimestamp,
  ))[0];
}

const REFERRAL_DELETION_PAGE_SIZE = 8;

async function continueReferralDeletion(env, accountId) {
  const leaseCutoff = Date.now() - ACCOUNT_MUTATION_LEASE_STALE_MS;
  await env.DB.prepare(`INSERT OR IGNORE INTO account_deletion_jobs(account_id)
    SELECT ? WHERE NOT EXISTS (
      SELECT 1 FROM account_mutation_leases
      WHERE account_id=? AND acquired_at_ms>=?
    )`).bind(accountId, accountId, leaseCutoff).run();
  const job = await env.DB.prepare(`SELECT referral_cursor FROM account_deletion_jobs
    WHERE account_id=?`).bind(accountId).first();
  if (!job) throw new Error('account_deletion_job_unavailable');
  const claims = await env.DB.prepare(`SELECT
      rc.referred_account_id,rc.platform,rc.referral_code,rc.click_timestamp,rc.install_timestamp,
      rc.attribution_provider,rc.attribution_version,cl.evidence_key
    FROM referral_claims rc
    LEFT JOIN referral_claim_ledger cl
      ON cl.referred_account_id=rc.referred_account_id
    WHERE (rc.referred_account_id=? OR rc.referrer_account_id=?)
      AND rc.referred_account_id>?
    ORDER BY rc.referred_account_id ASC LIMIT ?`)
    .bind(
      accountId, accountId, Number(job.referral_cursor), REFERRAL_DELETION_PAGE_SIZE,
    ).all();
  const rows = claims?.results || [];
  if (!rows.length) return null;
  await ensureReferralEvidenceKeyRing(env);
  const tombstones = new Set();
  for (const row of rows) {
    const platform = String(row.platform || '');
    const referralCode = String(row.referral_code || '');
    const clickTimestamp = Number(row.click_timestamp);
    const installTimestamp = Number(row.install_timestamp);
    const attributionProvider = String(row.attribution_provider || 'legacy');
    const attributionVersion = String(row.attribution_version || 'legacy');
    // Claims predating provider metadata used the same v1 canonical fields as
    // Android. Current Android claims use that serialization permanently too.
    // Any future provider must add its own deterministic deletion derivation
    // here before claims from that provider may be deleted.
    if (platform !== 'android'
        || !/^[A-F0-9]{10}$/.test(referralCode)
        || !Number.isSafeInteger(clickTimestamp) || clickTimestamp <= 0
        || !Number.isSafeInteger(installTimestamp) || installTimestamp <= 0
        || (attributionProvider !== 'legacy'
          && (attributionProvider !== GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER
            || attributionVersion !== GOOGLE_PLAY_ATTRIBUTION_VERSION)))
      throw new Error('unsupported_referral_tombstone_provider');
    const derived = await referralEvidenceKeys(
      env, platform, referralCode, clickTimestamp, installTimestamp,
    );
    for (const key of derived) tombstones.add(key);
  }
  const nextCursor = Number(rows.at(-1).referred_account_id);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO referral_evidence_fingerprints(evidence_hash)
      SELECT CAST(value AS TEXT) FROM json_each(?)`).bind(JSON.stringify([...tombstones])),
    env.DB.prepare(`UPDATE account_deletion_jobs
      SET referral_cursor=?,updated_at=datetime('now')
      WHERE account_id=? AND referral_cursor=?`).bind(
      nextCursor, accountId, Number(job.referral_cursor),
    ),
  ]);
  if (Number(results?.[1]?.meta?.changes || 0) === 1) return String(nextCursor);
  // A concurrent deletion request may have advanced the same job. Return the
  // durable cursor so clients can detect progress (or fail a stuck loop)
  // instead of blindly hammering this endpoint.
  const current = await env.DB.prepare(`SELECT referral_cursor FROM account_deletion_jobs
    WHERE account_id=?`).bind(accountId).first();
  if (!current) throw new Error('account_deletion_job_unavailable');
  return String(current.referral_cursor);
}

function referralRewardStatement(env, evidenceKey, referrerAccountId) {
  const candidates = REFERRAL_REWARD_IDS.map(() => '(?)').join(',');
  return env.DB.prepare(`WITH candidates(cosmetic_id) AS (VALUES ${candidates}),
      next_reward(reward_index) AS (
        SELECT COALESCE(MAX(reward_index),0)+1 FROM referral_reward_ledger
        WHERE referrer_account_id=?
      ),
      save_owned(cosmetic_id) AS (
        SELECT CAST(j.value AS TEXT)
        FROM cloud_saves s,json_each(
          CASE WHEN json_valid(s.save_json) THEN s.save_json ELSE '{"ownedCosmetics":[]}' END,
          '$.ownedCosmetics'
        ) j WHERE s.account_id=?
      )
    INSERT INTO referral_reward_ledger(
      evidence_key,referrer_account_id,reward_index,cosmetic_id
    )
    SELECT ?,?,n.reward_index,c.cosmetic_id
    FROM candidates c CROSS JOIN next_reward n
    WHERE n.reward_index<=?
      AND NOT EXISTS (SELECT 1 FROM save_owned s WHERE s.cosmetic_id=c.cosmetic_id)
      AND NOT EXISTS (SELECT 1 FROM referral_reward_ledger r
        WHERE r.referrer_account_id=? AND r.cosmetic_id=c.cosmetic_id)
    ORDER BY random() LIMIT 1`).bind(
    ...REFERRAL_REWARD_IDS, referrerAccountId, referrerAccountId,
    evidenceKey, referrerAccountId, REFERRAL_REWARD_LIMIT, referrerAccountId,
  );
}

function legacyReferralRewardStatement(env, evidenceKey, referredAccountId) {
  return env.DB.prepare(`INSERT OR IGNORE INTO referral_rewards(
      referred_account_id,referrer_account_id,reward_index,cosmetic_id
    )
    SELECT ?,rr.referrer_account_id,rr.reward_index,rr.cosmetic_id
    FROM referral_reward_ledger rr WHERE rr.evidence_key=?`)
    .bind(referredAccountId, evidenceKey);
}

async function reconcileReferralRewards(env, accountId) {
  const pending = await env.DB.prepare(`SELECT rc.evidence_key
    FROM referral_claim_ledger rc
    LEFT JOIN referral_reward_ledger rr ON rr.evidence_key=rc.evidence_key
    WHERE rc.referrer_account_id=? AND rr.evidence_key IS NULL
    ORDER BY rc.claimed_at ASC LIMIT ?`).bind(accountId, REFERRAL_REWARD_LIMIT).all();
  for (const claim of pending?.results || []) {
    try {
      await env.DB.batch([
        referralRewardStatement(env, claim.evidence_key, accountId),
        env.DB.prepare(`INSERT OR IGNORE INTO referral_rewards(
            referred_account_id,referrer_account_id,reward_index,cosmetic_id
          ) SELECT rc.referred_account_id,rr.referrer_account_id,
              rr.reward_index,rr.cosmetic_id
            FROM referral_claim_ledger rc
            JOIN referral_reward_ledger rr ON rr.evidence_key=rc.evidence_key
            WHERE rc.evidence_key=? AND rc.referred_account_id IS NOT NULL`)
          .bind(claim.evidence_key),
      ]);
    } catch { /* another request may have reconciled the same claim */ }
  }
}

async function ensureReferralCode(env, accountId) {
  let row = await env.DB.prepare('SELECT code FROM referral_codes WHERE account_id=?')
    .bind(accountId).first();
  for (let attempt = 0; !row && attempt < 5; attempt++) {
    const code = randomHex(5).toUpperCase();
    await env.DB.prepare('INSERT OR IGNORE INTO referral_codes(account_id,code) VALUES(?,?)')
      .bind(accountId, code).run();
    row = await env.DB.prepare('SELECT code FROM referral_codes WHERE account_id=?')
      .bind(accountId).first();
  }
  if (!row) throw new Error('referral_code_unavailable');
  return String(row.code);
}

function androidReferralDestination(code) {
  const referrer = new URLSearchParams({ discipline_ref: code }).toString();
  return `https://play.google.com/store/apps/details?id=com.nosiah.discipline&referrer=${encodeURIComponent(referrer)}`;
}

function referralBaseUrl(req, env) {
  const configured = String(env?.PUBLIC_REFERRAL_BASE_URL || '').replace(/\/$/, '');
  try {
    const parsed = new URL(configured);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password
        && !parsed.search && !parsed.hash) return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch { /* fall back to the current Worker origin */ }
  return new URL(req.url).origin;
}

async function referralLanding(url, env) {
  let code = '';
  try { code = decodeURIComponent(url.pathname.slice('/r/'.length)).trim().toUpperCase(); }
  catch { /* invalid encoding is rejected below */ }
  if (!/^[A-F0-9]{10}$/.test(code))
    return new Response('Referral link not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
    });
  let referral;
  try {
    referral = await env.DB.prepare(`SELECT rc.account_id FROM referral_codes rc
      WHERE rc.code=? AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs d
        WHERE d.account_id=rc.account_id)`)
      .bind(code).first();
  } catch {
    return new Response('Referral link is temporarily unavailable.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
    });
  }
  if (!referral)
    return new Response('Referral link not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
    });
  const playUrl = androidReferralDestination(code).replace(/&/g, '&amp;');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>DISCIPLINE. referral</title>
<style>body{margin:0;background:#0d0d12;color:#f4f0dc;font:18px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:34rem;margin:1.5rem;padding:2rem;border:2px solid #e8c96a;background:#171721;text-align:center}h1{letter-spacing:.08em}a{display:inline-block;margin:1rem 0;padding:.9rem 1.2rem;background:#e8c96a;color:#111;font-weight:800;text-decoration:none}.code{font-family:monospace;letter-spacing:.16em}</style>
</head><body><main class="card"><h1>DISCIPLINE.</h1><p>You were invited by another player.</p>
<a data-platform="android" href="${playUrl}">Get it for Android</a>
<p>Referral code: <span class="code">${code}</span></p>
<p><small>iPhone support is not available yet. This link will remain the same when it is added.</small></p>
</main></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      ...CORS,
    },
  });
}

async function referralStatus(req, env, account) {
  await reconcileReferralRewards(env, account.id);
  const [code, rewardState, ownClaim] = await Promise.all([
    ensureReferralCode(env, account.id),
    referralRewardState(env, account.id),
    env.DB.prepare('SELECT evidence_key FROM referral_claim_ledger WHERE referred_account_id=?')
      .bind(account.id).first(),
  ]);
  const rewardCount = rewardState.rewardIds.length;
  return json({
    code,
    shareUrl: `${referralBaseUrl(req, env)}/r/${encodeURIComponent(code)}`,
    qualifiedCount: rewardCount,
    rewardCount,
    rewardLimit: REFERRAL_REWARD_LIMIT,
    remaining: Math.max(0, REFERRAL_REWARD_LIMIT - rewardCount),
    rewards: rewardState.rewardIds,
    claimed: Boolean(ownClaim),
  });
}

async function referralClaimState(env, accountId, claim, evidenceKeys) {
  const placeholders = evidenceKeys.map(() => '?').join(',');
  const [referrer, existing, usedEvidence, legacyEvidence, deletingAccount] = await Promise.all([
    env.DB.prepare('SELECT account_id FROM referral_codes WHERE code=?')
      .bind(claim.referralCode).first(),
    env.DB.prepare(`SELECT referrer_account_id,evidence_key FROM referral_claim_ledger
      WHERE referred_account_id=?`).bind(accountId).first(),
    env.DB.prepare(`SELECT evidence_hash FROM referral_evidence_fingerprints
      WHERE evidence_hash IN (${placeholders}) LIMIT 1`).bind(...evidenceKeys).first(),
    env.DB.prepare(`SELECT referred_account_id FROM referral_claims
      WHERE platform=? AND referral_code=? AND click_timestamp=? AND install_timestamp=?
      LIMIT 1`).bind(
      claim.platform, claim.referralCode, claim.firstTouchAt, claim.installedAt,
    ).first(),
    env.DB.prepare('SELECT account_id FROM account_deletion_jobs WHERE account_id=?')
      .bind(accountId).first(),
  ]);
  const deletingReferrer = referrer
    ? await env.DB.prepare('SELECT account_id FROM account_deletion_jobs WHERE account_id=?')
      .bind(referrer.account_id).first()
    : null;
  return { referrer, existing, usedEvidence, legacyEvidence, deletingAccount, deletingReferrer };
}

function referralClaimStateResponse(state, accountId) {
  if (state.deletingAccount)
    return json({ ok: false, error: 'account_deletion_pending' }, 409);
  if (state.existing) {
    if (state.referrer
        && Number(state.existing.referrer_account_id) === Number(state.referrer.account_id))
      return json({ ok: true, alreadyClaimed: true });
    return json({ ok: false, error: 'referral_already_claimed' }, 409);
  }
  if (!state.referrer || state.deletingReferrer)
    return json({ ok: false, error: 'referral_not_found' }, 404);
  if (Number(state.referrer.account_id) === Number(accountId))
    return json({ ok: false, error: 'self_referral' }, 409);
  if (state.usedEvidence || state.legacyEvidence)
    return json({ ok: false, error: 'install_evidence_already_used' }, 409);
  return null;
}

function guardedClaimLedgerStatement(env, accountId, referrerAccountId, claim, evidenceKeys) {
  const placeholders = evidenceKeys.map(() => '?').join(',');
  return env.DB.prepare(`INSERT INTO referral_claim_ledger(
      evidence_key,referred_account_id,referrer_account_id
    )
    SELECT ?,?,rc.account_id FROM referral_codes rc
    WHERE rc.code=? AND rc.account_id=? AND rc.account_id<>?
      AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs
        WHERE account_id IN (?,rc.account_id))
      AND NOT EXISTS (SELECT 1 FROM referral_claim_ledger WHERE referred_account_id=?)
      AND NOT EXISTS (SELECT 1 FROM referral_evidence_fingerprints
        WHERE evidence_hash IN (${placeholders}))
      AND NOT EXISTS (SELECT 1 FROM referral_claims
        WHERE platform=? AND referral_code=? AND click_timestamp=? AND install_timestamp=?)`)
    .bind(
      evidenceKeys[0], accountId, claim.referralCode, referrerAccountId, accountId,
      accountId, accountId,
      ...evidenceKeys, claim.platform, claim.referralCode, claim.firstTouchAt, claim.installedAt,
    );
}

function guardedEvidenceStatement(env, evidenceKeys, accountId, referrerAccountId) {
  // Persist the current private ledger identity, the stable lifetime replay
  // fingerprint, and Android's exact historical unversioned v1 identity. The
  // last entry keeps a safely configured emergency rollback from reopening a
  // claim made by this release; retired active-key candidates are read-only.
  const durableKeys = [
    evidenceKeys[0],
    ...evidenceKeys.filter(key => key.startsWith('p') || /^h1_/.test(key)),
  ];
  return env.DB.prepare(`INSERT INTO referral_evidence_fingerprints(evidence_hash)
    SELECT CAST(value AS TEXT) FROM json_each(?) WHERE EXISTS (
      SELECT 1 FROM referral_claim_ledger
      WHERE evidence_key=? AND referred_account_id=? AND referrer_account_id=?)`)
    .bind(JSON.stringify(durableKeys), evidenceKeys[0], accountId, referrerAccountId);
}

function guardedReferralClaimStatement(env, accountId, referrerAccountId, claim, evidenceKey) {
  return env.DB.prepare(`INSERT INTO referral_claims(
      referred_account_id,referrer_account_id,referral_code,platform,
      click_timestamp,install_timestamp,install_version,proof_provider,proof_app_version_code,
      attribution_provider,attribution_version
    )
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM referral_claim_ledger
      WHERE evidence_key=? AND referred_account_id=? AND referrer_account_id=?)`).bind(
    accountId, referrerAccountId, claim.referralCode, claim.platform,
    claim.firstTouchAt, claim.installedAt, claim.installedVersion,
    claim.proofProvider, claim.proofAppVersionCode,
    claim.attributionProvider, claim.attributionVersion,
    evidenceKey, accountId, referrerAccountId,
  );
}

async function claimReferral(req, env, account) {
  const body = await req.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);
  let parsedClaim;
  try { parsedClaim = parseReferralClaim(body, String(account.id), { nowSeconds: now }); }
  catch (error) {
    if (error instanceof PlatformProofError)
      return json({ ok: false, error: error.code }, error.status);
    return json({ ok: false, error: 'invalid_referral' }, 400);
  }
  if (Number(account.created_epoch || 0) < parsedClaim.installedAt - 300
      || Number(account.created_epoch || 0) > now
      || now - Number(account.created_epoch || 0) > 14 * 24 * 60 * 60)
    return json({ ok: false, error: 'new_account_required' }, 409);
  let evidenceKeys;
  try {
    await ensureReferralEvidenceKeyRing(env);
    evidenceKeys = await referralEvidenceKeys(env, parsedClaim);
  }
  catch { return json({ ok: false, error: 'referral_evidence_not_configured' }, 503); }

  // Cheap terminal state is checked before any OAuth or Play Integrity call.
  let state = await referralClaimState(env, account.id, parsedClaim, evidenceKeys);
  let terminal = referralClaimStateResponse(state, account.id);
  if (terminal) return terminal;
  try {
    if (!await referralClaimRateLimitAllowed(
      req, env, account.id, parsedClaim.referralCode, now,
    )) return json({ ok: false, error: 'referral_rate_limited' }, 429);
  } catch {
    return json({ ok: false, error: 'referral_throttle_unavailable' }, 503);
  }

  let claim;
  try { claim = await verifyReferralClaim(parsedClaim, env, { nowSeconds: now }); }
  catch (error) {
    if (error instanceof PlatformProofError)
      return json({ ok: false, error: error.code }, error.status);
    return json({ ok: false, error: 'platform_proof_unavailable' }, 503);
  }

  // External verification can take seconds. Re-read terminal state afterward,
  // then use a conditional first INSERT inside D1's transactional batch so a
  // code deletion, competing claim, or replay arriving at the boundary cannot
  // mutate any referral/reward row.
  state = await referralClaimState(env, account.id, claim, evidenceKeys);
  terminal = referralClaimStateResponse(state, account.id);
  if (terminal) return terminal;
  const referrerAccountId = Number(state.referrer.account_id);
  const evidenceKey = evidenceKeys[0];
  const conflictResponse = async () => {
    const latest = await referralClaimState(env, account.id, claim, evidenceKeys);
    return referralClaimStateResponse(latest, account.id);
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const results = await env.DB.batch([
        guardedClaimLedgerStatement(
          env, account.id, referrerAccountId, claim, evidenceKeys,
        ),
        guardedEvidenceStatement(env, evidenceKeys, account.id, referrerAccountId),
        guardedReferralClaimStatement(
          env, account.id, referrerAccountId, claim, evidenceKey,
        ),
        referralRewardStatement(env, evidenceKey, referrerAccountId),
        legacyReferralRewardStatement(env, evidenceKey, account.id),
      ]);
      if (Number(results?.[0]?.meta?.changes || 0) !== 1) {
        const conflict = await conflictResponse();
        if (conflict) return conflict;
        return json({ ok: false, error: 'referral_reward_busy' }, 503);
      }
      const rewarded = Number(results?.[3]?.meta?.changes || 0) > 0;
      if (rewarded) return json({ ok: true, rewardedReferrer: true }, 201);
      const rewardState = await referralRewardState(env, referrerAccountId);
      if (rewardState.rewardIds.length >= REFERRAL_REWARD_LIMIT)
        return json({ ok: true, rewardedReferrer: false, rewardLimitReached: true }, 201);
      return json({ ok: true, rewardedReferrer: false, shopComplete: true }, 201);
    } catch {
      const conflict = await conflictResponse();
      if (conflict) return conflict;
      if (attempt === 2) return json({ ok: false, error: 'referral_reward_busy' }, 503);
    }
  }
  return json({ ok: false, error: 'referral_reward_busy' }, 503);
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
  if (!legalConfig(env).ready)
    return json({ ok: false, error: 'legal_unavailable' }, 503);
  try {
    if (!await registrationRateLimitAllowed(
      req, env, Math.floor(Date.now() / 1000),
    )) return json({ ok: false, error: 'registration_rate_limited' }, 429);
  } catch { return json({ ok: false, error: 'registration_unavailable' }, 503); }
  const { username, password, acceptTerms, termsVersion } = await req.json();
  const usernameError = validateUsername(username);
  if (usernameError) return json({ ok: false, error: usernameError }, 400);
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 128)
    return json({ ok: false, error: 'weak_password' }, 400);
  if (acceptTerms !== true || termsVersion !== TERMS_VERSION)
    return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
  const salt = randomHex(16); const hash = await passwordHash(password, salt);
  try {
    await env.DB.prepare(`INSERT INTO accounts(username,lower_username,password_salt,password_hash)
      VALUES(?,?,?,?)`).bind(username, username.toLowerCase(), salt, hash).run();
  } catch { return json({ ok: false, error: 'username_taken' }, 409); }
  const account = await env.DB.prepare('SELECT id,username FROM accounts WHERE lower_username=?')
    .bind(username.toLowerCase()).first();
  const profile = await ensureAccountProfile(env, account.id);
  await env.DB.prepare(`UPDATE account_profiles
    SET terms_version=?,terms_accepted_at=datetime('now'),updated_at=datetime('now')
    WHERE account_id=?`).bind(TERMS_VERSION, account.id).run();
  profile.terms_version = TERMS_VERSION;
  const session = await createSession(env, account.id);
  return json({ ok: true, account: accountJson(account, profile), ...session }, 201);
}
async function login(req, env) {
  const { username, password } = await req.json();
  const account = await env.DB.prepare(`SELECT id,username,password_salt,password_hash
    FROM accounts WHERE lower_username=?`).bind(String(username || '').toLowerCase()).first();
  if (!account || typeof password !== 'string') return json({ ok: false, error: 'invalid_login' }, 401);
  const candidate = await passwordHash(password, account.password_salt);
  if (!constantTimeEqual(candidate, account.password_hash)) return json({ ok: false, error: 'invalid_login' }, 401);
  const profile = await ensureAccountProfile(env, account.id);
  const session = await createSession(env, account.id);
  return json({ ok: true, account: accountJson(account, profile), ...session });
}

async function acceptTerms(req, env, account) {
  if (!legalConfig(env).ready)
    return json({ ok: false, error: 'legal_unavailable' }, 503);
  const { accepted, version } = await req.json();
  if (accepted !== true || version !== TERMS_VERSION)
    return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
  await ensureAccountProfile(env, account.id);
  await env.DB.prepare(`UPDATE account_profiles
    SET terms_version=?,terms_accepted_at=datetime('now'),updated_at=datetime('now')
    WHERE account_id=?`).bind(TERMS_VERSION, account.id).run();
  const profile = await ensureAccountProfile(env, account.id);
  profile.terms_version = TERMS_VERSION;
  return json({ ok: true, account: accountJson(account, profile) });
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
  let referralProgressToken;
  try { referralProgressToken = await continueReferralDeletion(env, account.id); }
  catch {
    // Never delete the only plaintext evidence if we cannot first derive the
    // exact HMAC that the corresponding provider will check on replay.
    return json({ ok: false, error: 'account_deletion_temporarily_unavailable' }, 503);
  }
  if (referralProgressToken !== null)
    return json({
      ok: true,
      deletionPending: true,
      progressToken: referralProgressToken,
      retryAfterMs: 100,
    }, 202);
  // An active player who deletes the account forfeits before any match or
  // account row disappears. The opponent's eligible +5 reward and unordered
  // pair cooldown are recorded by the same atomic gate as a normal win.
  try { await settlePvPAccountDeparture(env, account.id); }
  catch {
    return json({ ok: false, error: 'account_deletion_temporarily_unavailable' }, 503);
  }
  // Explicit deletes make the privacy guarantee independent of connection-
  // scoped foreign-key settings and leave no orphaned leaderboard/save data.
  const statements = [
    env.DB.prepare('DELETE FROM pvp_round_scores WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM pvp_matches WHERE inviter_account_id=? OR invitee_account_id=?')
      .bind(account.id, account.id),
    env.DB.prepare('DELETE FROM pvp_rewards WHERE winner_account_id=?').bind(account.id),
    // Preserve an opponent's earned reward while erasing the deleted account's
    // numeric identity from the unordered-pair anti-farming fields.
    env.DB.prepare(`UPDATE pvp_rewards SET pair_low_account_id=NULL,pair_high_account_id=NULL
      WHERE pair_low_account_id=? OR pair_high_account_id=?`).bind(account.id, account.id),
    env.DB.prepare(`DELETE FROM friendships
      WHERE account_low_id=? OR account_high_id=?`).bind(account.id, account.id),
    env.DB.prepare(`DELETE FROM community_reports
      WHERE reporter_account_id=? OR reported_account_id=?`).bind(account.id, account.id),
    env.DB.prepare(`DELETE FROM username_reports
      WHERE reporter_account_id=? OR reported_account_id=?`).bind(account.id, account.id),
    env.DB.prepare(`DELETE FROM account_blocks
      WHERE blocker_account_id=? OR blocked_account_id=?`).bind(account.id, account.id),
    // Referral evidence and another player's already-earned entitlement must
    // survive deletion. Null only the deleted account's attribution. If the
    // deleted account is the reward owner, its own entitlement is removed.
    env.DB.prepare('DELETE FROM referral_reward_ledger WHERE referrer_account_id=?').bind(account.id),
    env.DB.prepare(`UPDATE referral_claim_ledger SET referred_account_id=NULL
      WHERE referred_account_id=?`).bind(account.id),
    env.DB.prepare(`UPDATE referral_claim_ledger SET referrer_account_id=NULL
      WHERE referrer_account_id=?`).bind(account.id),
    env.DB.prepare(`DELETE FROM referral_rewards
      WHERE referred_account_id=? OR referrer_account_id=?`).bind(account.id, account.id),
    env.DB.prepare(`DELETE FROM referral_claims
      WHERE referred_account_id=? OR referrer_account_id=?`).bind(account.id, account.id),
    env.DB.prepare('DELETE FROM referral_codes WHERE account_id=?').bind(account.id),
    env.DB.prepare(`DELETE FROM purchase_consumptions
      WHERE EXISTS (
        SELECT 1 FROM purchases p
        WHERE p.account_id=?
          AND p.platform=purchase_consumptions.platform
          AND p.transaction_id=purchase_consumptions.transaction_id
      )`).bind(account.id),
    env.DB.prepare('DELETE FROM ad_rewards WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM purchases WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM scores WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM cloud_saves WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM account_profiles WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM account_mutation_leases WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM account_deletion_jobs WHERE account_id=?').bind(account.id),
    env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(account.id),
  ];
  await env.DB.batch(statements);
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
  return json({
    ok: true,
    revision: next,
    mentality: clean.mentality,
    totalTaps: taps,
    adsWatched: clean.adsWatched,
  });
}

async function board(url, env, account) {
  if (String(env.MODERATION_ADMIN_TOKEN || '').length < 32)
    return json({ ok: false, error: 'community_unavailable' }, 503);
  const limit = Math.min(100, Math.max(10, Number(url.searchParams.get('limit')) || 50));
  const profile = account ? await ensureAccountProfile(env, account.id) : null;
  if (account && !hasCurrentTerms(profile))
    return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
  const top = account
    ? await env.DB.prepare(`SELECT a.username AS name,s.taps,a.id AS account_id,p.public_id AS player_ref
      FROM scores s
      JOIN accounts a ON a.id=s.account_id
      JOIN account_profiles p ON p.account_id=a.id
      WHERE p.terms_version=? AND p.leaderboard_status='active'
        AND NOT EXISTS (
          SELECT 1 FROM account_blocks b
          WHERE b.blocker_account_id=? AND b.blocked_account_id=a.id
        )
      ORDER BY s.taps DESC,s.updated_at ASC LIMIT ?`)
      .bind(TERMS_VERSION, account.id, limit).all()
    : await env.DB.prepare(`SELECT a.username AS name,s.taps,a.id AS account_id,p.public_id AS player_ref
      FROM scores s
      JOIN accounts a ON a.id=s.account_id
      JOIN account_profiles p ON p.account_id=a.id
      WHERE p.terms_version=? AND p.leaderboard_status='active'
      ORDER BY s.taps DESC,s.updated_at ASC LIMIT ?`)
      .bind(TERMS_VERSION, limit).all();
  let me = null;
  if (account && profile?.leaderboard_status === 'active') {
    const row = await env.DB.prepare('SELECT taps FROM scores WHERE account_id=?').bind(account.id).first();
    if (row) {
      const above = await env.DB.prepare(`SELECT COUNT(*) AS n
        FROM scores s
        JOIN account_profiles p ON p.account_id=s.account_id
        WHERE s.taps>? AND p.terms_version=? AND p.leaderboard_status='active'
          AND NOT EXISTS (
            SELECT 1 FROM account_blocks b
            WHERE b.blocker_account_id=? AND b.blocked_account_id=s.account_id
          )`).bind(row.taps, TERMS_VERSION, account.id).first();
      me = { rank: Number(above.n) + 1, name: account.username, taps: row.taps };
    }
  }
  const blocked = account
    ? await env.DB.prepare(`SELECT p.public_id AS player_ref,a.username AS name
      FROM account_blocks b
      JOIN accounts a ON a.id=b.blocked_account_id
      JOIN account_profiles p ON p.account_id=a.id
      WHERE b.blocker_account_id=? AND p.terms_version=?
        AND p.leaderboard_status='active'
      ORDER BY a.lower_username ASC LIMIT 100`).bind(account.id, TERMS_VERSION).all()
    : { results: [] };
  return json({
    top: (top.results || []).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      taps: r.taps,
      playerRef: r.player_ref,
      you: Boolean(account && r.account_id === account.id),
    })),
    me,
    blocked: (blocked.results || []).map((row) => ({
      playerRef: row.player_ref,
      name: row.name,
    })),
  });
}

const validPlayerRef = (value) => /^[0-9a-f]{32}$/.test(String(value || ''));
async function targetByPublicRef(env, playerRef) {
  if (!validPlayerRef(playerRef)) return null;
  return env.DB.prepare(`SELECT a.id,a.username,p.public_id,COALESCE(s.taps,0) AS taps
    FROM account_profiles p JOIN accounts a ON a.id=p.account_id
    LEFT JOIN scores s ON s.account_id=a.id
    WHERE p.public_id=?`).bind(playerRef).first();
}

async function blockAccount(req, env, account) {
  const profile = await ensureAccountProfile(env, account.id);
  if (!hasCurrentTerms(profile))
    return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
  const { playerRef } = await req.json();
  const target = await targetByPublicRef(env, playerRef);
  if (!target) return json({ ok: false, error: 'player_not_found' }, 404);
  if (target.id === account.id) return json({ ok: false, error: 'cannot_block_self' }, 400);
  const [low, high] = Number(account.id) < Number(target.id)
    ? [account.id, target.id] : [target.id, account.id];
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO account_blocks(blocker_account_id,blocked_account_id)
      VALUES(?,?)`).bind(account.id, target.id),
    env.DB.prepare(`DELETE FROM friendships
      WHERE account_low_id=? AND account_high_id=?`).bind(low, high),
    env.DB.prepare(`UPDATE pvp_matches SET status='cancelled',result_reason='blocked_player',
        updated_at=datetime('now'),state_revision=state_revision+1
      WHERE status='invited'
        AND ((inviter_account_id=? AND invitee_account_id=?)
          OR (inviter_account_id=? AND invitee_account_id=?))`)
      .bind(account.id, target.id, target.id, account.id),
    pvpForfeitIntentStatement(env, account.id, target.id, 'blocked_player'),
  ]);
  await settlePvPForfeit(env, account.id, target.id, 'blocked_player');
  const result = results[0];
  return json({ ok: true, blocked: true, alreadyBlocked: !Number(result?.meta?.changes || 0) });
}

async function unblockAccount(playerRef, env, account) {
  const profile = await ensureAccountProfile(env, account.id);
  if (!hasCurrentTerms(profile))
    return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
  const target = await targetByPublicRef(env, playerRef);
  if (!target) return json({ ok: true, blocked: false });
  await env.DB.prepare(`DELETE FROM account_blocks
    WHERE blocker_account_id=? AND blocked_account_id=?`).bind(account.id, target.id).run();
  return json({ ok: true, blocked: false });
}

async function reportAccount(req, env, account) {
  if (String(env.MODERATION_ADMIN_TOKEN || '').length < 32)
    return json({ ok: false, error: 'community_unavailable' }, 503);
  const profile = await ensureAccountProfile(env, account.id);
  if (!hasCurrentTerms(profile))
    return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
  const { playerRef, reason, details } = await req.json();
  if (!REPORT_REASONS.includes(reason))
    return json({ ok: false, error: 'invalid_report_reason' }, 400);
  if (typeof details !== 'string' || details.length > 500)
    return json({ ok: false, error: 'invalid_report_details' }, 400);
  const target = await targetByPublicRef(env, playerRef);
  if (!target) return json({ ok: false, error: 'player_not_found' }, 404);
  if (target.id === account.id) return json({ ok: false, error: 'cannot_report_self' }, 400);
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO community_reports(
      reporter_account_id,reported_account_id,
      reporter_username_snapshot,reported_username_snapshot,
      reported_taps_snapshot,reported_player_ref_snapshot,reason,details
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
    account.id,
    target.id,
    account.username,
    target.username,
    Number(target.taps) || 0,
    target.public_id,
    reason,
    details.trim(),
  ).run();
  const created = Number(result?.meta?.changes || 0) > 0;
  return json({ ok: true, reported: true, alreadyReported: !created }, created ? 201 : 200);
}

function moderationAuth(req, env) {
  const configured = String(env.MODERATION_ADMIN_TOKEN || '');
  if (configured.length < 32) return 'unavailable';
  const raw = req.headers.get('Authorization') || '';
  const candidate = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  return constantTimeEqual(candidate, configured) ? 'authorized' : 'unauthorized';
}

async function adminReports(url, env) {
  const status = url.searchParams.get('status') || 'open';
  if (!REPORT_STATUSES.includes(status))
    return json({ ok: false, error: 'invalid_report_status' }, 400);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const reports = await env.DB.prepare(`SELECT r.id,r.reason,r.details,r.status,r.moderator_note,
      r.created_at,r.updated_at,r.reviewed_at,
       r.reporter_username_snapshot AS reporter_name,
       r.reported_username_snapshot AS reported_name,
       r.reported_taps_snapshot,r.reported_player_ref_snapshot AS reported_player_ref,
       reported.username AS current_reported_name
    FROM community_reports r
    JOIN accounts reporter ON reporter.id=r.reporter_account_id
    JOIN accounts reported ON reported.id=r.reported_account_id
    WHERE r.status=? ORDER BY r.created_at ASC LIMIT ?`).bind(status, limit).all();
  return json({ ok: true, reports: (reports.results || []).map((row) => ({
    id: Number(row.id),
    reason: row.reason,
    details: row.details,
    status: row.status,
    moderatorNote: row.moderator_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    reporterName: row.reporter_name,
    reportedName: row.reported_name,
    currentReportedName: row.current_reported_name,
    reportedTaps: Number(row.reported_taps_snapshot) || 0,
    reportedPlayerRef: row.reported_player_ref,
  })) });
}

async function moderateReport(req, env, reportId) {
  if (!/^[1-9][0-9]*$/.test(reportId))
    return json({ ok: false, error: 'invalid_report' }, 400);
  const { status, moderatorNote = '', leaderboardAction = 'none' } = await req.json();
  if (!REPORT_STATUSES.includes(status))
    return json({ ok: false, error: 'invalid_report_status' }, 400);
  if (typeof moderatorNote !== 'string' || moderatorNote.length > 500)
    return json({ ok: false, error: 'invalid_moderator_note' }, 400);
  if (!['none', 'suspend', 'restore'].includes(leaderboardAction))
    return json({ ok: false, error: 'invalid_leaderboard_action' }, 400);
  const report = await env.DB.prepare(`SELECT reported_account_id FROM community_reports
    WHERE id=?`).bind(Number(reportId)).first();
  if (!report) return json({ ok: false, error: 'report_not_found' }, 404);
  const statements = [
    env.DB.prepare(`UPDATE community_reports
      SET status=?,moderator_note=?,reviewed_at=datetime('now'),updated_at=datetime('now')
      WHERE id=?`).bind(status, moderatorNote.trim(), Number(reportId)),
  ];
  if (leaderboardAction !== 'none') {
    statements.push(env.DB.prepare(`UPDATE account_profiles
      SET leaderboard_status=?,updated_at=datetime('now') WHERE account_id=?`)
      .bind(leaderboardAction === 'suspend' ? 'suspended' : 'active', report.reported_account_id));
  }
  await env.DB.batch(statements);
  return json({ ok: true, reportId: Number(reportId), status, leaderboardAction });
}

function normalizeGoogleMoney(value) {
  if (!value || !/^[A-Z]{3}$/.test(String(value.currencyCode || ''))
      || !/^-?\d+$/.test(String(value.units ?? ''))
      || !Number.isInteger(Number(value.nanos))
      || Number(value.nanos) < -999_999_999 || Number(value.nanos) > 999_999_999)
    throw new Error('invalid_google_money');
  const units = BigInt(String(value.units));
  const nanos = Number(value.nanos);
  if ((units > 0n && nanos < 0) || (units < 0n && nanos > 0)
      || units * 1_000_000_000n + BigInt(nanos) < 0n)
    throw new Error('invalid_google_money');
  return { currencyCode: String(value.currencyCode), units: units.toString(), nanos };
}

function googleFinancialStatus(value) {
  const states = {
    PENDING: 'pending',
    PROCESSED: 'processed',
    CANCELED: 'canceled',
    PENDING_REFUND: 'pending_refund',
    PARTIALLY_REFUNDED: 'partially_refunded',
    REFUNDED: 'refunded',
  };
  return states[String(value || '')] || 'unavailable';
}

export function googlePurchaseType(value) {
  if (value === undefined || value === null || value === '') return 'standard';
  return ({ 0: 'test', 1: 'promo', 2: 'rewarded' })[Number(value)] || 'unknown';
}

export function googleOrderFinancials(order, expected = {}) {
  const lineItem = expected.productId && Array.isArray(order?.lineItems)
    ? order.lineItems.find((item) => item?.productId === expected.productId)
    : null;
  if (!order || String(order.orderId || '') !== String(expected.orderId || '')
      || (expected.purchaseToken && order.purchaseToken !== expected.purchaseToken)
      || (expected.productId && !lineItem))
    throw new Error('google_order_mismatch');
  return {
    // LineItem.total is the amount actually paid for this verified product,
    // including discounts and tax. It avoids attributing unrelated line items
    // from a multi-item order to this transaction.
    ...normalizeGoogleMoney(lineItem ? lineItem.total : order.total),
    financialStatus: googleFinancialStatus(order.state),
    lastEventTime: typeof order.lastEventTime === 'string' ? order.lastEventTime : null,
  };
}

export function aggregateSpendTotals(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    if (!/^[A-Z]{3}$/.test(String(row.paid_currency || ''))
        || !/^-?\d+$/.test(String(row.paid_units ?? ''))
        || !Number.isInteger(Number(row.paid_nanos))) continue;
    const nanos = BigInt(String(row.paid_units)) * 1_000_000_000n
      + BigInt(Number(row.paid_nanos));
    if (nanos < 0n) continue;
    const current = totals.get(row.paid_currency) || { nanos: 0n, transactionCount: 0 };
    current.nanos += nanos;
    current.transactionCount += 1;
    totals.set(row.paid_currency, current);
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([currencyCode, total]) => ({
      currencyCode,
      units: (total.nanos / 1_000_000_000n).toString(),
      nanos: Number(total.nanos % 1_000_000_000n),
      transactionCount: total.transactionCount,
    }));
}

export async function purchaseHistory(req, env, account) {
  const [rows, spent, paid] = await Promise.all([
    env.DB.prepare(`SELECT p.platform,p.product_id,p.transaction_id,p.mentality_amount,p.verified_at,
      COALESCE(pf.purchase_type,'unknown') AS purchase_type,
      COALESCE(pf.financial_status,'unavailable') AS financial_status,
      pf.paid_currency,pf.paid_units,pf.paid_nanos,pf.region_code,pf.quantity,
      pf.revoked_at,pf.revocation_source,pf.revocation_reason,pf.revoked_quantity,
      CASE
        WHEN pf.revoked_at IS NOT NULL OR COALESCE(pf.financial_status,'unavailable')
          IN ('canceled','partially_refunded','refunded','revoked') THEN 'revoked'
        WHEN pf.financial_status='pending_refund' THEN 'pending_refund'
        WHEN p.platform='ios' OR pc.consumed_at IS NOT NULL THEN 'delivered'
        ELSE 'pending'
      END AS transaction_status,
      CASE WHEN p.platform='ios' OR pc.consumed_at IS NOT NULL THEN 1 ELSE 0 END AS delivered
    FROM purchases p LEFT JOIN purchase_consumptions pc
    ON pc.platform=p.platform AND pc.transaction_id=p.transaction_id
    LEFT JOIN purchase_financials pf
    ON pf.platform=p.platform AND pf.transaction_id=p.transaction_id
    WHERE p.account_id=? ORDER BY p.verified_at DESC`).bind(account.id).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(CASE
      WHEN p.platform='ios' OR pc.consumed_at IS NOT NULL THEN p.mentality_amount ELSE 0 END),0) AS m
    FROM purchases p LEFT JOIN purchase_consumptions pc
    ON pc.platform=p.platform AND pc.transaction_id=p.transaction_id
    LEFT JOIN purchase_financials pf
    ON pf.platform=p.platform AND pf.transaction_id=p.transaction_id
    WHERE p.account_id=? AND pf.revoked_at IS NULL
    AND COALESCE(pf.financial_status,'unavailable')
      NOT IN ('canceled','pending_refund','partially_refunded','refunded','revoked')`)
      .bind(account.id).first(),
    env.DB.prepare(`SELECT pf.paid_currency,pf.paid_units,pf.paid_nanos
      FROM purchases p JOIN purchase_financials pf
      ON pf.platform=p.platform AND pf.transaction_id=p.transaction_id
      WHERE p.account_id=? AND pf.purchase_type='standard'
      AND pf.financial_status='processed' AND pf.revoked_at IS NULL
      AND pf.paid_currency IS NOT NULL AND pf.paid_units IS NOT NULL
      AND pf.paid_nanos IS NOT NULL`).bind(account.id).all(),
  ]);
  return json({
    purchases: rows.results || [],
    purchasedMentality: spent.m,
    spendTotals: aggregateSpendTotals(paid.results || []),
  });
}

export async function completeAndroidConsumption({
  env, verifyUrl, access, transactionId, consumptionState, fetcher = fetch,
}) {
  let consumed = Number(consumptionState) === 1;
  let errorText = '';
  if (!consumed) {
    try {
      const response = await fetcher(`${verifyUrl}:consume`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}` },
      });
      consumed = response.ok;
      if (!consumed) errorText = `${response.status}:${(await response.text()).slice(0, 240)}`;
    } catch (error) {
      errorText = `network:${String(error?.message || error).slice(0, 240)}`;
    }
    if (!consumed) {
      // The consume request can succeed upstream while its response is lost.
      // Re-read Google before declaring it pending.
      try {
        const status = await fetcher(verifyUrl, { headers: { Authorization: `Bearer ${access}` } });
        if (status.ok) consumed = Number((await status.json()).consumptionState) === 1;
      } catch (error) {
        if (!errorText) errorText = `status:${String(error?.message || error).slice(0, 240)}`;
      }
    }
  }
  await env.DB.prepare(`INSERT INTO purchase_consumptions
      (platform,transaction_id,consume_attempts,consumed_at,last_error)
    VALUES('android',?,1,CASE WHEN ? THEN datetime('now') ELSE NULL END,?)
    ON CONFLICT(platform,transaction_id) DO UPDATE SET
      consume_attempts=purchase_consumptions.consume_attempts+1,
      consumed_at=CASE WHEN excluded.consumed_at IS NOT NULL
        THEN excluded.consumed_at ELSE purchase_consumptions.consumed_at END,
      last_error=CASE WHEN excluded.consumed_at IS NOT NULL
        THEN NULL ELSE excluded.last_error END,
      updated_at=datetime('now')`)
    .bind(transactionId, consumed ? 1 : 0, consumed ? null : errorText || 'consume_failed').run();
  return consumed;
}

async function googleAccessToken(env, fetcher = fetch) {
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
  const res = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!res.ok) throw new Error('google_auth_failed');
  return (await res.json()).access_token;
}

async function fetchGoogleOrder(access, orderId, expected = {}, fetcher = fetch) {
  const response = await fetcher(
    `${ANDROID_PUBLISHER_ROOT}/orders/${encodeURIComponent(orderId)}`,
    { headers: { Authorization: `Bearer ${access}` } },
  );
  if (!response.ok) throw new Error(`google_order_unavailable:${response.status}`);
  return googleOrderFinancials(await response.json(), { ...expected, orderId });
}

async function upsertPurchaseFinancials(env, {
  platform,
  transactionId,
  purchaseType = 'unknown',
  quantity = 0,
  regionCode = null,
  currencyCode = null,
  units = null,
  nanos = null,
  financialStatus = 'unavailable',
  syncedAt = null,
  revokedAt = null,
  revocationSource = null,
  revocationReason = null,
  revokedQuantity = null,
}) {
  await env.DB.prepare(`INSERT INTO purchase_financials(
      platform,transaction_id,purchase_type,quantity,region_code,
      paid_currency,paid_units,paid_nanos,financial_status,financial_synced_at,
      revoked_at,revocation_source,revocation_reason,revoked_quantity)
    VALUES(?,?,?,MAX(1,?),?,?,?,?,?,CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END,?,?,?,?)
    ON CONFLICT(platform,transaction_id) DO UPDATE SET
      purchase_type=CASE WHEN excluded.purchase_type='unknown'
        THEN purchase_financials.purchase_type ELSE excluded.purchase_type END,
      quantity=CASE WHEN excluded.purchase_type='unknown'
        THEN purchase_financials.quantity ELSE excluded.quantity END,
      region_code=COALESCE(excluded.region_code,purchase_financials.region_code),
      paid_currency=COALESCE(purchase_financials.paid_currency,excluded.paid_currency),
      paid_units=COALESCE(purchase_financials.paid_units,excluded.paid_units),
      paid_nanos=COALESCE(purchase_financials.paid_nanos,excluded.paid_nanos),
      financial_status=CASE
        WHEN purchase_financials.financial_status='revoked' THEN 'revoked'
        WHEN excluded.financial_status='pending'
          AND purchase_financials.financial_status NOT IN ('unavailable','pending')
          THEN purchase_financials.financial_status
        ELSE excluded.financial_status END,
      financial_synced_at=COALESCE(excluded.financial_synced_at,purchase_financials.financial_synced_at),
      revoked_at=COALESCE(purchase_financials.revoked_at,excluded.revoked_at),
      revocation_source=COALESCE(purchase_financials.revocation_source,excluded.revocation_source),
      revocation_reason=COALESCE(purchase_financials.revocation_reason,excluded.revocation_reason),
      revoked_quantity=CASE
        WHEN purchase_financials.revoked_quantity IS NULL THEN excluded.revoked_quantity
        WHEN excluded.revoked_quantity IS NULL THEN purchase_financials.revoked_quantity
        ELSE MAX(purchase_financials.revoked_quantity,excluded.revoked_quantity) END,
      updated_at=datetime('now')`)
    .bind(
      platform, transactionId, purchaseType, quantity, regionCode,
      currencyCode, units, nanos, financialStatus, syncedAt,
      revokedAt, revocationSource, revocationReason, revokedQuantity,
    ).run();
}

function safeEventTime(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0
      || milliseconds > 8_640_000_000_000_000) return null;
  return new Date(milliseconds).toISOString();
}

async function voidedPurchaseStatements(env, item) {
  const transactionId = String(item?.orderId || '');
  if (!transactionId) return [];
  const eventTime = safeEventTime(item.voidedTimeMillis);
  if (!eventTime) return [];
  const sourceValue = Number(item.voidedSource);
  const reasonValue = Number(item.voidedReason);
  const source = Number.isInteger(sourceValue) && sourceValue >= 0 && sourceValue <= 2
    ? `google:${sourceValue}` : 'google:unknown';
  const reason = Number.isInteger(reasonValue) && reasonValue >= 0 && reasonValue <= 8
    ? `google:${reasonValue}` : 'google:unknown';
  const quantity = Number.isInteger(Number(item.voidedQuantity))
    && Number(item.voidedQuantity) > 0 ? Number(item.voidedQuantity) : null;
  const eventKey = await sha256([
    'android', transactionId, String(item.voidedTimeMillis || ''),
    source, reason, quantity === null ? 'full' : String(quantity),
  ].join('|'));
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO purchase_reversals(
        external_event_key,platform,transaction_id,event_time,source,reason,quantity)
      SELECT ?,'android',?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM purchases WHERE platform='android' AND transaction_id=?)`)
      .bind(eventKey, transactionId, eventTime, source, reason, quantity, transactionId),
    env.DB.prepare(`INSERT INTO purchase_financials(
        platform,transaction_id,purchase_type,quantity,financial_status,financial_synced_at,
        revoked_at,revocation_source,revocation_reason,revoked_quantity)
      SELECT 'android',?,'unknown',1,'revoked',datetime('now'),?,?,?,?
      WHERE EXISTS(SELECT 1 FROM purchases WHERE platform='android' AND transaction_id=?)
      ON CONFLICT(platform,transaction_id) DO UPDATE SET
        financial_status='revoked',
        financial_synced_at=datetime('now'),
        revoked_at=CASE WHEN purchase_financials.revoked_at IS NULL
          OR excluded.revoked_at < purchase_financials.revoked_at
          THEN excluded.revoked_at ELSE purchase_financials.revoked_at END,
        revocation_source=excluded.revocation_source,
        revocation_reason=excluded.revocation_reason,
        revoked_quantity=CASE
          WHEN excluded.revoked_quantity IS NULL THEN NULL
          WHEN purchase_financials.revoked_quantity IS NULL THEN excluded.revoked_quantity
          ELSE MAX(purchase_financials.revoked_quantity,excluded.revoked_quantity) END,
        updated_at=datetime('now')`)
      .bind(transactionId, eventTime, source, reason, quantity, transactionId),
  ];
}

async function runStatementBatches(db, statements, size = 50) {
  for (let offset = 0; offset < statements.length; offset += size)
    await db.batch(statements.slice(offset, offset + size));
}

export async function reconcileAndroidVoids(env, {
  fetcher = fetch,
  accessToken = null,
  nowMs = Date.now(),
} = {}) {
  const access = accessToken || await googleAccessToken(env, fetcher);
  const state = await env.DB.prepare(`SELECT cursor_time_ms,window_end_ms,page_token
    FROM purchase_reconciliation_state WHERE platform='android'`).first();
  const pageToken = String(state?.page_token || '');
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const overlap = 6 * 60 * 60 * 1000;
  const windowEnd = pageToken && Number(state?.window_end_ms) > 0
    ? Number(state.window_end_ms) : nowMs;
  const cursor = Number(state?.cursor_time_ms) || 0;
  const start = Math.max(nowMs - thirtyDays, cursor ? cursor - overlap : nowMs - thirtyDays);
  const url = new URL(`${ANDROID_PUBLISHER_ROOT}/purchases/voidedpurchases`);
  url.searchParams.set('type', '0');
  url.searchParams.set('includeQuantityBasedPartialRefund', 'true');
  url.searchParams.set('maxResults', '1000');
  if (pageToken) url.searchParams.set('token', pageToken);
  else {
    url.searchParams.set('startTime', String(start));
    url.searchParams.set('endTime', String(windowEnd));
  }
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${access}` } });
  if (!response.ok) {
    const errorText = `${response.status}:${(await response.text()).slice(0, 240)}`;
    await env.DB.prepare(`INSERT INTO purchase_reconciliation_state(platform,last_error)
      VALUES('android',?) ON CONFLICT(platform) DO UPDATE SET
      last_error=excluded.last_error,updated_at=datetime('now')`).bind(errorText).run();
    throw new Error(`google_voids_unavailable:${response.status}`);
  }
  const body = await response.json();
  const statements = [];
  let reconciled = 0;
  for (const item of body.voidedPurchases || []) {
    const itemStatements = await voidedPurchaseStatements(env, item);
    if (itemStatements.length) reconciled += 1;
    statements.push(...itemStatements);
  }
  await runStatementBatches(env.DB, statements);

  const nextPageToken = String(body.tokenPagination?.nextPageToken || '');
  await env.DB.prepare(`INSERT INTO purchase_reconciliation_state(
      platform,cursor_time_ms,window_end_ms,page_token,last_success_at,last_error)
    VALUES('android',?,?,?,datetime('now'),NULL)
    ON CONFLICT(platform) DO UPDATE SET
      cursor_time_ms=excluded.cursor_time_ms,
      window_end_ms=excluded.window_end_ms,
      page_token=excluded.page_token,
      last_success_at=datetime('now'),last_error=NULL,updated_at=datetime('now')`)
    .bind(
      nextPageToken ? cursor : windowEnd,
      nextPageToken ? windowEnd : null,
      nextPageToken || null,
    ).run();
  return {
    reconciled,
    hasMore: Boolean(nextPageToken),
  };
}

export async function reconcileAndroidOrderStates(env, {
  fetcher = fetch,
  accessToken = null,
  limit = 100,
} = {}) {
  const access = accessToken || await googleAccessToken(env, fetcher);
  const rows = await env.DB.prepare(`SELECT p.transaction_id,p.product_id
    FROM purchases p LEFT JOIN purchase_financials pf
    ON pf.platform=p.platform AND pf.transaction_id=p.transaction_id
    WHERE p.platform='android'
    AND (pf.financial_synced_at IS NULL OR pf.financial_synced_at <= datetime('now','-6 hours'))
    AND COALESCE(pf.financial_status,'unavailable')
      NOT IN ('canceled','partially_refunded','refunded','revoked')
    ORDER BY COALESCE(pf.financial_synced_at,'') ASC,p.verified_at ASC
    LIMIT ?`).bind(integer(limit, 1, 500, 100)).all();
  let updated = 0;
  const errors = [];
  for (const row of rows.results || []) {
    try {
      const order = await fetchGoogleOrder(access, row.transaction_id, {
        productId: row.product_id,
      }, fetcher);
      const reversed = FINAL_REVERSED_FINANCIAL_STATUSES.includes(order.financialStatus);
      await upsertPurchaseFinancials(env, {
        platform: 'android',
        transactionId: row.transaction_id,
        currencyCode: order.currencyCode,
        units: order.units,
        nanos: order.nanos,
        financialStatus: order.financialStatus,
        syncedAt: new Date().toISOString(),
        revokedAt: reversed ? order.lastEventTime || new Date().toISOString() : null,
        revocationSource: reversed ? 'google:orders' : null,
        revocationReason: reversed ? `google:${order.financialStatus}` : null,
      });
      updated += 1;
    } catch (error) {
      errors.push({ transactionId: row.transaction_id, error: String(error?.message || error) });
    }
  }
  return { checked: (rows.results || []).length, updated, errors };
}

export async function reconcileAndroidPurchases(env, options = {}) {
  const access = options.accessToken || await googleAccessToken(env, options.fetcher || fetch);
  const [voids, orders] = await Promise.allSettled([
    reconcileAndroidVoids(env, { ...options, accessToken: access }),
    reconcileAndroidOrderStates(env, { ...options, accessToken: access }),
  ]);
  if (voids.status === 'rejected' || orders.status === 'rejected')
    throw new Error(`android_reconciliation_failed:${[
      voids.status === 'rejected' ? voids.reason?.message : '',
      orders.status === 'rejected' ? orders.reason?.message : '',
    ].filter(Boolean).join(',')}`);
  if (orders.value.errors.length)
    console.error('android_order_reconciliation_errors', orders.value.errors.length);
  return { voids: voids.value, orders: orders.value };
}

export async function verifyAndroidPurchase(req, env, account, {
  fetcher = fetch,
  accessToken = null,
} = {}) {
  const { productId, purchaseToken } = await req.json();
  const unitAmount = PRODUCTS[productId];
  if (!unitAmount || typeof purchaseToken !== 'string' || purchaseToken.length < 20)
    return json({ ok: false, error: 'invalid_purchase' }, 400);
  const access = accessToken || await googleAccessToken(env, fetcher);
  const verifyUrl = `${ANDROID_PUBLISHER_ROOT}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const verified = await fetcher(verifyUrl, { headers: { Authorization: `Bearer ${access}` } });
  if (!verified.ok) return json({ ok: false, error: 'purchase_not_verified' }, 422);
  const purchase = await verified.json();
  if (purchase.purchaseState !== 0 || !purchase.orderId
      || (purchase.productId && purchase.productId !== productId))
    return json({ ok: false, error: 'purchase_not_completed' }, 422);
  // Every launch build requires login before checkout. Missing/unbound legacy
  // receipts are quarantined instead of being awarded to the first claimant on
  // a shared device.
  const expectedAccountToken = await accountToken(account.id);
  if (purchase.obfuscatedExternalAccountId !== expectedAccountToken)
    return json({ ok: false, error: 'purchase_account_mismatch' }, 409);
  const purchaseType = googlePurchaseType(purchase.purchaseType);
  const quantity = integer(purchase.quantity, 1, 1000, 1);
  const amount = Math.min(MAX_SAFE, unitAmount * quantity);
  const regionCode = /^[A-Z]{2}$/.test(String(purchase.regionCode || ''))
    ? String(purchase.regionCode) : null;
  const tokenHash = await sha256(purchaseToken);
  let orderFinancials = null;
  try {
    orderFinancials = await fetchGoogleOrder(access, purchase.orderId, {
      purchaseToken,
      productId,
    }, fetcher);
  } catch (error) {
    // License-test, promo, and rewarded purchase types are explicitly excluded
    // from real-money totals. They can still exercise entitlement delivery
    // when Orders access is unavailable. A standard paid order fails closed.
    if (!['test', 'promo', 'rewarded'].includes(purchaseType)) {
      try {
        await env.DB.prepare(`INSERT INTO purchases(account_id,platform,product_id,transaction_id,purchase_token_hash,mentality_amount)
          VALUES(?,'android',?,?,?,?)`).bind(account.id, productId, purchase.orderId, tokenHash, amount).run();
      } catch (insertError) {
        const prior = await env.DB.prepare(`SELECT account_id,product_id FROM purchases
          WHERE platform='android' AND transaction_id=?`)
          .bind(purchase.orderId).first();
        if (prior?.account_id !== account.id || prior?.product_id !== productId) {
          if (prior) return json({ ok: false, error: 'purchase_already_claimed' }, 409);
          throw insertError;
        }
      }
      await upsertPurchaseFinancials(env, {
        platform: 'android',
        transactionId: purchase.orderId,
        purchaseType,
        quantity,
        regionCode,
        financialStatus: 'pending',
      });
      // The raw token remains unconsumed at Google and the durable pending row
      // is eligible for scheduled Orders reconciliation. A client retry is
      // still required before consumption and M delivery.
      return json({
        ok: false,
        error: 'purchase_financials_unavailable',
        recorded: true,
        amount,
        transactionId: purchase.orderId,
      }, 503);
    }
  }
  if (orderFinancials && orderFinancials.financialStatus !== 'processed')
    return json({ ok: false, error: 'purchase_not_completed' }, 422);

  try {
    await env.DB.prepare(`INSERT INTO purchases(account_id,platform,product_id,transaction_id,purchase_token_hash,mentality_amount)
      VALUES(?,'android',?,?,?,?)`).bind(account.id, productId, purchase.orderId, tokenHash, amount).run();
  } catch (error) {
    const prior = await env.DB.prepare(`SELECT account_id,product_id FROM purchases
      WHERE platform='android' AND transaction_id=?`)
      .bind(purchase.orderId).first();
    if (prior?.account_id !== account.id || prior?.product_id !== productId) {
      if (prior) return json({ ok: false, error: 'purchase_already_claimed' }, 409);
      throw error;
    }
  }
  await upsertPurchaseFinancials(env, {
    platform: 'android',
    transactionId: purchase.orderId,
    purchaseType,
    quantity,
    regionCode,
    currencyCode: orderFinancials?.currencyCode || null,
    units: orderFinancials?.units || null,
    nanos: orderFinancials?.nanos ?? null,
    financialStatus: orderFinancials?.financialStatus || 'unavailable',
    syncedAt: orderFinancials ? new Date().toISOString() : null,
  });
  // Grant eligibility begins only after Google confirms consumption. The
  // immutable purchase row makes retries idempotent; the delivery row makes a
  // failed consume durable and prevents the same SKU becoming stuck forever.
  const consumed = await completeAndroidConsumption({
    env,
    verifyUrl,
    access,
    transactionId: purchase.orderId,
    consumptionState: purchase.consumptionState,
    fetcher,
  });
  if (!consumed)
    return json({ ok: false, error: 'purchase_consumption_pending', recorded: true,
      amount, transactionId: purchase.orderId }, 503);
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
  // StoreKit transactions must be cryptographically bound to the same
  // authenticated cross-platform Discipline account.
  if (transaction.appAccountToken !== await accountToken(account.id))
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
      if (req.method === 'GET' && url.pathname === '/privacy') return html(privacyPage(env));
      if (req.method === 'GET' && url.pathname === '/terms') return html(termsPage(TERMS_VERSION, env));
      if (req.method === 'GET' && url.pathname === '/account-deletion') return html(deletionPage(env));
      if (req.method === 'GET' && url.pathname.startsWith('/r/')) return referralLanding(url, env);
      // Release automation must be able to validate referral secrets and the
      // D1 pepper registry while the rest of /v1 remains in maintenance.
      if (req.method === 'GET' && url.pathname === '/v1/referral/readiness')
        return referralReadiness(env);
      // The production deploy script enables this before applying migrations,
      // then removes it only after the final Worker is live. Keeping every API
      // request out of D1 during that short interval prevents legacy referral
      // writes or lockless PvP matches from slipping between schema and code.
      if (env.DEPLOYMENT_MAINTENANCE === '1' && url.pathname.startsWith('/v1/'))
        return json({ ok: false, error: 'service_maintenance' }, 503);
      // Browser WebSockets cannot attach the normal Authorization header. The
      // route consumes a short-lived, one-use ticket that was minted through
      // the authenticated REST API before proxying to the per-match DO.
      if (url.pathname.endsWith('/quick-draw/socket')) {
        const socket = await handleQuickDrawSocket(req, url, env);
        if (socket) return socket;
      }
      if (req.method === 'GET' && url.pathname === '/v1/legal') {
        const legal = legalJson(env);
        return legal.ready ? json(legal) : json({ ...legal, error: 'legal_unavailable' }, 503);
      }
      if (req.method === 'GET' && url.pathname === '/v1/pvp/readiness')
        return quickDrawReadiness(env);
      if (req.method === 'GET' && url.pathname === '/v1/admob/reward') return verifyAdmobCallback(req, env);
      if (req.method === 'POST' && url.pathname === '/v1/auth/register') return register(req, env);
      if (req.method === 'POST' && url.pathname === '/v1/auth/login') return login(req, env);
      if (url.pathname === '/v1/admin/reports'
          || url.pathname.startsWith('/v1/admin/reports/')) {
        const auth = moderationAuth(req, env);
        if (auth === 'unavailable') return json({ ok: false, error: 'moderation_unavailable' }, 503);
        if (auth !== 'authorized') return json({ ok: false, error: 'unauthorized' }, 401);
        if (req.method === 'GET' && url.pathname === '/v1/admin/reports')
          return adminReports(url, env);
        if (req.method === 'PUT' && url.pathname.startsWith('/v1/admin/reports/'))
          return moderateReport(req, env, url.pathname.slice('/v1/admin/reports/'.length));
        return json({ ok: false, error: 'not_found' }, 404);
      }
      const account = await authenticated(req, env);
      if (!account) {
        if (req.method === 'GET' && url.pathname === '/v1/board') return board(url, env, null);
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      // Account deletion never acquires a mutation lease. Its job INSERT is
      // the inverse half of the database lock used by mutating routes, so
      // either an in-flight mutation finishes first or deletion begins first.
      if (req.method === 'DELETE' && url.pathname === '/v1/account')
        return deleteAccount(env, account);
      const multiplayerRouteKind = authenticatedMultiplayerRouteKind(req.method, url.pathname);
      // Cheap per-isolate burst control prevents one modified client from
      // issuing a D1 attempt per physical tap. The D1 750 ms write floor below
      // remains authoritative across isolates, while a rejected burst performs
      // no account-state or match query at all after authentication.
      if (multiplayerRouteKind === 'guarded_tap') {
        const retryAfterMs = pvpTapBurstRetryAfter(account.id, url.pathname);
        if (retryAfterMs) return json({
          ok: false, error: 'pvp_tap_coalesced', retryAfterMs,
        }, 429);
      }
      // Only routes that can mutate by design acquire a D1 lease. In
      // particular, the 200 ms multiplayer state poll remains read-only at the
      // request boundary; its rare settlement/cleanup writes carry their own
      // deletion predicates inside the exact SQL statements.
      const mutationRoute = authenticatedMutationNeedsLease(req.method, url.pathname);
      const mutationLeaseId = mutationRoute
        ? await acquireAccountMutationLease(env, account.id) : null;
      if (mutationRoute && !mutationLeaseId)
        return json({ ok: false, error: 'account_deletion_pending' }, 409);
      if (!mutationRoute && await accountDeletionPending(env, account.id))
        return json({ ok: false, error: 'account_deletion_pending' }, 409);
      try {
      if (req.method === 'GET' && url.pathname === '/v1/board') return await board(url, env, account);
      if (req.method === 'GET' && url.pathname === '/v1/admob/reward/status')
        return await adRewardStatus(url, env, account);
      if (req.method === 'GET' && url.pathname === '/v1/referral')
        return await referralStatus(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/referral/claim')
        return await claimReferral(req, env, account);
      if (multiplayerRouteKind) {
        const profile = await ensureAccountProfile(env, account.id);
        if (!hasCurrentTerms(profile))
          return json({ ok: false, error: 'terms_required', termsVersion: TERMS_VERSION }, 428);
        const multiplayer = await handleMultiplayerRoute(req, url, env, account, TERMS_VERSION);
        if (multiplayer) return multiplayer;
      }
      if (req.method === 'GET' && url.pathname === '/v1/account') {
        const profile = await ensureAccountProfile(env, account.id);
        return json({ account: accountJson(account, profile) });
      }
      if (req.method === 'PUT' && url.pathname === '/v1/account/username') return await renameAccount(req, env, account);
      if (req.method === 'PUT' && url.pathname === '/v1/account/terms') return await acceptTerms(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/reports') return await reportAccount(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/blocks') return await blockAccount(req, env, account);
      if (req.method === 'DELETE' && url.pathname.startsWith('/v1/blocks/'))
        return await unblockAccount(decodeURIComponent(url.pathname.slice('/v1/blocks/'.length)), env, account);
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
      if (req.method === 'PUT' && url.pathname === '/v1/save') return await saveGame(req, env, account);
      if (req.method === 'GET' && url.pathname === '/v1/purchases') return await purchaseHistory(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/purchases/android/verify') return await verifyAndroidPurchase(req, env, account);
      if (req.method === 'POST' && url.pathname === '/v1/purchases/ios/verify') return await verifyIosPurchase(req, env, account);
      return json({ ok: false, error: 'not_found' }, 404);
      } finally {
        if (mutationLeaseId) {
          try { await releaseAccountMutationLease(env, mutationLeaseId, account.id); }
          catch (error) { console.error('account_mutation_lease_release_failed', account.id, error); }
        }
      }
    } catch (error) {
      if (error?.message === 'account_deletion_pending')
        return json({ ok: false, error: 'account_deletion_pending' }, 409);
      console.error(error);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      reconcileAndroidPurchases(env),
      pruneRequestRateLimits(env, Math.floor(Date.now() / 1000)),
    ]));
  },
};
