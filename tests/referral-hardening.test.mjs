import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, {
  referralEvidenceKey,
  referralEvidenceKeys,
} from '../server/worker.js';
import {
  APPLE_APP_ATTEST_PROVIDER,
  GOOGLE_PLAY_ATTRIBUTION_VERSION,
  GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
  GOOGLE_PLAY_INTEGRITY_PROVIDER,
  PlatformProofError,
  PLATFORM_PROOF_TEST_HOOK,
  REFERRAL_PROOF_HASH_VERSION,
  referralProofRequestHash,
  verifyPlatformProof,
} from '../server/platform-attestation.js';

const REFERRAL_RATE_LIMIT_TEST_HOOK = Symbol.for(
  'discipline.test.referralRateLimits',
);

class D1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  first(column) {
    this.db.executed++;
    const row = this.db.sqlite.prepare(this.sql).get(...this.args) || null;
    return column && row ? row[column] : row;
  }

  all() {
    this.db.executed++;
    return { success: true, results: this.db.sqlite.prepare(this.sql).all(...this.args) };
  }

  run() {
    this.db.executed++;
    const result = this.db.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class D1Database {
  constructor(loadFreshSchema = true) {
    this.sqlite = new DatabaseSync(':memory:');
    this.executed = 0;
    this.batchSizes = [];
    this.beforeBatch = null;
    if (loadFreshSchema)
      this.sqlite.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    return new D1Statement(this, sql);
  }

  batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      hook();
    }
    this.batchSizes.push(statements.length);
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrationRange(DB, predicate) {
  const directory = new URL('../server/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    if (predicate(file)) DB.sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
}

async function migratedLegacyReferralFixture(includeSecondClaim = false) {
  const DB = new D1Database(false);
  applyMigrationRange(DB, file => file < '0009_');
  await seedAccount(DB, 1, 'LegacyOwner', 'legacy-owner-token');
  await seedAccount(DB, 2, 'LegacyInstall', 'legacy-install-token');
  await seedAccount(DB, 3, 'ReplayInstall', 'replay-install-token');
  await seedAccount(DB, 4, 'ReplacementOwner', 'replacement-owner-token');
  await seedAccount(DB, 5, 'SecondLegacyInstall', 'second-legacy-token');
  const installTimestamp = Math.floor(Date.now() / 1000);
  const clickTimestamp = installTimestamp - 6;
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  DB.sqlite.prepare(`INSERT INTO referral_claims(
    referred_account_id,referrer_account_id,referral_code,platform,
    click_timestamp,install_timestamp,install_version
  ) VALUES(?,?,?,?,?,?,?)`).run(
    2, 1, 'A1B2C3D4E5', 'android', clickTimestamp, installTimestamp, '1.0.10',
  );
  DB.sqlite.prepare(`INSERT INTO referral_rewards(
    referred_account_id,referrer_account_id,reward_index,cosmetic_id
  ) VALUES(?,?,?,?)`).run(2, 1, 1, 'orn_napkin');
  if (includeSecondClaim) {
    DB.sqlite.prepare(`INSERT INTO referral_claims(
      referred_account_id,referrer_account_id,referral_code,platform,
      click_timestamp,install_timestamp,install_version
    ) VALUES(?,?,?,?,?,?,?)`).run(
      5, 1, 'A1B2C3D4E5', 'android', clickTimestamp + 2, installTimestamp + 2, '1.0.10',
    );
    DB.sqlite.prepare(`INSERT INTO referral_rewards(
      referred_account_id,referrer_account_id,reward_index,cosmetic_id
    ) VALUES(?,?,?,?)`).run(5, 1, 2, 'goop_gold');
  }
  applyMigrationRange(DB, file => file >= '0009_');
  return { DB, clickTimestamp, installTimestamp };
}

const digest = async value => Buffer.from(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value),
)).toString('hex');

async function seedAccount(db, id, username, token) {
  db.sqlite.prepare(`INSERT INTO accounts(
    id,username,lower_username,password_salt,password_hash,created_at
  ) VALUES(?,?,?,?,?,datetime('now'))`).run(id, username, username.toLowerCase(), '00', '00');
  db.sqlite.prepare('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)')
    .run(await digest(token), id, Math.floor(Date.now() / 1000) + 3600);
}

