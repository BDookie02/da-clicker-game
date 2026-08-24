import { Capacitor, registerPlugin } from '@capacitor/core';
import type { AccountService, GooglePlayReferralAttribution, ReferralEvidence } from './account';

interface InstallReferrerResult {
  installReferrer: string;
  clickTimestamp: number;
  installTimestamp: number;
  installVersion: string;
}

interface PlatformProofResult {
  provider: string;
  token: string;
}

const InstallReferrer = registerPlugin<{
  get(options: { timeoutMs: number }): Promise<InstallReferrerResult>;
}>(
  'DisciplineInstallReferrer',
);
const PlatformProof = registerPlugin<{
  get(options: { requestHash: string }): Promise<PlatformProofResult>;
}>('DisciplinePlatformProof');
const REQUEST_HASH_VERSION = 'referral_claim_v1' as const;
// Bump this contract marker when a future client changes terminal semantics;
// that lets a fixed app retry without asking a player to clear app storage.
const PROCESSED_STORAGE_VERSION = 'v2';
const processedKey = (accountId: string) =>
  `discipline-referral-processed-${PROCESSED_STORAGE_VERSION}:${accountId}`;
const CLIENT_RETRY_DELAYS_MS = [1_000, 2_000] as const;
export const REFERRAL_CLAIM_WALL_CLOCK_TIMEOUT_MS = 20_000;
const inFlightClaims = new Map<string, Promise<boolean>>();
const TERMINAL_CLAIM_ERRORS = new Set([
  'invalid_request_hash',
  'invalid_referral_evidence',
  'invalid_referral',
  'referral_mismatch',
  'invalid_install_evidence',
  'new_account_required',
  'invalid_platform_proof',
  'unsupported_platform_proof',
  'referral_not_found',
  'self_referral',
  'referral_already_claimed',
  'install_evidence_already_used',
]);
const TRANSIENT_CLAIM_ERRORS = new Set([
  'install_referrer_unavailable',
  'install_referrer_disconnected',
  'install_referrer_timeout',
  'play_integrity_transient',
  'platform_proof_unavailable',
  'referral_proof_unavailable',
  'referral_unavailable',
  'referral_reward_busy',
]);

function normalizedInteger(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error('invalid_referral_evidence');
  return numeric;
}

/** Stable serialization for the Android attribution adapter. A future iOS
 * adapter owns its own canonical request while the server normalizes both
 * providers before referral/reward logic sees the claim. */
export function canonicalReferralClaim(
  accountId: string,
  code: string,
  evidence: GooglePlayReferralAttribution,
): string {
  const encoded = (value: string) => encodeURIComponent(value);
  return [
    REQUEST_HASH_VERSION,
    `account_id=${encoded(accountId)}`,
    'platform=android',
    `referral_code=${encoded(code)}`,
    `install_referrer=${encoded(evidence.installReferrer)}`,
    `click_timestamp=${evidence.clickTimestamp}`,
    `install_timestamp=${evidence.installTimestamp}`,
    `install_version=${encoded(evidence.installVersion)}`,
  ].join('\n');
}

export async function referralRequestHash(
  accountId: string,
  code: string,
  evidence: GooglePlayReferralAttribution,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalReferralClaim(accountId, code, evidence)),
  ));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const sleep = (delayMs: number) => new Promise<void>(resolve => globalThis.setTimeout(resolve, delayMs));

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'code' in error)
    return String((error as { code?: unknown }).code || '');
  return String(error || '');
}

/** Provider-neutral retry boundary. Android and future iOS adapters each
 * produce a proof; this layer only decides whether the complete claim should
 * be attempted again. */
interface ReferralRetryOptions {
  wait?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
}

