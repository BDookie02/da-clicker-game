import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANDROID_PACKAGE_NAME,
  APPLE_APP_ATTEST_PROVIDER,
  GOOGLE_PLAY_ATTRIBUTION_VERSION,
  GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
  GOOGLE_PLAY_INTEGRITY_PROVIDER,
  REFERRAL_PROOF_HASH_VERSION,
  PlatformProofError,
  canonicalReferralProofRequest,
  normalizeReferralClaim,
  referralProofRequestHash,
  verifyPlatformProof,
} from '../server/platform-attestation.js';

const expected = Object.freeze({
  accountId: '42',
  platform: 'android',
  code: 'A1B2C3D4E5',
  installReferrer: 'discipline_ref=A1B2C3D4E5',
  clickTimestamp: 1_777_000_000,
  installTimestamp: 1_777_000_005,
  installVersion: '1.0.11',
});

async function serviceAccountConfiguration(name) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    .toString('base64').match(/.{1,64}/g).join('\n');
  return JSON.stringify({
    client_email: `${name}@example.test`,
    private_key: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
  });
}

async function validDecodeResponse(expectedInput, nowMs) {
  return new Response(JSON.stringify({ tokenPayloadExternal: {
    requestDetails: {
      requestPackageName: ANDROID_PACKAGE_NAME,
      requestHash: await referralProofRequestHash(expectedInput),
      timestampMillis: String(nowMs - 1_000),
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: ANDROID_PACKAGE_NAME,
      versionCode: '12',
    },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('referral proof serialization is stable and excludes no security input', async () => {
  assert.equal(canonicalReferralProofRequest(expected), [
    'referral_claim_v1',
    'account_id=42',
    'platform=android',
    'referral_code=A1B2C3D4E5',
    'install_referrer=discipline_ref%3DA1B2C3D4E5',
    'click_timestamp=1777000000',
    'install_timestamp=1777000005',
    'install_version=1.0.11',
  ].join('\n'));
  assert.match(await referralProofRequestHash(expected), /^[A-Za-z0-9_-]{43}$/);
});

test('Google Play proof is decoded server-side and requires the full trusted verdict', async () => {
  const nowMs = 1_777_000_010_000;
  const requestHash = await referralProofRequestHash(expected);
  let calls = 0;
  const verified = await verifyPlatformProof({
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'signed-encrypted-token',
  }, expected, {}, {
    nowMs,
    accessToken: 'server-oauth-token',
    fetcher: async (url, init) => {
      calls += 1;
      assert.equal(url,
        `https://playintegrity.googleapis.com/v1/${ANDROID_PACKAGE_NAME}:decodeIntegrityToken`);
      assert.equal(init.headers.Authorization, 'Bearer server-oauth-token');
      assert.deepEqual(JSON.parse(init.body), { integrity_token: 'signed-encrypted-token' });
      return new Response(JSON.stringify({ tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: ANDROID_PACKAGE_NAME,
          requestHash,
          timestampMillis: String(nowMs - 5_000),
        },
        appIntegrity: {
          appRecognitionVerdict: 'PLAY_RECOGNIZED',
          packageName: ANDROID_PACKAGE_NAME,
          versionCode: '12',
        },
        accountDetails: { appLicensingVerdict: 'LICENSED' },
        deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(verified, {
    platform: 'android', provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    appVersionCode: 12, requestedAtMs: nowMs - 5_000,
  });
});

test('Play Integrity OAuth tokens are single-flight cached with an expiry margin', async () => {
  const nowMs = 1_777_000_010_000;
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: await serviceAccountConfiguration('oauth-cache'),
  };
  let oauthCalls = 0;
  let decodeCalls = 0;
  const fetcher = async url => {
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        access_token: 'shared-cached-token', expires_in: 3600,
      }), { status: 200 });
    }
    decodeCalls++;
    return validDecodeResponse(expected, nowMs);
  };
  const proof = {
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'cache-test-token',
  };
  await Promise.all([
    verifyPlatformProof(proof, expected, env, { nowMs, fetcher }),
    verifyPlatformProof(proof, expected, env, { nowMs, fetcher }),
  ]);
  await verifyPlatformProof(proof, expected, env, { nowMs, fetcher });
  assert.equal(oauthCalls, 1);
  assert.equal(decodeCalls, 3);
});

test('short OAuth expiry is respected instead of being cached for an hour', async () => {
  const nowMs = 1_777_000_010_000;
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: await serviceAccountConfiguration('oauth-short'),
  };
  let oauthCalls = 0;
  const fetcher = async url => {
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls++;
      return new Response(JSON.stringify({
        access_token: `short-token-${oauthCalls}`, expires_in: 1,
      }), { status: 200 });
    }
    return validDecodeResponse(expected, nowMs);
  };
  const proof = {
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'short-expiry-test-token',
  };
  await verifyPlatformProof(proof, expected, env, { nowMs, fetcher });
  await verifyPlatformProof(proof, expected, env, { nowMs, fetcher });
  assert.equal(oauthCalls, 2);
});

test('a rejected cached OAuth token is invalidated and refreshed exactly once', async () => {
  const nowMs = 1_777_000_010_000;
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: await serviceAccountConfiguration('oauth-revoked'),
  };
  let oauthCalls = 0;
  let decodeCalls = 0;
  const fetcher = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls++;
      return new Response(JSON.stringify({
        access_token: oauthCalls === 1 ? 'revoked-token' : 'fresh-token',
        expires_in: 3600,
      }), { status: 200 });
    }
    decodeCalls++;
    if (init.headers.Authorization === 'Bearer revoked-token')
      return new Response('{}', { status: 401 });
    assert.equal(init.headers.Authorization, 'Bearer fresh-token');
    return validDecodeResponse(expected, nowMs);
  };
  await verifyPlatformProof({
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'revoked-cache-test-token',
  }, expected, env, { nowMs, fetcher });
  assert.equal(oauthCalls, 2);
  assert.equal(decodeCalls, 2);
});