const authorized = (path, token, body, extraHeaders = {}) => new Request(`https://api.example${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...extraHeaders,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function deleteAccountFully(env, token) {
  const statuses = [];
  for (let page = 0; page < 1000; page++) {
    const response = await worker.fetch(new Request('https://api.example/v1/account', {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }), env);
    statuses.push(response.status);
    if (response.status !== 202) return { response, statuses };
  }
  throw new Error('account deletion did not finish');
}

const TEST_EVIDENCE_SECRET = 'test-only-referral-evidence-secret-at-least-32-bytes';
const referralEnv = DB => ({
  DB,
  REFERRAL_EVIDENCE_HMAC_KEYRING_JSON: JSON.stringify({
    current: 'test-2026-08', keys: { 'test-2026-08': TEST_EVIDENCE_SECRET },
  }),
  REFERRAL_EVIDENCE_REPLAY_PEPPER: TEST_EVIDENCE_SECRET,
  [PLATFORM_PROOF_TEST_HOOK]: async (proof, expected) => {
    assert.equal(proof?.provider, GOOGLE_PLAY_INTEGRITY_PROVIDER);
    assert.equal(proof?.requestHashVersion, REFERRAL_PROOF_HASH_VERSION);
    assert.equal(proof?.requestHash, await referralProofRequestHash(expected));
    return {
      platform: 'android', provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
      appVersionCode: 12, requestedAtMs: Date.now(),
    };
  },
});

async function legacyAndroidEvidenceKey(code, clickTimestamp, installTimestamp) {
  const secret = TEST_EVIDENCE_SECRET;
  const canonical = [
    'referral_evidence_v1',
    'platform=android',
    `referral_code=${encodeURIComponent(code)}`,
    `click_timestamp=${clickTimestamp}`,
    `install_timestamp=${installTimestamp}`,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = Buffer.from(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(canonical),
  )).toString('base64url');
  return `h1_${signature}`;
}

async function addTestProof(evidence, accountId) {
  if (evidence.platform === 'ios') return {
    referralCode: evidence.code,
    platform: 'ios',
    attribution: {
      provider: 'future_apple_attribution',
      version: 'unimplemented',
      token: 'future-attribution-token',
    },
    proof: {
      provider: APPLE_APP_ATTEST_PROVIDER,
      requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
      token: 'future-ios-token',
    },
  };
  const attribution = {
    provider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
    version: GOOGLE_PLAY_ATTRIBUTION_VERSION,
    installReferrer: evidence.installReferrer,
    clickTimestamp: evidence.clickTimestamp,
    installTimestamp: evidence.installTimestamp,
    installVersion: evidence.installVersion,
  };
  return {
    referralCode: evidence.code,
    platform: 'android',
    attribution,
    proof: {
      provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
      requestHashVersion: REFERRAL_PROOF_HASH_VERSION,
      requestHash: await referralProofRequestHash({
        accountId: String(accountId), platform: evidence.platform,
        code: evidence.code, installReferrer: evidence.installReferrer,
        clickTimestamp: evidence.clickTimestamp,
        installTimestamp: evidence.installTimestamp,
        installVersion: evidence.installVersion,
      }),
      token: 'test-token',
    },
  };
}

test('referral evidence is one-use and referred-account deletion preserves lifetime reward state', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'Referrer', 'referrer-token');
  await seedAccount(DB, 2, 'ReferredA', 'referred-a-token');
  await seedAccount(DB, 3, 'ReferredB', 'referred-b-token');
  await seedAccount(DB, 4, 'IosClaim', 'ios-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');

  const installTimestamp = Math.floor(Date.now() / 1000);
  const firstEvidence = {
    code: 'A1B2C3D4E5',
    installReferrer: 'discipline_ref=A1B2C3D4E5',
    platform: 'android',
    clickTimestamp: installTimestamp - 5,
    installTimestamp,
    installVersion: '1.0.11',
  };
  const env = referralEnv(DB);
  const first = await worker.fetch(
    authorized('/v1/referral/claim', 'referred-a-token', await addTestProof(firstEvidence, 2)), env,
  );
  assert.equal(first.status, 201);
  assert.equal((await first.json()).rewardedReferrer, true);

  const evidenceKey = await referralEvidenceKey(
    env, 'android', 'A1B2C3D4E5', installTimestamp - 5, installTimestamp,
  );
  assert.equal(DB.sqlite.prepare(`SELECT reward_index FROM referral_reward_ledger
    WHERE evidence_key=?`).get(evidenceKey).reward_index, 1);

  const { response: deleted, statuses: deletionStatuses } = await deleteAccountFully(
    env, 'referred-a-token',
  );
  assert.deepEqual(deletionStatuses, [202, 200]);
  assert.equal(deleted.status, 200);
  assert.equal(DB.sqlite.prepare(`SELECT referred_account_id FROM referral_claim_ledger
    WHERE evidence_key=?`).get(evidenceKey).referred_account_id, null);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_reward_ledger
    WHERE referrer_account_id=1`).get().count, 1);

  const replay = await worker.fetch(
    authorized('/v1/referral/claim', 'referred-b-token', await addTestProof({
      ...firstEvidence,
      // A mutable display field cannot bypass the install-evidence key.
      installVersion: 'different-client-value',
    }, 3)), env,
  );
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { ok: false, error: 'install_evidence_already_used' });

  const second = await worker.fetch(
    authorized('/v1/referral/claim', 'referred-b-token', await addTestProof({
      ...firstEvidence,
      clickTimestamp: installTimestamp - 4,
      installTimestamp: installTimestamp + 1,
    }, 3)), env,
  );
  assert.equal(second.status, 201);
  assert.equal((await second.json()).rewardedReferrer, true);
  assert.deepEqual(
    DB.sqlite.prepare(`SELECT reward_index FROM referral_reward_ledger
      WHERE referrer_account_id=1 ORDER BY reward_index`).all().map(row => row.reward_index),
    [1, 2],
  );

  const status = await worker.fetch(
    authorized('/v1/referral', 'referrer-token'), env,
  );
  assert.equal(status.status, 200);
  const referral = await status.json();
  assert.equal(referral.rewardCount, 2);
  assert.equal(referral.remaining, 8);

  const ios = await worker.fetch(
    authorized('/v1/referral/claim', 'ios-token', await addTestProof({
      ...firstEvidence, platform: 'ios',
    }, 4)), env,
  );
  assert.equal(ios.status, 422);
  assert.deepEqual(await ios.json(), { ok: false, error: 'unsupported_platform_proof' });
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_claim_ledger
    WHERE referred_account_id=4`).get().count, 0);
});

test('the canonical DISCIPLINE referral route stays neutral and preserves Android Install Referrer', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'RouteOwner', 'route-owner-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  const env = {
    ...referralEnv(DB),
    PUBLIC_REFERRAL_BASE_URL: 'https://discipline-api.nomogames.workers.dev',
  };
  const status = await worker.fetch(
    authorized('/v1/referral', 'route-owner-token'), env,
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).shareUrl,
    'https://discipline-api.nomogames.workers.dev/r/A1B2C3D4E5');

  const landing = await worker.fetch(new Request(
    'https://discipline-api.nomogames.workers.dev/r/A1B2C3D4E5',
  ), { ...env, DEPLOYMENT_MAINTENANCE: '1' });
  assert.equal(landing.status, 200);
  const page = await landing.text();
  assert.match(page, /data-platform="android"/);
  assert.match(page,
    /play\.google\.com\/store\/apps\/details\?id=com\.nosiah\.discipline&amp;referrer=discipline_ref%3DA1B2C3D4E5/);
  assert.match(page, /This link will remain the same when it is added/);

  const missing = await worker.fetch(new Request(
    'https://discipline-api.nomogames.workers.dev/r/not-a-code',
  ), env);
  assert.equal(missing.status, 404);
  const deletedCode = await worker.fetch(new Request(
    'https://discipline-api.nomogames.workers.dev/r/DEADBEEF00',
  ), env);
  assert.equal(deletedCode.status, 404);
  assert.doesNotMatch(await deletedCode.text(), /play\.google\.com|You were invited/);
});

test('cheap terminal referral checks run before the platform-proof verifier', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'CheapOwner', 'cheap-owner-token');
  await seedAccount(DB, 2, 'CheapInstall', 'cheap-install-token');
  await seedAccount(DB, 3, 'OldInstall', 'old-install-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  DB.sqlite.prepare("UPDATE accounts SET created_at=datetime('now','-15 days') WHERE id=3").run();
  let proofCalls = 0;
  const env = {
    ...referralEnv(DB),
    [PLATFORM_PROOF_TEST_HOOK]: async () => {
      proofCalls++;
      throw new Error('proof verifier must not run');
    },
  };
  const now = Math.floor(Date.now() / 1000);
  const body = code => addTestProof({
    code, platform: 'android', installReferrer: `discipline_ref=${code}`,
    clickTimestamp: now - 2, installTimestamp: now - 1, installVersion: '1.0.11',
  }, 2);

  const fakeCode = await worker.fetch(authorized(
    '/v1/referral/claim', 'cheap-install-token', await body('DEADBEEF00'),
  ), env);
  assert.equal(fakeCode.status, 404);
  const tooOld = await worker.fetch(authorized(
    '/v1/referral/claim', 'old-install-token', await addTestProof({
      code: 'A1B2C3D4E5', platform: 'android',
      installReferrer: 'discipline_ref=A1B2C3D4E5',
      clickTimestamp: now - 2, installTimestamp: now - 1, installVersion: '1.0.11',
    }, 3),
  ), env);
  assert.equal(tooOld.status, 409);
  const replayKeys = await referralEvidenceKeys(
    env, 'android', 'A1B2C3D4E5', now - 2, now - 1,
  );
  DB.sqlite.prepare('INSERT INTO referral_evidence_fingerprints(evidence_hash) VALUES(?)')
    .run(replayKeys.find(key => key.startsWith('p1_')));
  const replay = await worker.fetch(authorized(
    '/v1/referral/claim', 'cheap-install-token', await body('A1B2C3D4E5'),
  ), env);
  assert.equal(replay.status, 409);
  assert.equal(proofCalls, 0);
});

test('the transactional claim guard catches a referral-code deletion at the mutation boundary', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'RaceOwner', 'race-owner-token');
  await seedAccount(DB, 2, 'RaceInstall', 'race-install-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'ABCDEF1234');
  const now = Math.floor(Date.now() / 1000);
  let proofCalls = 0;
  const env = {
    ...referralEnv(DB),
    [PLATFORM_PROOF_TEST_HOOK]: async () => ({
      platform: 'android', provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
      appVersionCode: 12, requestedAtMs: Date.now(), proofCall: ++proofCalls,
    }),
  };
  DB.beforeBatch = () => DB.sqlite.prepare('DELETE FROM referral_codes WHERE code=?')
    .run('ABCDEF1234');
  const response = await worker.fetch(authorized(
    '/v1/referral/claim', 'race-install-token', await addTestProof({
      code: 'ABCDEF1234', platform: 'android', installReferrer: 'discipline_ref=ABCDEF1234',
      clickTimestamp: now - 2, installTimestamp: now - 1, installVersion: '1.0.11',
    }, 2),
  ), env);
  assert.equal(response.status, 404);
  assert.equal(proofCalls, 1);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM referral_claims').get().count, 0);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM referral_claim_ledger').get().count, 0);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM referral_evidence_fingerprints').get().count, 0);
});

test('active HMAC keys rotate out without reopening stable lifetime replay', async () => {
  const DB = new D1Database();
  for (const [id, name, token] of [
    [1, 'RotationOwner', 'rotation-owner-token'],
    [2, 'RotationFirst', 'rotation-first-token'],
    [3, 'RotationReplay', 'rotation-replay-token'],
    [4, 'RotationNew', 'rotation-new-token'],
    [5, 'RotationBad', 'rotation-bad-token'],
  ]) await seedAccount(DB, id, name, token);
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  const oldActive = 'old-active-referral-key-material-at-least-32-bytes';
  const newActive = 'new-active-referral-key-material-at-least-32-bytes';
  const permanentPepper = TEST_EVIDENCE_SECRET;
  const oldEnv = {
    ...referralEnv(DB),
    REFERRAL_EVIDENCE_HMAC_KEYRING_JSON: JSON.stringify({
      current: 'old', keys: { old: oldActive },
    }),
    REFERRAL_EVIDENCE_REPLAY_PEPPER: permanentPepper,
  };
  const now = Math.floor(Date.now() / 1000);
  const evidence = {
    code: 'A1B2C3D4E5', platform: 'android',
    installReferrer: 'discipline_ref=A1B2C3D4E5',
    clickTimestamp: now - 8, installTimestamp: now - 7, installVersion: '1.0.11',
  };
  const first = await worker.fetch(authorized(
    '/v1/referral/claim', 'rotation-first-token', await addTestProof(evidence, 2),
  ), oldEnv);
  assert.equal(first.status, 201);
  assert.match(DB.sqlite.prepare(`SELECT evidence_key FROM referral_claim_ledger
    WHERE referred_account_id=2`).get().evidence_key, /^h1k_old_/);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_evidence_fingerprints
    WHERE evidence_hash LIKE 'p1_%'`).get().count, 1);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_evidence_fingerprints
    WHERE substr(evidence_hash,1,3)='h1_'`).get().count, 1);

  let rotatedProofCalls = 0;
  const rotatedEnv = {
    ...oldEnv,
    REFERRAL_EVIDENCE_HMAC_KEYRING_JSON: JSON.stringify({
      current: 'new', keys: { new: newActive },
    }),
    [PLATFORM_PROOF_TEST_HOOK]: async () => ({
      platform: 'android', provider: GOOGLE_PLAY_INTEGRITY_PROVIDER,
      appVersionCode: 12, requestedAtMs: Date.now(), proofCall: ++rotatedProofCalls,
    }),
  };
  const replay = await worker.fetch(authorized(
    '/v1/referral/claim', 'rotation-replay-token', await addTestProof(evidence, 3),
  ), rotatedEnv);
  assert.equal(replay.status, 409);
  assert.equal(rotatedProofCalls, 0);
  const newClaim = await worker.fetch(authorized(
    '/v1/referral/claim', 'rotation-new-token', await addTestProof({
      ...evidence, clickTimestamp: now - 4, installTimestamp: now - 3,
    }, 4),
  ), rotatedEnv);
  assert.equal(newClaim.status, 201);
  assert.match(DB.sqlite.prepare(`SELECT evidence_key FROM referral_claim_ledger
    WHERE referred_account_id=4`).get().evidence_key, /^h1k_new_/);
  assert.equal(rotatedProofCalls, 1);

  const changedPepper = await worker.fetch(authorized(
    '/v1/referral/claim', 'rotation-bad-token', await addTestProof({
      ...evidence, clickTimestamp: now - 2, installTimestamp: now - 1,
    }, 5),
  ), {
    ...rotatedEnv,
    REFERRAL_EVIDENCE_REPLAY_PEPPER: 'incorrect-replacement-pepper-material-at-least-32-bytes',
  });
  assert.equal(changedPepper.status, 503);
  assert.deepEqual(await changedPepper.json(), {
    ok: false, error: 'referral_evidence_not_configured',
  });
  assert.equal(rotatedProofCalls, 1);
});

test('referral readiness validates live keyring values and permanent pepper registry during maintenance', async () => {
  const DB = new D1Database();
  const env = { ...referralEnv(DB), DEPLOYMENT_MAINTENANCE: '1' };
  const ready = await worker.fetch(new Request(
    'https://api.example/v1/referral/readiness',
  ), env);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true });
  const registered = DB.sqlite.prepare(`SELECT key_id,legacy_unversioned
    FROM referral_evidence_key_registry`).all().map(row => ({ ...row }));
  assert.deepEqual(registered, [{ key_id: 'replay-pepper-v1', legacy_unversioned: 1 }]);

  for (const invalid of [
    { ...env, REFERRAL_EVIDENCE_HMAC_KEYRING_JSON: '{' },
    { ...env, REFERRAL_EVIDENCE_HMAC_KEYRING_JSON: JSON.stringify({
      current: 'missing', keys: { other: TEST_EVIDENCE_SECRET },
    }) },
    { ...env, REFERRAL_EVIDENCE_REPLAY_PEPPER: 'too-short' },
    {
      ...env,
      REFERRAL_EVIDENCE_REPLAY_PEPPER:
        'changed-permanent-replay-pepper-material-at-least-32-bytes',
    },
  ]) {
    const response = await worker.fetch(new Request(
      'https://api.example/v1/referral/readiness',
    ), invalid);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false });
  }

  const incompleteSchemaDB = new D1Database();
  incompleteSchemaDB.sqlite.exec(`DROP TABLE request_rate_limits;
    CREATE TABLE request_rate_limits(bucket TEXT NOT NULL);`);
  const incompleteSchema = await worker.fetch(new Request(
    'https://api.example/v1/referral/readiness',
  ), { ...referralEnv(incompleteSchemaDB), DEPLOYMENT_MAINTENANCE: '1' });
  assert.equal(incompleteSchema.status, 503);
  assert.deepEqual(await incompleteSchema.json(), { ready: false });
});

async function invalidProofAttempt(env, token, accountId, now, ip = '') {
  return worker.fetch(authorized(
    '/v1/referral/claim', token, await addTestProof({
      code: 'A1B2C3D4E5', platform: 'android',
      installReferrer: 'discipline_ref=A1B2C3D4E5',
      clickTimestamp: now - 2, installTimestamp: now - 1,
      installVersion: '1.0.11',
    }, accountId),
    ip ? { 'CF-Connecting-IP': ip } : {},
  ), env);
}

function invalidProofThrottleEnv(DB, limits, proofCounter) {
  return {
    ...referralEnv(DB),
    [REFERRAL_RATE_LIMIT_TEST_HOOK]: { windowSeconds: 3600, ...limits },
    [PLATFORM_PROOF_TEST_HOOK]: async () => {
      proofCounter.calls++;
      throw new PlatformProofError('invalid_platform_proof', 422);
    },
  };
}

test('referral account and source-IP limits stop proof calls before Google quota is consumed', async () => {
  const now = Math.floor(Date.now() / 1000);

  const accountDB = new D1Database();
  await seedAccount(accountDB, 1, 'ThrottleOwnerA', 'throttle-owner-a');
  await seedAccount(accountDB, 2, 'ThrottleInstallA', 'throttle-install-a');
  accountDB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  const accountProofs = { calls: 0 };
  const accountEnv = invalidProofThrottleEnv(accountDB, {
    account: 2, ip: 20, codeIp: 20,
  }, accountProofs);
  assert.equal((await invalidProofAttempt(
    accountEnv, 'throttle-install-a', 2, now,
  )).status, 422);
  assert.equal((await invalidProofAttempt(
    accountEnv, 'throttle-install-a', 2, now,
  )).status, 422);
  const accountLimited = await invalidProofAttempt(
    accountEnv, 'throttle-install-a', 2, now,
  );
  assert.equal(accountLimited.status, 429);
  assert.deepEqual(await accountLimited.json(), {
    ok: false, error: 'referral_rate_limited',
  });
  assert.equal(accountProofs.calls, 2);

  const ipDB = new D1Database();
  await seedAccount(ipDB, 1, 'ThrottleOwnerIp', 'throttle-owner-ip');
  ipDB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  for (let id = 2; id <= 4; id++)
    await seedAccount(ipDB, id, `ThrottleIp${id}`, `throttle-ip-${id}`);
  const ipProofs = { calls: 0 };
  const ipEnv = invalidProofThrottleEnv(ipDB, {
    account: 20, ip: 2, codeIp: 20,
  }, ipProofs);
  assert.equal((await invalidProofAttempt(ipEnv, 'throttle-ip-2', 2, now, '203.0.113.7')).status, 422);
  assert.equal((await invalidProofAttempt(ipEnv, 'throttle-ip-3', 3, now, '203.0.113.7')).status, 422);
  assert.equal((await invalidProofAttempt(ipEnv, 'throttle-ip-4', 4, now, '203.0.113.7')).status, 429);
  assert.equal(ipProofs.calls, 2);
});

test('a public referral code is scoped per IP rather than globally exhaustible', async () => {
  const DB = new D1Database();
  const now = Math.floor(Date.now() / 1000);
  await seedAccount(DB, 1, 'ViralOwner', 'viral-owner');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  for (let id = 2; id <= 7; id++)
    await seedAccount(DB, id, `ViralInstall${id}`, `viral-install-${id}`);
  const proofs = { calls: 0 };
  const env = invalidProofThrottleEnv(DB, {
    account: 20, ip: 20, codeIp: 2,
  }, proofs);
  for (let id = 2; id <= 6; id++) {
    const result = await invalidProofAttempt(
      env, `viral-install-${id}`, id, now, `203.0.113.${id}`,
    );
    assert.equal(result.status, 422,
      'distinct source IPs must not consume one global public-code bucket');
  }
  assert.equal(proofs.calls, 5);

  // A single source still cannot burn unlimited verification calls for the
  // same public code, even when it rotates through free accounts.
  assert.equal((await invalidProofAttempt(
    env, 'viral-install-2', 2, now, '198.51.100.9',
  )).status, 422);
  assert.equal((await invalidProofAttempt(
    env, 'viral-install-3', 3, now, '198.51.100.9',
  )).status, 422);
  assert.equal((await invalidProofAttempt(
    env, 'viral-install-7', 7, now, '198.51.100.9',
  )).status, 429);
  assert.equal(proofs.calls, 7);
  const storedSubjects = DB.sqlite.prepare(`SELECT subject_hash
    FROM request_rate_limits`).all().map(row => String(row.subject_hash));
  assert.ok(storedSubjects.length > 0);
  assert.ok(storedSubjects.every(value => /^[A-Za-z0-9_-]{43}$/.test(value)));
  assert.doesNotMatch(JSON.stringify(storedSubjects), /A1B2C3D4E5|203\.0\.113|198\.51\.100/);
});

test('registration source-IP throttling is durable and precedes password hashing', async () => {
  const DB = new D1Database();
  const env = {
    ...referralEnv(DB),
    [REFERRAL_RATE_LIMIT_TEST_HOOK]: {
      account: 20, ip: 20, codeIp: 20, registerIp: 2, windowSeconds: 3600,
    },
    LEGAL_PUBLISHER_NAME: 'Nomogames',
    LEGAL_CONTACT_EMAIL: 'privacy@example.test',
    LEGAL_EFFECTIVE_DATE: '2026-08-24',
    LEGAL_RETENTION_NOTICE: 'Test retention.',
    LEGAL_TARGET_AUDIENCE_NOTICE: 'Test audience.',
  };
  const request = () => worker.fetch(new Request('https://api.example/v1/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.44',
    },
    body: JSON.stringify({
      username: '!', password: 'not-used-password',
      acceptTerms: false, termsVersion: 'wrong',
    }),
  }), env);
  assert.equal((await request()).status, 400);
  assert.equal((await request()).status, 400);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), {
    ok: false, error: 'registration_rate_limited',
  });
});

test('a legacy Android v1 tombstone still blocks a normalized claim after raw deletion', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'LegacyReferrer', 'legacy-referrer-token');
  await seedAccount(DB, 2, 'ReplayAttempt', 'replay-attempt-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'ABCDEF1234');
  const installTimestamp = Math.floor(Date.now() / 1000);
  const clickTimestamp = installTimestamp - 7;
  const tombstone = await legacyAndroidEvidenceKey(
    'ABCDEF1234', clickTimestamp, installTimestamp,
  );
  DB.sqlite.prepare(`INSERT INTO referral_evidence_fingerprints(evidence_hash)
    VALUES(?)`).run(tombstone);

  const response = await worker.fetch(authorized(
    '/v1/referral/claim', 'replay-attempt-token', await addTestProof({
      code: 'ABCDEF1234',
      platform: 'android',
      installReferrer: 'discipline_ref=ABCDEF1234',
      clickTimestamp,
      installTimestamp,
      installVersion: '1.0.11',
    }, 2),
  ), referralEnv(DB));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false, error: 'install_evidence_already_used',
  });
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_claims
    WHERE referred_account_id=2`).get().count, 0);
});

