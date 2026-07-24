import { SAVE_KEY } from './config';
import { createFreshSave, type SaveData } from './state';
import {
  clearPendingPurchasesForAccount,
  pendingPurchases,
  queuePendingPurchase,
  removePendingPurchase,
  type PurchaseReceipt,
} from './purchases';

export const TOKEN_KEY = 'discipline-account-token-v1';
const USER_KEY = 'discipline-account-username-v1';
const ACCOUNT_ID_KEY = 'discipline-account-id-v1';
const TERMS_VERSION_KEY = 'discipline-account-terms-version-v1';
const TERMS_CURRENT_KEY = 'discipline-account-terms-current-v1';
const SYNCED_ACCOUNT_KEY = 'discipline-synced-account-v1';
const LEGACY_PENDING_PURCHASE_KEY = 'discipline-pending-purchase-v1';
const ACCOUNT_SAVE_PREFIX = 'discipline-account-save-v1:';
const PENDING_AD_PREFIX = 'discipline-pending-ad-rewards-v1:';

export interface AccountIdentity {
  id: string;
  username: string;
  termsVersion: string | null;
  termsCurrent: boolean;
}
export interface LegalConfig {
  termsVersion: string;
  termsUrl: string;
  privacyUrl: string;
}
export interface PurchaseGrant { amount: number; transactionId: string }
export type AdRewardKind = 'm' | 'boost' | 'offline';
export interface AdVerification {
  userId: string;
  customData: string;
  nonce: string;
  kind: AdRewardKind;
}
export interface PendingAdReward {
  nonce: string;
  kind: AdRewardKind;
  watchedSeconds: number;
  bonusRespect: number;
  createdAt: number;
}
export interface AdRewardStatus {
  verified: boolean;
  nonce: string;
  kind: AdRewardKind;
  transactionId?: string;
}

async function accountUuid(accountId: string): Promise<string> {
  const seed = new TextEncoder().encode(`discipline-account:${accountId}`);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', seed)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function accountSaveKey(accountId: string) {
  return `${ACCOUNT_SAVE_PREFIX}${accountId}`;
}

function pendingAdKey(accountId: string) {
  return `${PENDING_AD_PREFIX}${accountId}`;
}

function parseSave(raw: string | null): SaveData | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as SaveData : null;
  } catch {
    return null;
  }
}

export class AccountService {
  token = localStorage.getItem(TOKEN_KEY) ?? '';
  username = localStorage.getItem(USER_KEY) ?? '';
  accountId = localStorage.getItem(ACCOUNT_ID_KEY) ?? '';
  termsVersion: string | null = localStorage.getItem(TERMS_VERSION_KEY);
  termsCurrent = localStorage.getItem(TERMS_CURRENT_KEY) === '1';
  revision = 0;
  private saving = false;
  private cloudReadyAccountId = '';
  private legalCache: LegalConfig | null = null;

  constructor(readonly apiUrl: string) {}

