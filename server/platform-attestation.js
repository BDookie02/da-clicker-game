// Platform-neutral proof verification for security-sensitive app actions.
// The account, friend, referral, match, and reward models are owned by
// DISCIPLINE. Store platforms only supply replaceable authenticity adapters.

export const REFERRAL_PROOF_HASH_VERSION = 'referral_claim_v1';
export const GOOGLE_PLAY_INTEGRITY_PROVIDER = 'google_play_integrity';
export const APPLE_APP_ATTEST_PROVIDER = 'apple_app_attest';
export const GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER = 'google_play_install_referrer';
export const GOOGLE_PLAY_ATTRIBUTION_VERSION = 'google_play_install_referrer_v1';
export const ANDROID_PACKAGE_NAME = 'com.nosiah.discipline';
export const MIN_ANDROID_VERSION_CODE = 12;
export const PLATFORM_PROOF_TEST_HOOK = Symbol.for('discipline.test.platformProof');

const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAY_INTEGRITY_DECODE_URL =
  `https://playintegrity.googleapis.com/v1/${ANDROID_PACKAGE_NAME}:decodeIntegrityToken`;
const MAX_TOKEN_AGE_MS = 2 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 1000;
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

let playIntegrityAccessTokenCache = {
  configuration: '',
  token: '',
  expiresAtMs: 0,
  inFlight: null,
};

const encoder = new TextEncoder();

const base64url = (value) => btoa(typeof value === 'string'
  ? value : String.fromCharCode(...value))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export function canonicalReferralProofRequest(input) {
  return [
    REFERRAL_PROOF_HASH_VERSION,
    `account_id=${encodeURIComponent(String(input.accountId || ''))}`,
    `platform=${encodeURIComponent(String(input.platform || ''))}`,
    `referral_code=${encodeURIComponent(String(input.code || ''))}`,
    `install_referrer=${encodeURIComponent(String(input.installReferrer || ''))}`,
    `click_timestamp=${String(input.clickTimestamp)}`,
    `install_timestamp=${String(input.installTimestamp)}`,
    `install_version=${encodeURIComponent(String(input.installVersion || ''))}`,
  ].join('\n');
}

export async function referralProofRequestHash(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(
    canonicalReferralProofRequest(input),
  ));
  return base64url(new Uint8Array(digest));
}

async function googleAccessToken(env, fetcher) {
  const configuration = String(env?.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  if (!configuration)
    throw new PlatformProofError('platform_proof_not_configured', 503);
  const cached = playIntegrityAccessTokenCache;
  if (cached.configuration === configuration && cached.token
      && cached.expiresAtMs - ACCESS_TOKEN_EXPIRY_MARGIN_MS > Date.now())
    return cached.token;
  if (cached.configuration === configuration && cached.inFlight)
    return cached.inFlight;
  const inFlight = (async () => {
  let service;
  try { service = JSON.parse(configuration); }
  catch { throw new PlatformProofError('platform_proof_not_configured', 503); }
  if (!service?.client_email || !service?.private_key)
    throw new PlatformProofError('platform_proof_not_configured', 503);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: service.client_email,
    scope: PLAY_INTEGRITY_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  let key;
  try {
    const binary = atob(service.private_key.replace(
      /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '',
    ));
    key = await crypto.subtle.importKey(
      'pkcs8', Uint8Array.from(binary, char => char.charCodeAt(0)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
  } catch { throw new PlatformProofError('platform_proof_not_configured', 503); }
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
  let response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
      }),
    });
  } catch { throw new PlatformProofError('platform_proof_unavailable', 503); }
  if (!response.ok) throw new PlatformProofError('platform_proof_unavailable', 503);
  const payload = await response.json().catch(() => ({}));
  const accessToken = String(payload?.access_token || '');
  if (!accessToken) throw new PlatformProofError('platform_proof_unavailable', 503);
  const expiresIn = Number(payload?.expires_in);
  const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0
    ? Math.min(expiresIn, 3600) * 1000 : 3600 * 1000;
  playIntegrityAccessTokenCache = {
    configuration,
    token: accessToken,
    expiresAtMs: Date.now() + lifetimeMs,
    inFlight: null,
  };
  return accessToken;
  })();
  playIntegrityAccessTokenCache = {
    configuration, token: '', expiresAtMs: 0, inFlight,
  };
  try { return await inFlight; }
  finally {
    if (playIntegrityAccessTokenCache.inFlight === inFlight)
      playIntegrityAccessTokenCache.inFlight = null;
  }
}