test('migration-chain referred-account deletion derives the legacy v1 tombstone before erasure', async () => {
  const { DB, clickTimestamp, installTimestamp } = await migratedLegacyReferralFixture();
  const env = referralEnv(DB);
  assert.match(DB.sqlite.prepare(`SELECT evidence_key FROM referral_claim_ledger
    WHERE referred_account_id=2`).get().evidence_key, /^legacy_/);

  const { response: deleted } = await deleteAccountFully(env, 'legacy-install-token');
  assert.equal(deleted.status, 200);
  const expectedTombstone = await legacyAndroidEvidenceKey(
    'A1B2C3D4E5', clickTimestamp, installTimestamp,
  );
  assert.ok(DB.sqlite.prepare(`SELECT evidence_hash FROM referral_evidence_fingerprints
    WHERE evidence_hash=?`).get(expectedTombstone));
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_claims
    WHERE referred_account_id=2`).get().count, 0);

  const replay = await worker.fetch(authorized(
    '/v1/referral/claim', 'replay-install-token', await addTestProof({
      code: 'A1B2C3D4E5', platform: 'android',
      installReferrer: 'discipline_ref=A1B2C3D4E5',
      clickTimestamp, installTimestamp, installVersion: '1.0.11',
    }, 3),
  ), env);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), {
    ok: false, error: 'install_evidence_already_used',
  });
});

test('migration-chain referrer-account deletion tombstones every removed legacy claim', async () => {
  const { DB, clickTimestamp, installTimestamp } = await migratedLegacyReferralFixture(true);
  const env = referralEnv(DB);
  const { response: deleted } = await deleteAccountFully(env, 'legacy-owner-token');
  assert.equal(deleted.status, 200);
  const expectedTombstone = await legacyAndroidEvidenceKey(
    'A1B2C3D4E5', clickTimestamp, installTimestamp,
  );
  assert.ok(DB.sqlite.prepare(`SELECT evidence_hash FROM referral_evidence_fingerprints
    WHERE evidence_hash=?`).get(expectedTombstone));
  const secondTombstone = await legacyAndroidEvidenceKey(
    'A1B2C3D4E5', clickTimestamp + 2, installTimestamp + 2,
  );
  assert.ok(DB.sqlite.prepare(`SELECT evidence_hash FROM referral_evidence_fingerprints
    WHERE evidence_hash=?`).get(secondTombstone));
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_claims
    WHERE referrer_account_id=1`).get().count, 0);

  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(4, 'A1B2C3D4E5');
  const replay = await worker.fetch(authorized(
    '/v1/referral/claim', 'replay-install-token', await addTestProof({
      code: 'A1B2C3D4E5', platform: 'android',
      installReferrer: 'discipline_ref=A1B2C3D4E5',
      clickTimestamp, installTimestamp, installVersion: '1.0.11',
    }, 3),
  ), env);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), {
    ok: false, error: 'install_evidence_already_used',
  });
});

