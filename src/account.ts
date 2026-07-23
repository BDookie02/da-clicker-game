import { SAVE_KEY } from './config';
import type { SaveData } from './state';
import { clearPendingPurchases, pendingPurchases, queuePendingPurchase, type PurchaseReceipt } from './purchases';

export const TOKEN_KEY = 'discipline-account-token-v1';
const USER_KEY = 'discipline-account-username-v1';
const ACCOUNT_ID_KEY = 'discipline-account-id-v1';
const SYNCED_ACCOUNT_KEY = 'discipline-synced-account-v1';
const LEGACY_PENDING_PURCHASE_KEY = 'discipline-pending-purchase-v1';

export interface AccountIdentity { id: string; username: string }
export interface PurchaseGrant { amount: number; transactionId: string }
export interface AdVerification { userId: string; customData: string }

async function accountUuid(accountId: string): Promise<string> {
  const seed = new TextEncoder().encode(`discipline-account:${accountId}`);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', seed)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class AccountService {
  token = localStorage.getItem(TOKEN_KEY) ?? '';
  username = localStorage.getItem(USER_KEY) ?? '';
  accountId = localStorage.getItem(ACCOUNT_ID_KEY) ?? '';
  revision = 0;
  private saving = false;

  constructor(readonly apiUrl: string) {}

  get signedIn() { return !!this.token; }
  private headers(json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }
  private async auth(path: string, username: string, password: string): Promise<AccountIdentity> {
    const res = await fetch(`${this.apiUrl}/v1/auth/${path}`, {
      method: 'POST', headers: this.headers(true), body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'account_unavailable');
    this.token = data.token; this.username = data.account.username; this.accountId = String(data.account.id);
    localStorage.setItem(TOKEN_KEY, this.token); localStorage.setItem(USER_KEY, this.username);
    localStorage.setItem(ACCOUNT_ID_KEY, this.accountId);
    return data.account;
  }
  register(username: string, password: string) { return this.auth('register', username, password); }
  login(username: string, password: string) { return this.auth('login', username, password); }
  logout() {
    this.token = ''; this.username = ''; this.accountId = ''; this.revision = 0;
    localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); localStorage.removeItem(ACCOUNT_ID_KEY);
  }
  async verify(): Promise<AccountIdentity | null> {
    if (!this.token) return null;
    const res = await fetch(`${this.apiUrl}/v1/account`, { headers: this.headers() });
    if (!res.ok) { if (res.status === 401) this.logout(); return null; }
    const { account } = await res.json();
    this.username = account.username; this.accountId = String(account.id);
    localStorage.setItem(USER_KEY, account.username); localStorage.setItem(ACCOUNT_ID_KEY, this.accountId);
    return account;
  }

  /** Bind an ad watch to this account in AdMob's signed SSV callback. */
  async adVerification(kind: 'm' | 'boost' | 'offline'): Promise<AdVerification> {
    if (!this.accountId || !this.signedIn) throw new Error('login_required');
    return {
      userId: await accountUuid(this.accountId),
      customData: JSON.stringify({
        v: 1,
        accountId: this.accountId,
        nonce: crypto.randomUUID(),
        kind,
      }),
    };
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
    this.logout();
    localStorage.removeItem(SAVE_KEY);
    localStorage.removeItem(SYNCED_ACCOUNT_KEY);
    clearPendingPurchases();
  }
  async sync(local: SaveData): Promise<'local' | 'cloud'> {
    const res = await fetch(`${this.apiUrl}/v1/save`, { headers: this.headers() });
    if (!res.ok) throw new Error('cloud_unavailable');
    const data = await res.json(); this.revision = Number(data.revision) || 0;
    const previouslySyncedHere = localStorage.getItem(SYNCED_ACCOUNT_KEY) === this.accountId;
    // On the first login for this account on a device, an existing cloud save
    // must win even if the freshly-created local save has a newer timestamp.
    // On later launches, the newest side wins as expected.
    if (data.save && (!previouslySyncedHere || Number(data.save.lastSeen) >= Number(local.lastSeen))) {
      data.save.username = this.username;
      localStorage.setItem(SAVE_KEY, JSON.stringify(data.save));
      localStorage.setItem(SYNCED_ACCOUNT_KEY, this.accountId);
      return 'cloud';
    }
    local.username = this.username;
    await this.save(local);
    localStorage.setItem(SYNCED_ACCOUNT_KEY, this.accountId);
    return 'local';
  }
  async save(save: SaveData): Promise<boolean> {
    if (!this.token || this.saving) return false;
    this.saving = true;
    try {
      const clean = { ...save, username: this.username, infiniteCurrency: false };
      const res = await fetch(`${this.apiUrl}/v1/save`, {
        method: 'PUT', headers: this.headers(true), body: JSON.stringify({ save: clean, revision: this.revision }),
      });
      const data = await res.json().catch(() => ({}));
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
          setTimeout(() => location.reload(), 0);
        }
        return false;
      }
      if (!res.ok) return false;
      this.revision = data.revision; return true;
    } finally { this.saving = false; }
  }

  async verifyPurchase(receipt: PurchaseReceipt): Promise<PurchaseGrant> {
    queuePendingPurchase(receipt);
    if (!this.token) throw new Error('login_required');
    if (receipt.platform === 'android' && !receipt.purchaseToken) throw new Error('invalid_purchase');
    if (receipt.platform === 'ios' && !receipt.transactionId) throw new Error('invalid_purchase');
    if (receipt.platform !== 'android' && receipt.platform !== 'ios') throw new Error('platform_not_ready');
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
    if (!res.ok) throw new Error(data.error ?? 'verification_failed');
    return { amount: Number(data.amount) || 0, transactionId: String(data.transactionId || '') };
  }

  async recoverPendingPurchases(): Promise<{ receipt: PurchaseReceipt; grant: PurchaseGrant }[]> {
    const legacy = localStorage.getItem(LEGACY_PENDING_PURCHASE_KEY);
    if (legacy) {
      try { queuePendingPurchase(JSON.parse(legacy)); } catch { /* ignore corrupt legacy receipt */ }
      localStorage.removeItem(LEGACY_PENDING_PURCHASE_KEY);
    }
    const recovered: { receipt: PurchaseReceipt; grant: PurchaseGrant }[] = [];
    for (const receipt of pendingPurchases()) {
      try { recovered.push({ receipt, grant: await this.verifyPurchase(receipt) }); }
      catch { /* keep it queued for the next authenticated online launch */ }
    }
    return recovered;
  }
}
