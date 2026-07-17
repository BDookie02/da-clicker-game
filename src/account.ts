import { SAVE_KEY } from './config';
import type { SaveData } from './state';
import type { PurchaseReceipt } from './purchases';

export const TOKEN_KEY = 'discipline-account-token-v1';
const USER_KEY = 'discipline-account-username-v1';
const PENDING_PURCHASE_KEY = 'discipline-pending-purchase-v1';

export interface AccountIdentity { id: string; username: string }
export interface PurchaseGrant { amount: number; transactionId: string }

export class AccountService {
  token = localStorage.getItem(TOKEN_KEY) ?? '';
  username = localStorage.getItem(USER_KEY) ?? '';
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
    this.token = data.token; this.username = data.account.username;
    localStorage.setItem(TOKEN_KEY, this.token); localStorage.setItem(USER_KEY, this.username);
    return data.account;
  }
  register(username: string, password: string) { return this.auth('register', username, password); }
  login(username: string, password: string) { return this.auth('login', username, password); }
  logout() {
    this.token = ''; this.username = ''; this.revision = 0;
    localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
  }
  async verify(): Promise<AccountIdentity | null> {
    if (!this.token) return null;
    const res = await fetch(`${this.apiUrl}/v1/account`, { headers: this.headers() });
    if (!res.ok) { if (res.status === 401) this.logout(); return null; }
    const { account } = await res.json();
    this.username = account.username; localStorage.setItem(USER_KEY, account.username);
    return account;
  }
  async sync(local: SaveData): Promise<'local' | 'cloud'> {
    const res = await fetch(`${this.apiUrl}/v1/save`, { headers: this.headers() });
    if (!res.ok) throw new Error('cloud_unavailable');
    const data = await res.json(); this.revision = Number(data.revision) || 0;
    if (data.save && Number(data.save.lastSeen) > Number(local.lastSeen)) {
      data.save.username = this.username;
      localStorage.setItem(SAVE_KEY, JSON.stringify(data.save));
      return 'cloud';
    }
    local.username = this.username;
    await this.save(local);
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
      if (res.status === 409) this.revision = Number(data.revision) || this.revision;
      if (!res.ok) return false;
      this.revision = data.revision; return true;
    } finally { this.saving = false; }
  }

  async verifyPurchase(receipt: PurchaseReceipt): Promise<PurchaseGrant> {
    if (!this.token) throw new Error('login_required');
    if (receipt.platform !== 'android' || !receipt.purchaseToken) throw new Error('platform_not_ready');
    localStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify(receipt));
    const res = await fetch(`${this.apiUrl}/v1/purchases/android/verify`, {
      method: 'POST', headers: this.headers(true),
      body: JSON.stringify({ productId: receipt.productId, purchaseToken: receipt.purchaseToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'verification_failed');
    localStorage.removeItem(PENDING_PURCHASE_KEY);
    return { amount: Number(data.amount) || 0, transactionId: String(data.transactionId || '') };
  }

  async recoverPendingPurchase(): Promise<PurchaseGrant | null> {
    const raw = localStorage.getItem(PENDING_PURCHASE_KEY);
    if (!raw) return null;
    try { return await this.verifyPurchase(JSON.parse(raw)); }
    catch { return null; }
  }
}