test('legacy claim deletion fails closed before mutation when exact HMAC derivation is unavailable', async () => {
  const { DB } = await migratedLegacyReferralFixture();
  const response = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE', headers: { Authorization: 'Bearer legacy-install-token' },
  }), { DB, [PLATFORM_PROOF_TEST_HOOK]: referralEnv(DB)[PLATFORM_PROOF_TEST_HOOK] });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false, error: 'account_deletion_temporarily_unavailable',
  });
  assert.ok(DB.sqlite.prepare('SELECT id FROM accounts WHERE id=2').get());
  assert.ok(DB.sqlite.prepare(`SELECT referred_account_id FROM referral_claims
    WHERE referred_account_id=2`).get());
});

test('legacy claim deletion fails closed when stored evidence cannot be canonically derived', async () => {
  const { DB } = await migratedLegacyReferralFixture();
  DB.sqlite.prepare(`UPDATE referral_claims SET install_timestamp='corrupt'
    WHERE referred_account_id=2`).run();
  const response = await worker.fetch(new Request('https://api.example/v1/account', {
    method: 'DELETE', headers: { Authorization: 'Bearer legacy-install-token' },
  }), referralEnv(DB));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false, error: 'account_deletion_temporarily_unavailable',
  });
  assert.ok(DB.sqlite.prepare('SELECT id FROM accounts WHERE id=2').get());
  assert.ok(DB.sqlite.prepare(`SELECT referred_account_id FROM referral_claims
    WHERE referred_account_id=2`).get());
});