test('platform proof fails closed for a mismatched request and reserved iOS adapter', async () => {
  const invalidHash = await referralProofRequestHash(expected);
  await assert.rejects(() => verifyPlatformProof({
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'token',
  }, { ...expected, code: 'FFFFFFFFFF' }, {}, {
    nowMs: 1_777_000_010_000,
    accessToken: 'server-oauth-token',
    fetcher: async () => new Response(JSON.stringify({ tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: ANDROID_PACKAGE_NAME,
        requestHash: invalidHash,
        timestampMillis: '1777000005000',
      },
      appIntegrity: {
        appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: ANDROID_PACKAGE_NAME,
        versionCode: '12',
      },
      accountDetails: { appLicensingVerdict: 'LICENSED' },
      deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    } }), { status: 200 }),
  }), error => error instanceof PlatformProofError && error.code === 'invalid_platform_proof');

  await assert.rejects(() => verifyPlatformProof({
    provider: APPLE_APP_ATTEST_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'future-ios-token',
  }, { ...expected, platform: 'ios' }, {}),
  error => error instanceof PlatformProofError && error.code === 'unsupported_platform_proof');
});

test('Android attribution is normalized before domain logic sees provider fields', async () => {
  const proof = {
    provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
    token: 'test-token',
  };
  const normalized = await normalizeReferralClaim({
    referralCode: expected.code,
    platform: 'android',
    attribution: {
      provider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
      version: GOOGLE_PLAY_ATTRIBUTION_VERSION,
      installReferrer: expected.installReferrer,
      clickTimestamp: expected.clickTimestamp,
      installTimestamp: expected.installTimestamp,
      installVersion: expected.installVersion,
    },
    proof,
  }, expected.accountId, {
    [Symbol.for('discipline.test.platformProof')]: async (receivedProof, receivedExpected) => {
      assert.equal(receivedProof, proof);
      assert.deepEqual(receivedExpected, expected);
      return {
        platform: 'android', provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
        appVersionCode: 12, requestedAtMs: 1_777_000_006_000,
      };
    },
  }, { nowSeconds: 1_777_000_010 });
  assert.deepEqual(normalized, {
    referralCode: 'A1B2C3D4E5',
    platform: 'android',
    attributionProvider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
    attributionVersion: GOOGLE_PLAY_ATTRIBUTION_VERSION,
    evidenceId: '1777000000:1777000005',
    firstTouchAt: 1_777_000_000,
    installedAt: 1_777_000_005,
    installedVersion: '1.0.11',
    proofProvider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
    proofAppVersionCode: 12,
  });
  assert.equal('installReferrer' in normalized, false);
  assert.equal('clickTimestamp' in normalized, false);
});

test('the staged Android flat claim remains compatible with the normalized boundary', async () => {
  const normalized = await normalizeReferralClaim({
    ...expected,
    proof: {
      provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
      requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
      token: 'legacy-client-token',
    },
  }, expected.accountId, {
    [Symbol.for('discipline.test.platformProof')]: async (_proof, receivedExpected) => {
      assert.deepEqual(receivedExpected, expected);
      return {
        platform: 'android', provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
        appVersionCode: 12, requestedAtMs: 1_777_000_006_000,
      };
    },
  }, { nowSeconds: 1_777_000_010 });
  assert.equal(normalized.referralCode, expected.code);
  assert.equal(normalized.attributionProvider, GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER);
  assert.equal(normalized.evidenceId, '1777000000:1777000005');
});

test('reserved Apple attribution is explicit and fails closed before domain mutation', async () => {
  await assert.rejects(() => normalizeReferralClaim({
    referralCode: expected.code,
    platform: 'ios',
    attribution: {
      provider: 'future_apple_attribution',
      version: 'unimplemented',
      token: 'future-token',
    },
    proof: {
      provider: APPLE_APP_ATTEST_PROVIDER,
      requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
      token: 'future-proof',
    },
  }, expected.accountId, {}),
  error => error instanceof PlatformProofError && error.code === 'unsupported_platform_proof');
});