function invalidateGoogleAccessToken(env, token) {
  const configuration = String(env?.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  if (playIntegrityAccessTokenCache.configuration === configuration
      && playIntegrityAccessTokenCache.token === token) {
    playIntegrityAccessTokenCache = {
      configuration, token: '', expiresAtMs: 0, inFlight: null,
    };
  }
}

export class PlatformProofError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function requirePlayVerdict(payload, expectedHash, nowMs) {
  const request = payload?.requestDetails;
  const app = payload?.appIntegrity;
  const account = payload?.accountDetails;
  const deviceVerdicts = payload?.deviceIntegrity?.deviceRecognitionVerdict;
  const timestampMillis = Number(request?.timestampMillis);
  const versionCode = Number(app?.versionCode);
  if (request?.requestPackageName !== ANDROID_PACKAGE_NAME
      || request?.requestHash !== expectedHash
      || !Number.isFinite(timestampMillis)
      || timestampMillis > nowMs + MAX_FUTURE_SKEW_MS
      || nowMs - timestampMillis > MAX_TOKEN_AGE_MS
      || app?.appRecognitionVerdict !== 'PLAY_RECOGNIZED'
      || app?.packageName !== ANDROID_PACKAGE_NAME
      || !Number.isInteger(versionCode)
      || versionCode < MIN_ANDROID_VERSION_CODE
      || account?.appLicensingVerdict !== 'LICENSED'
      || !Array.isArray(deviceVerdicts)
      || !deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY'))
    throw new PlatformProofError('invalid_platform_proof', 422);
  return {
    platform: 'android',
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    appVersionCode: versionCode,
    requestedAtMs: timestampMillis,
  };
}

async function verifyGooglePlayIntegrity(proof, expectedHash, env, options) {
  const token = String(proof?.token || '');
  if (!token || token.length > 32_768)
    throw new PlatformProofError('invalid_platform_proof', 422);
  const fetcher = options.fetcher || fetch;
  const callerSuppliedAccessToken = Boolean(options.accessToken);
  let accessToken = options.accessToken || await googleAccessToken(env, fetcher);
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetcher(PLAY_INTEGRITY_DECODE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ integrity_token: token }),
      });
    } catch { throw new PlatformProofError('platform_proof_unavailable', 503); }
    if ((response.status === 401 || response.status === 403)
        && !callerSuppliedAccessToken && attempt === 0) {
      invalidateGoogleAccessToken(env, accessToken);
      accessToken = await googleAccessToken(env, fetcher);
      continue;
    }
    break;
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429
        || response.status === 401 || response.status === 403)
      throw new PlatformProofError('platform_proof_unavailable', 503);
    throw new PlatformProofError('invalid_platform_proof', 422);
  }
  const decoded = await response.json().catch(() => null);
  if (!decoded?.tokenPayloadExternal)
    throw new PlatformProofError('invalid_platform_proof', 422);
  return requirePlayVerdict(
    decoded.tokenPayloadExternal, expectedHash, Number(options.nowMs ?? Date.now()),
  );
}

export async function verifyPlatformProof(proof, expected, env, options = {}) {
  const testVerifier = env?.[PLATFORM_PROOF_TEST_HOOK];
  if (typeof testVerifier === 'function') return testVerifier(proof, expected, options);
  if (!proof || proof.requestHashVersion !== REFERRAL_PROOF_HASH_VERSION)
    throw new PlatformProofError('invalid_platform_proof', 422);
  const expectedHash = await referralProofRequestHash(expected);
  if (proof.provider === GOOGLE_PLAY_INTEGRITY_PROVIDER)
    return verifyGooglePlayIntegrity(proof, expectedHash, env, options);
  // Reserved provider name keeps the domain contract cross-platform while the
  // future iOS verifier remains fail-closed until implemented and reviewed.
  if (proof.provider === APPLE_APP_ATTEST_PROVIDER)
    throw new PlatformProofError('unsupported_platform_proof', 422);
  throw new PlatformProofError('unsupported_platform_proof', 422);
}