test('many-claim deletion resumes in bounded pages with multiple active keys', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'BulkDeleteOwner', 'bulk-delete-owner-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, 'A1B2C3D4E5');
  const env = {
    ...referralEnv(DB),
    REFERRAL_EVIDENCE_HMAC_KEYRING_JSON: JSON.stringify({
      current: 'current',
      keys: {
        current: 'bulk-current-referral-key-material-at-least-32-bytes',
        retired1: 'bulk-retired-one-key-material-at-least-32-bytes',
        retired2: 'bulk-retired-two-key-material-at-least-32-bytes',
      },
    }),
  };
  const now = Math.floor(Date.now() / 1000);
  for (let index = 0; index < 20; index++) {
    const referredId = index + 2;
    await seedAccount(DB, referredId, `BulkSource${referredId}`, `bulk-source-${referredId}`);
    const claim = {
      referralCode: 'A1B2C3D4E5', platform: 'android',
      attributionProvider: GOOGLE_PLAY_INSTALL_REFERRER_PROVIDER,
      attributionVersion: GOOGLE_PLAY_ATTRIBUTION_VERSION,
      firstTouchAt: now - 100 + index * 2,
      installedAt: now - 99 + index * 2,
      installedVersion: '1.0.11',
      evidenceId: `${now - 100 + index * 2}:${now - 99 + index * 2}`,
    };
    const evidenceKey = await referralEvidenceKey(env, claim);
    DB.sqlite.prepare(`INSERT INTO referral_claim_ledger(
      evidence_key,referred_account_id,referrer_account_id
    ) VALUES(?,?,?)`).run(evidenceKey, referredId, 1);
    DB.sqlite.prepare(`INSERT INTO referral_claims(
      referred_account_id,referrer_account_id,referral_code,platform,
      click_timestamp,install_timestamp,install_version,proof_provider,
      proof_app_version_code,attribution_provider,attribution_version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      referredId, 1, claim.referralCode, claim.platform,
      claim.firstTouchAt, claim.installedAt, claim.installedVersion,
      GOOGLE_PLAY_INTEGRITY_PROVIDER, 12,
      claim.attributionProvider, claim.attributionVersion,
    );
  }

  const statuses = [];
  const operationCounts = [];
  for (let requestIndex = 0; requestIndex < 10; requestIndex++) {
    DB.executed = 0;
    const response = await worker.fetch(new Request('https://api.example/v1/account', {
      method: 'DELETE', headers: { Authorization: 'Bearer bulk-delete-owner-token' },
    }), env);
    statuses.push(response.status);
    operationCounts.push(DB.executed);
    if (requestIndex === 0) {
      const hidden = await worker.fetch(new Request(
        'https://api.example/r/A1B2C3D4E5',
      ), env);
      assert.equal(hidden.status, 404, 'deleting referrers must stop inviting immediately');
    }
    if (response.status !== 202) break;
  }
  assert.deepEqual(statuses, [202, 202, 202, 200]);
  assert.ok(operationCounts.every(count => count < 50), operationCounts.join(','));
  assert.ok(DB.batchSizes.every(size => size < 50), DB.batchSizes.join(','));
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts WHERE id=1').get().count, 0);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM referral_claims WHERE referrer_account_id=1').get().count, 0);
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_evidence_fingerprints
    WHERE evidence_hash LIKE 'p1_%'`).get().count, 20);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM account_deletion_jobs').get().count, 0);
});