  get signedIn() { return !!this.token; }
  /** True only after this exact authenticated account has completed save
   * selection/reconciliation in the current page lifetime. */
  get cloudReady() {
    return Boolean(this.accountId && this.cloudReadyAccountId === this.accountId);
  }
  get cachedIdentity(): AccountIdentity | null {
    return this.token && this.username && this.accountId
      ? {
        id: this.accountId,
        username: this.username,
        termsVersion: this.termsVersion,
        termsCurrent: this.termsCurrent,
      }
      : null;
  }
  private headers(json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }
  private applyIdentity(account: AccountIdentity): AccountIdentity {
    const nextAccountId = String(account.id);
    if (this.accountId !== nextAccountId) this.cloudReadyAccountId = '';
    this.username = account.username;
    this.accountId = nextAccountId;
    this.termsVersion = account.termsVersion ? String(account.termsVersion) : null;
    this.termsCurrent = account.termsCurrent === true;
    localStorage.setItem(USER_KEY, this.username);
    localStorage.setItem(ACCOUNT_ID_KEY, this.accountId);
    if (this.termsVersion) localStorage.setItem(TERMS_VERSION_KEY, this.termsVersion);
    else localStorage.removeItem(TERMS_VERSION_KEY);
    localStorage.setItem(TERMS_CURRENT_KEY, this.termsCurrent ? '1' : '0');
    return {
      id: this.accountId,
      username: this.username,
      termsVersion: this.termsVersion,
      termsCurrent: this.termsCurrent,
    };
  }
  markTermsOutdated() {
    this.termsCurrent = false;
    this.legalCache = null;
    localStorage.setItem(TERMS_CURRENT_KEY, '0');
  }
  private async auth(path: string, username: string, password: string, termsVersion?: string): Promise<AccountIdentity> {
    const res = await fetch(`${this.apiUrl}/v1/auth/${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        username,
        password,
        ...(path === 'register' ? { acceptTerms: true, termsVersion } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'account_unavailable');
    this.token = data.token;
    localStorage.setItem(TOKEN_KEY, this.token);
    return this.applyIdentity(data.account);
  }
  register(username: string, password: string, termsVersion: string) {
    return this.auth('register', username, password, termsVersion);
  }
  login(username: string, password: string) { return this.auth('login', username, password); }
  async legalConfig(): Promise<LegalConfig> {
    if (this.legalCache) return this.legalCache;
    const res = await fetch(`${this.apiUrl}/v1/legal`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.termsVersion !== 'string' || !data.termsVersion)
      throw new Error('legal_unavailable');
    const absolute = (path: unknown, fallback: string) =>
      new URL(typeof path === 'string' ? path : fallback, `${this.apiUrl}/`).toString();
    this.legalCache = {
      termsVersion: data.termsVersion,
      termsUrl: absolute(data.termsPath, '/terms'),
      privacyUrl: absolute(data.privacyPath, '/privacy'),
    };
    return this.legalCache;
  }
  logout() {
    this.token = ''; this.username = ''; this.accountId = ''; this.revision = 0;
    this.cloudReadyAccountId = '';
    this.termsVersion = null; this.termsCurrent = false;
    localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); localStorage.removeItem(ACCOUNT_ID_KEY);
    localStorage.removeItem(TERMS_VERSION_KEY); localStorage.removeItem(TERMS_CURRENT_KEY);
  }
  async verify(): Promise<AccountIdentity | null> {
    if (!this.token) return null;
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/v1/account`, { headers: this.headers() });
    } catch {
      throw new Error('network_unavailable');
    }
    if (!res.ok) {
      if (res.status === 401) { this.logout(); return null; }
      throw new Error('account_unavailable');
    }
    const { account } = await res.json();
    return this.applyIdentity(account);
  }

  async acceptTerms(version: string): Promise<AccountIdentity> {
    if (!this.token) throw new Error('login_required');
    const res = await fetch(`${this.apiUrl}/v1/account/terms`, {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify({ accepted: true, version }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'terms_unavailable');
    return this.applyIdentity(data.account);
  }

  async reportPlayer(playerRef: string, reason: string, details = ''): Promise<boolean> {
    const res = await fetch(`${this.apiUrl}/v1/reports`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ playerRef, reason, details }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 428) this.markTermsOutdated();
    if (!res.ok) throw new Error(data.error ?? 'report_unavailable');
    return data.alreadyReported !== true;
  }

  async blockPlayer(playerRef: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v1/blocks`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ playerRef }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 428) this.markTermsOutdated();
    if (!res.ok) throw new Error(data.error ?? 'block_unavailable');
  }

  async unblockPlayer(playerRef: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v1/blocks/${encodeURIComponent(playerRef)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 428) this.markTermsOutdated();
    if (!res.ok) throw new Error(data.error ?? 'unblock_unavailable');
  }

  /** Bind an ad watch to this account in AdMob's signed SSV callback. */
  async adVerification(kind: AdRewardKind): Promise<AdVerification> {
    if (!this.accountId || !this.signedIn) throw new Error('login_required');
    const nonce = randomUuid();
    return {
      userId: await accountUuid(this.accountId),
      customData: JSON.stringify({
        v: 1,
        accountId: this.accountId,
        nonce,
        kind,
      }),
      nonce,
      kind,
    };
  }
  private pendingAdRewards(): PendingAdReward[] {
    if (!this.accountId) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(pendingAdKey(this.accountId)) || '[]');
      if (!Array.isArray(parsed)) return [];
      const oldest = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return parsed.filter((item): item is PendingAdReward =>
        item && typeof item.nonce === 'string'
        && ['m', 'boost', 'offline'].includes(item.kind)
        && Number.isFinite(item.watchedSeconds)
        && Number.isFinite(item.bonusRespect)
        && Number(item.createdAt) >= oldest).slice(-20);
    } catch { return []; }
  }
  queueAdReward(verification: AdVerification, watchedSeconds: number, bonusRespect = 0) {
    if (!this.accountId) return;
    const pending = this.pendingAdRewards().filter(item => item.nonce !== verification.nonce);
    pending.push({
      nonce: verification.nonce,
      kind: verification.kind,
      watchedSeconds: Math.max(0, Number(watchedSeconds) || 0),
      bonusRespect: Math.max(0, Math.trunc(Number(bonusRespect) || 0)),
      createdAt: Date.now(),
    });
    try {
      localStorage.setItem(pendingAdKey(this.accountId), JSON.stringify(pending.slice(-20)));
    } catch { /* verification still proceeds if storage is unexpectedly full */ }
  }
  clearPendingAdReward(nonce: string) {
    if (!this.accountId) return;
    const key = pendingAdKey(this.accountId);
    try {
      localStorage.setItem(key, JSON.stringify(this.pendingAdRewards().filter(item => item.nonce !== nonce)));
    } catch { /* bounded queue cleanup can retry next launch */ }
  }
  async adRewardStatus(nonce: string, kind: AdRewardKind): Promise<AdRewardStatus> {
    const params = new URLSearchParams({ nonce, kind });
    const res = await fetch(`${this.apiUrl}/v1/admob/reward/status?${params}`, { headers: this.headers() });
    if (res.status === 401) throw new Error('login_required');
    if (!res.ok) throw new Error('reward_verification_unavailable');
    const data = await res.json();
    if (data.nonce !== nonce || data.kind !== kind)
      throw new Error('reward_verification_mismatch');
    return {
      verified: data.verified === true,
      nonce,
      kind,
      transactionId: data.transactionId ? String(data.transactionId) : undefined,
    };
  }
  async waitForAdReward(nonce: string, kind: AdRewardKind, timeoutMs = 12_000): Promise<AdRewardStatus> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      try {
        const remaining = Math.max(1, deadline - Date.now());
        let timer = 0;
        const status = await Promise.race([
          this.adRewardStatus(nonce, kind),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error('reward_verification_timeout')),
              Math.min(2500, remaining));
          }),
        ]).finally(() => window.clearTimeout(timer));
        if (status.verified) return status;
      } catch (error) {
        if ((error as Error).message === 'login_required'
            || (error as Error).message === 'reward_verification_mismatch') throw error;
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 750));
    } while (Date.now() < deadline);
    return { verified: false, nonce, kind };
  }
  async recoverPendingAdRewards(): Promise<PendingAdReward[]> {
    const recovered = await Promise.all(this.pendingAdRewards().map(async (pending) => {
      try {
        const status = await this.waitForAdReward(pending.nonce, pending.kind, 2500);
        return status.verified ? pending : null;
      } catch { /* keep the bounded queue for a later authenticated launch */ }
      return null;
    }));
    return recovered.filter((pending): pending is PendingAdReward => pending !== null);
  }
  /** Atomically rename this account. The database updates the same UNIQUE
   * username row, so success immediately frees the previous name for reuse. */
  async rename(username: string): Promise<AccountIdentity> {
    const res = await fetch(`${this.apiUrl}/v1/account/username`, {
      method: 'PUT', headers: this.headers(true), body: JSON.stringify({ username }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'rename_unavailable');
    this.username = data.account.username;
    localStorage.setItem(USER_KEY, this.username);
    return data.account;
  }
  async deleteAccount(): Promise<void> {
    if (!this.token) throw new Error('login_required');
    const res = await fetch(`${this.apiUrl}/v1/account`, {
      method: 'DELETE', headers: this.headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'delete_unavailable');
    const removedAccountId = this.accountId;
    this.logout();
    localStorage.removeItem(SAVE_KEY);
    localStorage.removeItem(SYNCED_ACCOUNT_KEY);
    if (removedAccountId) localStorage.removeItem(accountSaveKey(removedAccountId));
    if (removedAccountId) localStorage.removeItem(pendingAdKey(removedAccountId));
    await clearPendingPurchasesForAccount(removedAccountId);
  }
  async sync(local: SaveData): Promise<'local' | 'reload'> {
    if (!this.token || !this.accountId) throw new Error('login_required');
    const syncAccountId = this.accountId;
    const syncToken = this.token;
    this.cloudReadyAccountId = '';
    const res = await fetch(`${this.apiUrl}/v1/save`, { headers: this.headers() });
    if (!res.ok) throw new Error('cloud_unavailable');
    if (this.accountId !== syncAccountId || this.token !== syncToken)
      throw new Error('account_changed');
    const data = await res.json(); this.revision = Number(data.revision) || 0;
    const previousAccountId = localStorage.getItem(SYNCED_ACCOUNT_KEY) ?? '';
    const switchingAccounts = Boolean(previousAccountId && previousAccountId !== this.accountId);
    let candidate = local;
    let candidateBelongsToAccount = previousAccountId === this.accountId;

    if (switchingAccounts) {
      // Preserve the outgoing account's latest local state before selecting a
      // save for another identity. Never upload one player's progression into
      // a newly-created account merely because both used this device.
      const outgoing = localStorage.getItem(SAVE_KEY);
      if (outgoing) localStorage.setItem(accountSaveKey(previousAccountId), outgoing);
      const scoped = parseSave(localStorage.getItem(accountSaveKey(this.accountId)));
      if (scoped) {
        candidate = scoped;
        candidateBelongsToAccount = true;
      } else {
        candidate = createFreshSave();
        candidate.tutorialComplete = local.tutorialComplete;
        candidate.textSizeTier = local.textSizeTier;
      }
    }
    if (!candidateBelongsToAccount) {
      const scoped = parseSave(localStorage.getItem(accountSaveKey(this.accountId)));
      if (scoped) {
        candidate = scoped;
        candidateBelongsToAccount = true;
      }
    }
    const previouslySyncedHere = previousAccountId === this.accountId;
    // On the first login for this account on a device, an existing cloud save
    // must win even if the freshly-created local save has a newer timestamp.
    // On later launches, the newest side wins as expected.
    if (data.save && ((!previouslySyncedHere && !candidateBelongsToAccount)
        || Number(data.save.lastSeen) >= Number(candidate.lastSeen))) {
      data.save.username = this.username;
      candidate.username = this.username;
      const cloudJson = JSON.stringify(data.save);
      const alreadyCurrent = cloudJson === JSON.stringify(candidate);
      localStorage.setItem(SAVE_KEY, cloudJson);
      localStorage.setItem(accountSaveKey(this.accountId), cloudJson);
      localStorage.setItem(SYNCED_ACCOUNT_KEY, this.accountId);
      if (alreadyCurrent) {
        this.cloudReadyAccountId = syncAccountId;
        return 'local';
      }
      return 'reload';
    }
    candidate.username = this.username;
    if (!(await this.writeSave(candidate, syncAccountId, true))) throw new Error('cloud_unavailable');
    if (this.accountId !== syncAccountId || this.token !== syncToken)
      throw new Error('account_changed');
    localStorage.setItem(SAVE_KEY, JSON.stringify(candidate));
    localStorage.setItem(accountSaveKey(this.accountId), JSON.stringify(candidate));
    localStorage.setItem(SYNCED_ACCOUNT_KEY, this.accountId);
    this.cloudReadyAccountId = syncAccountId;
    return candidate === local ? 'local' : 'reload';
  }

  async save(save: SaveData): Promise<boolean> {
    return this.writeSave(save, this.accountId, false);
  }

  private async writeSave(save: SaveData, expectedAccountId: string,
    allowUnsynced: boolean): Promise<boolean> {
    if (!this.token || !expectedAccountId || this.accountId !== expectedAccountId
        || (!allowUnsynced && this.cloudReadyAccountId !== expectedAccountId)
        || this.saving) return false;
    const expectedToken = this.token;
    this.saving = true;
    try {
      const clean = { ...save, username: this.username, infiniteCurrency: false };
      const res = await fetch(`${this.apiUrl}/v1/save`, {
        method: 'PUT', headers: this.headers(true), body: JSON.stringify({ save: clean, revision: this.revision }),
      });
      const data = await res.json().catch(() => ({}));
      if (this.accountId !== expectedAccountId || this.token !== expectedToken) return false;
      if (res.status === 409 && data.error === 'save_conflict') {
        // Never turn a detected conflict into a blind overwrite on the next
        // five-second autosave. Pull the winning revision, persist it, then
        // reload so every renderer/service observes one coherent game state.
        const latestRes = await fetch(`${this.apiUrl}/v1/save`, { headers: this.headers() });
        const latest = await latestRes.json().catch(() => ({}));
        this.revision = Number(latest.revision) || Number(data.revision) || this.revision;
        if (latestRes.ok && latest.save) {
          latest.save.username = this.username;
          localStorage.setItem(SAVE_KEY, JSON.stringify(latest.save));
          localStorage.setItem(accountSaveKey(expectedAccountId), JSON.stringify(latest.save));
          setTimeout(() => location.reload(), 0);
        }
        this.cloudReadyAccountId = '';
        return false;
      }
      if (!res.ok) return false;
      this.revision = data.revision;
      if (Number.isFinite(Number(data.mentality))) save.mentality = Math.max(0, Number(data.mentality));
      if (Number.isFinite(Number(data.totalTaps))) save.totalTaps = Math.max(save.totalTaps, Number(data.totalTaps));
      if (Number.isFinite(Number(data.adsWatched))) save.adsWatched = Math.max(0, Number(data.adsWatched));
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
      localStorage.setItem(accountSaveKey(expectedAccountId), JSON.stringify(save));
      return true;
    } finally { this.saving = false; }
  }

  async verifyPurchase(receipt: PurchaseReceipt): Promise<PurchaseGrant> {
    queuePendingPurchase(receipt);
    if (!this.token) throw new Error('login_required');
    const verifyingAccountId = this.accountId;
    const verifyingToken = this.token;
    if (receipt.platform === 'android' && !receipt.purchaseToken) throw new Error('invalid_purchase');
    if (receipt.platform === 'ios' && !receipt.transactionId) throw new Error('invalid_purchase');
    if (receipt.platform !== 'android' && receipt.platform !== 'ios') throw new Error('platform_not_ready');
    if (!this.accountId || receipt.appAccountToken !== await accountUuid(this.accountId))
      throw new Error('purchase_account_mismatch');
    const res = await fetch(`${this.apiUrl}/v1/purchases/${receipt.platform}/verify`, {
      method: 'POST', headers: this.headers(true),
      body: JSON.stringify({
        productId: receipt.productId,
        purchaseToken: receipt.purchaseToken,
        transactionId: receipt.transactionId,
        receipt: receipt.receipt,
        jwsRepresentation: receipt.jwsRepresentation,
        appAccountToken: receipt.appAccountToken,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (this.accountId !== verifyingAccountId || this.token !== verifyingToken)
      throw new Error('account_changed');
    if (!res.ok) throw new Error(data.error ?? 'verification_failed');
    return { amount: Number(data.amount) || 0, transactionId: String(data.transactionId || '') };
  }

  async recoverPendingPurchases(): Promise<{ receipt: PurchaseReceipt; grant: PurchaseGrant }[]> {
    if (!this.token || !this.accountId) return [];
    const legacy = localStorage.getItem(LEGACY_PENDING_PURCHASE_KEY);
    if (legacy) {
      try { queuePendingPurchase(JSON.parse(legacy)); } catch { /* ignore corrupt legacy receipt */ }
      localStorage.removeItem(LEGACY_PENDING_PURCHASE_KEY);
    }
    const recovered: { receipt: PurchaseReceipt; grant: PurchaseGrant }[] = [];
    const expectedAccountToken = await accountUuid(this.accountId);
    for (const receipt of pendingPurchases()) {
      if (receipt.platform !== 'web' && !receipt.appAccountToken) {
        removePendingPurchase(receipt);
        continue;
      }
      // A shared device can hold unfinished purchases for several accounts.
      // Keep other accounts' bound receipts queued, but never submit them under
      // the currently authenticated identity.
      if (receipt.platform !== 'web' && receipt.appAccountToken !== expectedAccountToken) continue;
      try { recovered.push({ receipt, grant: await this.verifyPurchase(receipt) }); }
      catch { /* keep it queued for the next authenticated online launch */ }
    }
    return recovered;
  }
}