function integer(value, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) return null;
  return numeric;
}

/**
 * Provider boundary for referral attribution. The rest of the Worker consumes
 * only the normalized object returned here; store-specific field names and
 * cryptographic rules stay inside their adapter.
 *
 * The legacy flat Android body remains accepted so an already-built Android
 * client can cross a staged backend rollout. New clients use the explicit
 * `attribution` envelope. The reserved Apple provider fails closed until its
 * AdServices attribution and App Attest verifier are implemented together.
 */
export function parseReferralClaim(body, accountId, options = {}) {
  const platform = String(body?.platform || '');
  const referralCode = String(body?.referralCode || body?.code || '').trim().toUpperCase();
  if (!/^[A-F0-9]{10}$/.test(referralCode))
    throw new PlatformProofError('invalid_referral', 400);

  const attribution = body?.attribution && typeof body.attribution === 'object'
    ? body.attribution
    : platform === 'android'
      ? {
          provider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
          version: GOOGLE_PLAY_ATTRIBUTION_VERSION,
          installReferrer: body?.installReferrer,
          clickTimestamp: body?.clickTimestamp,
          installTimestamp: body?.installTimestamp,
          installVersion: body?.installVersion,
        }
      : null;

  if (platform === 'ios') {
    // iOS support is intentionally fail-closed until both attribution and
    // App Attest can be selected, implemented, and verified together; neither
    // Google nor Android identifiers enter the DISCIPLINE-owned domain, and we
    // do not guess an Apple attribution product before that review.
    throw new PlatformProofError('unsupported_platform_proof', 422);
  }
  if (platform !== 'android'
      || attribution?.provider !== GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER
      || attribution?.version !== GOOGLE_PLAY_ATTRIBUTION_VERSION)
    throw new PlatformProofError('unsupported_platform_proof', 422);

  const installReferrer = String(attribution.installReferrer || '');
  const installVersion = String(attribution.installVersion || '');
  const clickTimestamp = integer(attribution.clickTimestamp, 1, 4_102_444_800);
  const installTimestamp = integer(attribution.installTimestamp, 1, 4_102_444_800);
  const now = Number(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  if (installReferrer.length > 2048 || installVersion.length > 32
      || clickTimestamp === null || installTimestamp === null)
    throw new PlatformProofError('invalid_referral', 400);
  const parsed = new URLSearchParams(installReferrer);
  if (parsed.get('discipline_ref')?.toUpperCase() !== referralCode)
    throw new PlatformProofError('referral_mismatch', 400);
  if (clickTimestamp > installTimestamp + 300 || installTimestamp > now + 300
      || now - installTimestamp > 90 * 24 * 60 * 60)
    throw new PlatformProofError('invalid_install_evidence', 400);

  return Object.freeze({
    referralCode,
    platform,
    attributionProvider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
    attributionVersion: GOOGLE_PLAY_ATTRIBUTION_VERSION,
    // Provider-stable, privacy-sensitive material. The core immediately feeds
    // this through its keyed HMAC and never persists the plaintext value.
    evidenceId: `${clickTimestamp}:${installTimestamp}`,
    firstTouchAt: clickTimestamp,
    installedAt: installTimestamp,
    installedVersion: installVersion,
    proof: body?.proof,
    proofRequest: Object.freeze({
      accountId: String(accountId),
      platform,
      code: referralCode,
      installReferrer,
      clickTimestamp,
      installTimestamp,
      installVersion,
    }),
  });
}

export async function verifyReferralClaim(parsedClaim, env, options = {}) {
  const verifiedProof = await verifyPlatformProof(parsedClaim.proof, parsedClaim.proofRequest, env, options);
  if (verifiedProof.platform !== parsedClaim.platform)
    throw new PlatformProofError('invalid_platform_proof', 422);
  const { proof: _proof, proofRequest: _proofRequest, ...claim } = parsedClaim;
  return Object.freeze({
    ...claim,
    proofProvider: verifiedProof.provider,
    proofAppVersionCode: verifiedProof.appVersionCode || null,
  });
}

export async function normalizeReferralClaim(body, accountId, env, options = {}) {
  const parsedClaim = parseReferralClaim(body, accountId, options);
  return verifyReferralClaim(parsedClaim, env, options);
}