test('referral hardening migration backfills rewards and preserves duplicate legacy entitlements', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id INTEGER PRIMARY KEY);
    INSERT INTO accounts VALUES(1),(2),(3);
    CREATE TABLE referral_claims(
      referred_account_id INTEGER PRIMARY KEY,
      referrer_account_id INTEGER NOT NULL,
      referral_code TEXT NOT NULL,
      platform TEXT NOT NULL,
      click_timestamp INTEGER NOT NULL,
      install_timestamp INTEGER NOT NULL,
      install_version TEXT NOT NULL DEFAULT '',
      claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE referral_rewards(
      referred_account_id INTEGER PRIMARY KEY,
      referrer_account_id INTEGER NOT NULL,
      reward_index INTEGER NOT NULL,
      cosmetic_id TEXT NOT NULL,
      awarded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO referral_claims VALUES
      (2,1,'A1B2C3D4E5','android',100,105,'1.0.10',datetime('now')),
      (3,1,'A1B2C3D4E5','android',100,105,'1.0.10',datetime('now'));
    INSERT INTO referral_rewards VALUES
      (2,1,1,'orn_napkin',datetime('now')),
      (3,1,2,'goop_gold',datetime('now'));
  `);
  sqlite.exec(readFileSync(new URL('../server/migrations/0009_referral_hardening.sql', import.meta.url), 'utf8'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM referral_claim_ledger').get().count, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM referral_reward_ledger').get().count, 2);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_claim_ledger
    WHERE evidence_key LIKE 'legacy_%'`).get().count, 2);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_claim_ledger
    WHERE evidence_key LIKE '%A1B2C3D4E5%'`).get().count, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM referral_evidence_fingerprints`).get().count, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('referral_claims')
    WHERE name IN ('proof_provider','proof_app_version_code')`).get().count, 2);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('referral_claims')
    WHERE name IN ('attribution_provider','attribution_version')`).get().count, 0);
  sqlite.exec(readFileSync(new URL(
    '../server/migrations/0012_referral_provider_boundary.sql', import.meta.url,
  ), 'utf8'));
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('referral_claims')
    WHERE name IN ('proof_provider','proof_app_version_code',
      'attribution_provider','attribution_version')`).get().count, 4);
  const migratedProvider = sqlite.prepare(`SELECT DISTINCT
    attribution_provider,attribution_version FROM referral_claims`).get();
  assert.equal(migratedProvider.attribution_provider, 'legacy');
  assert.equal(migratedProvider.attribution_version, 'legacy');
});

test('the complete migration chain reaches referral proof and PvP schema parity', () => {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../server/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  const referralColumns = sqlite.prepare(`SELECT name FROM pragma_table_info('referral_claims')`)
    .all().map(row => row.name);
  assert.ok(referralColumns.includes('proof_provider'));
  assert.ok(referralColumns.includes('proof_app_version_code'));
  assert.ok(referralColumns.includes('attribution_provider'));
  assert.ok(referralColumns.includes('attribution_version'));
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='referral_evidence_fingerprints'`).get());
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='account_deletion_jobs'`).get());
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='referral_evidence_key_registry'`).get());
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='request_rate_limits'`).get());
  const ledgerColumns = sqlite.prepare(`SELECT name FROM pragma_table_info('referral_claim_ledger')`)
    .all().map(row => row.name);
  assert.equal(ledgerColumns.includes('referral_code'), false);
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_pvp_matches_status_created'`).get());
  assert.ok(sqlite.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_pvp_matches_status_updated'`).get());
});