function boundedOperation<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error('referral_claim_timeout')), timeoutMs,
    );
    Promise.resolve().then(operation).then(
      value => { globalThis.clearTimeout(timer); resolve(value); },
      error => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

export function persistTerminalReferralFailure(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  error: unknown,
): boolean {
  const code = errorCode(error);
  if (!TERMINAL_CLAIM_ERRORS.has(code)) return false;
  storage.setItem(key, `terminal:${code}`);
  return true;
}

export async function retryReferralClaim<T>(
  operation: (remainingMs: number) => Promise<T>,
  options: ReferralRetryOptions = {},
): Promise<T> {
  const wait = options.wait ?? sleep;
  const timeoutMs = Math.max(1, Math.min(
    REFERRAL_CLAIM_WALL_CLOCK_TIMEOUT_MS,
    Math.trunc(options.timeoutMs ?? REFERRAL_CLAIM_WALL_CLOCK_TIMEOUT_MS),
  ));
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      return await boundedOperation(() => operation(remainingMs), remainingMs);
    } catch (error) {
      const code = errorCode(error);
      if (TERMINAL_CLAIM_ERRORS.has(code)
          || !TRANSIENT_CLAIM_ERRORS.has(code)
          || attempt >= CLIENT_RETRY_DELAYS_MS.length
          || Date.now() >= deadline) throw error;
      const delayMs = Math.min(CLIENT_RETRY_DELAYS_MS[attempt], deadline - Date.now());
      if (delayMs <= 0) throw new Error('referral_claim_timeout');
      await boundedOperation(() => wait(delayMs), Math.max(1, deadline - Date.now()));
    }
  }
}

async function performInstallReferralClaim(
  account: AccountService,
  accountId: string,
  key: string,
): Promise<boolean> {
  let evidence: InstallReferrerResult | undefined;
  try {
    return await retryReferralClaim(async remainingMs => {
      // The native connection times out before this attempt's remaining TS
      // budget, so no abandoned Play-service client survives the wall clock.
      evidence ??= await InstallReferrer.get({ timeoutMs: Math.max(250, remainingMs - 250) });
      const params = new URLSearchParams(evidence.installReferrer || '');
      const code = (params.get('discipline_ref') || '').trim().toUpperCase();
      if (!/^[A-F0-9]{10}$/.test(code)) {
        localStorage.setItem(key, 'no_referral');
        return false;
      }
      const attribution: GooglePlayReferralAttribution = {
        provider: 'google_play_install_referrer',
        version: 'google_play_install_referrer_v1',
        installReferrer: evidence.installReferrer,
        clickTimestamp: normalizedInteger(evidence.clickTimestamp),
        installTimestamp: normalizedInteger(evidence.installTimestamp),
        installVersion: String(evidence.installVersion || ''),
      };
      const requestHash = await referralRequestHash(accountId, code, attribution);
      const nativeProof = await PlatformProof.get({ requestHash });
      if (nativeProof.provider !== 'google_play_integrity' || !nativeProof.token)
        throw new Error('referral_proof_unavailable');
      const payload: ReferralEvidence = {
        referralCode: code,
        platform: 'android',
        attribution,
        proof: {
          provider: 'google_play_integrity',
          token: nativeProof.token,
          requestHashVersion: REQUEST_HASH_VERSION,
        },
      };
      await account.claimReferral(payload);
      localStorage.setItem(key, 'claimed');
      return true;
    });
  } catch (error) {
    persistTerminalReferralFailure(localStorage, key, error);
    throw error;
  }
}

export async function claimInstallReferral(account: AccountService): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android' || !account.accountId)
    return false;
  const accountId = account.accountId;
  const key = processedKey(accountId);
  if (localStorage.getItem(key) !== null) return false;
  const pending = inFlightClaims.get(accountId);
  if (pending) return pending;
  const claim = performInstallReferralClaim(account, accountId, key)
    .finally(() => inFlightClaims.delete(accountId));
  inFlightClaims.set(accountId, claim);
  return claim;
}

export async function shareReferral(url: string, code: string): Promise<void> {
  const text = `Try DISCIPLINE. Install with my verified referral link to unlock a random shop item for me. Referral code: ${code}.`;
  if (navigator.share) {
    await navigator.share({ title: 'DISCIPLINE.', text, url });
    return;
  }
  await navigator.clipboard.writeText(`${text}\n${url}`);
}