test('deleting a referred account cannot reopen the ten-reward lifetime cap', async () => {
  const DB = new D1Database();
  await seedAccount(DB, 1, 'CapOwner', 'cap-owner-token');
  DB.sqlite.prepare('INSERT INTO referral_codes(account_id,code) VALUES(?,?)')
    .run(1, '112233AABB');
  const now = Math.floor(Date.now() / 1000);
  const env = referralEnv(DB);

  for (let index = 0; index < 11; index++) {
    const id = index + 2;
    const token = `cap-source-${id}`;
    await seedAccount(DB, id, `CapSource${id}`, token);
    if (index === 10) {
      // Delete a source after its award, then prove referral eleven cannot
      // occupy the supposedly freed slot.
      const { response: deleted } = await deleteAccountFully(env, 'cap-source-2');
      assert.equal(deleted.status, 200);
    }
    const response = await worker.fetch(
      authorized('/v1/referral/claim', token, await addTestProof({
        code: '112233AABB',
        installReferrer: 'discipline_ref=112233AABB',
        platform: 'android',
        clickTimestamp: now - 100 + index * 2,
        installTimestamp: now - 99 + index * 2,
        installVersion: '1.0.11',
      }, id)), env,
    );
    if (index < 10) {
      assert.equal(response.status, 201);
      assert.equal((await response.json()).rewardedReferrer, true);
    } else {
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), {
        ok: true, rewardedReferrer: false, rewardLimitReached: true,
      });
    }
  }

  const rewards = DB.sqlite.prepare(`SELECT reward_index FROM referral_reward_ledger
    WHERE referrer_account_id=1 ORDER BY reward_index`).all();
  assert.equal(rewards.length, 10);
  assert.deepEqual(rewards.map(row => row.reward_index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
