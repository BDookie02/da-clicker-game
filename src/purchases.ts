// ---------------------------------------------------------------------------
import { NativePurchases, PURCHASE_TYPE } from '@capgo/native-purchases';
// Premium currency (M = Mentality) store.
//  - R (Respect) is earned by playing; M is premium: bought with real money
//    OR earned by watching a rewarded ad (you get roughly the ad's worth).
// Pack tiers/pricing follow the standard casual-idle ladder (the "Balls Bounce"
// progression model): a cheap entry pack, then escalating packs whose per-
// dollar value improves via a growing bonus %, anchored so the $4.99 pack is
// the "best starter" and $99.99 is "best value".
// Native builds swap PlaceholderPurchases for a Capacitor IAP provider; the
// game only ever calls buy(packId) and reads the resolved boolean.
// ---------------------------------------------------------------------------

export interface MPack {
  id: string;
  price: string;      // display price
  usd: number;        // for value math / sorting
  amount: number;     // M granted
  bonus?: string;     // badge, e.g. "+30%"
  tag?: string;       // e.g. "BEST VALUE"
}

// Calibrated to in-game M sinks (cosmetics ~50–320 M, LAB upgrades):
// the $0.99 pack buys ~2 cosmetics; the top pack is a whole-wardrobe splurge.
export const M_PACKS: MPack[] = [
  { id: 'm_handful', price: '$0.99',  usd: 0.99,  amount: 120 },
  { id: 'm_stack',   price: '$1.99',  usd: 1.99,  amount: 280,   bonus: '+15%' },
  { id: 'm_pouch',   price: '$4.99',  usd: 4.99,  amount: 800,   bonus: '+30%', tag: 'BEST STARTER' },
  { id: 'm_crate',   price: '$9.99',  usd: 9.99,  amount: 1800,  bonus: '+45%' },
  { id: 'm_vault',   price: '$19.99', usd: 19.99, amount: 4000,  bonus: '+60%' },
  { id: 'm_hoard',   price: '$49.99', usd: 49.99, amount: 11000, bonus: '+75%' },
  { id: 'm_empire',  price: '$99.99', usd: 99.99, amount: 25000, bonus: '+100%', tag: 'BEST VALUE' },
];

// Rewarded-ad → M. You get roughly what the ad is worth (a rewarded view is
// ~$0.01–0.02; at the $0.99≈120 M rate that's a few M). Kept modest so ads
// are a slow free trickle, not a substitute for buying. Tunable once real
// mediation eCPM is known.
export const AD_M_REWARD = 5;
export interface PurchaseProvider {
  readonly platform: string;
  /** Store-authoritative, localized display price. Null means unavailable. */
  getPrice(pack: MPack): string | null;
  /** Opens the store. Currency is granted only after backend verification. */
  buy(pack: MPack, accountId?: string): Promise<PurchaseReceipt | null>;
  /** Recover only transactions cryptographically bound to this account. */
  restoreForAccount(accountId: string): Promise<void>;
  /** Finish an iOS transaction only after the server ledger is durable. */
  finish(receipt: PurchaseReceipt): Promise<void>;
}
export interface PurchaseReceipt {
  platform: 'web' | 'android' | 'ios';
  productId: string;
  transactionId?: string;
  purchaseToken?: string;
  receipt?: string;
  jwsRepresentation?: string;
  appAccountToken?: string;
}

interface NativeTransactionReceipt {
  productIdentifier: string;
  transactionId: string;
  purchaseToken?: string;
  receipt?: string;
  jwsRepresentation?: string;
  appAccountToken?: string | null;
}

const PENDING_PURCHASES_KEY = 'discipline-pending-purchases-v2';

function receiptKey(receipt: PurchaseReceipt): string {
  return `${receipt.platform}:${receipt.purchaseToken || receipt.transactionId || `${receipt.productId}:unknown`}`;
}

export function pendingPurchases(): PurchaseReceipt[] {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_PURCHASES_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter(item => item && typeof item.productId === 'string'
          && ['web', 'android', 'ios'].includes(item.platform)).slice(-50)
      : [];
  } catch { return []; }
}

export function queuePendingPurchase(receipt: PurchaseReceipt) {
  // Native receipts without the deterministic account token cannot be safely
  // assigned on a shared device. The app was unreleased when legacy unbound
  // receipts existed, so quarantine them instead of allowing first-claim wins.
  if (receipt.platform !== 'web'
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(receipt.appAccountToken || '')) return;
  const queue = pendingPurchases();
  const key = receiptKey(receipt);
  if (!queue.some((item) => receiptKey(item) === key)) queue.push(receipt);
  localStorage.setItem(PENDING_PURCHASES_KEY, JSON.stringify(queue.slice(-50)));
}

export function removePendingPurchase(receipt: PurchaseReceipt) {
  const key = receiptKey(receipt);
  localStorage.setItem(PENDING_PURCHASES_KEY,
    JSON.stringify(pendingPurchases().filter((item) => receiptKey(item) !== key)));
}

export function clearPendingPurchases() {
  localStorage.removeItem(PENDING_PURCHASES_KEY);
}

async function accountUuid(accountId: string): Promise<string> {
  const seed = new TextEncoder().encode(`discipline-account:${accountId}`);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', seed)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Remove only the deleted account's unfinished transactions. A shared device
 * may still have cryptographically bound receipts for another login. */
export async function clearPendingPurchasesForAccount(accountId: string): Promise<void> {
  if (!accountId) return;
  const token = await accountUuid(accountId);
  localStorage.setItem(PENDING_PURCHASES_KEY, JSON.stringify(
    pendingPurchases().filter(receipt => receipt.appAccountToken !== token),
  ));
}

/** Web/dev provider: a confirm dialog stands in for the store sheet. */
export class PlaceholderPurchases implements PurchaseProvider {
  readonly platform = 'web';
  getPrice(pack: MPack) { return pack.price; }
  buy(pack: MPack): Promise<PurchaseReceipt | null> {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'ad-overlay';
      ov.innerHTML = `
        <div class="ad-box">
          <div class="ad-label">STORE · PLACEHOLDER</div>
          <div class="ad-screen">
            <div class="ad-art">💳</div>
            <div class="ad-copy">Real in-app purchase renders here.<br/>
            Buy <b style="color:#e6c84a">${pack.amount} M</b> for <b>${pack.price}</b>?</div>
          </div>
          <div class="name-actions">
            <button class="buy-cancel">CANCEL</button>
            <button class="buy-ok">CONFIRM ${pack.price}</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.querySelector('.buy-cancel')!.addEventListener('click', () => { ov.remove(); resolve(null); });
      ov.querySelector('.buy-ok')!.addEventListener('click', () => { ov.remove(); resolve({ platform: 'web', productId: pack.id }); });
    });
  }
  async restoreForAccount(): Promise<void> {}
  async finish(): Promise<void> {}
}

/** Safe startup state while the native store catalog is loading. */
export class UnavailablePurchases implements PurchaseProvider {
  readonly platform = 'unavailable';
  getPrice() { return null; }
  async buy(): Promise<PurchaseReceipt | null> { return null; }
  async restoreForAccount(): Promise<void> {}
  async finish(): Promise<void> {}
}

class NativePurchaseProvider implements PurchaseProvider {
  readonly platform = 'native';
  private readonly prices = new Map<string, string>();
  private activeAccountToken = '';

  constructor() {
    // The reviewed native patch leaves StoreKit updates unfinished. Persist a
    // matching update immediately; the backend verifies it before finish().
    void NativePurchases.addListener('transactionUpdated', transaction => {
      if (!this.activeAccountToken
          || transaction.appAccountToken !== this.activeAccountToken
          || !M_PACKS.some(pack => pack.id === transaction.productIdentifier)) return;
      this.queueNativeTransaction(transaction);
    });
  }

  getPrice(pack: MPack) {
    return this.prices.get(pack.id) ?? null;
  }

  async loadCatalog() {
    const { products } = await NativePurchases.getProducts({
      productIdentifiers: M_PACKS.map(pack => pack.id),
      productType: PURCHASE_TYPE.INAPP,
    });
    for (const product of products) {
      if (product.identifier && product.priceString)
        this.prices.set(product.identifier, product.priceString);
    }
  }

  async buy(pack: MPack, accountId?: string): Promise<PurchaseReceipt | null> {
    if (!accountId) throw new Error('login_required');
    try {
      const { isBillingSupported } = await NativePurchases.isBillingSupported();
      if (!isBillingSupported) return null;
      // Query first so Google Play—not a hardcoded label—is authoritative for
      // product availability and pricing in the purchase sheet.
      await NativePurchases.getProduct({
        productIdentifier: pack.id,
        productType: PURCHASE_TYPE.INAPP,
      });
      const appAccountToken = await accountUuid(accountId);
      this.activeAccountToken = appAccountToken;
      const transaction = await NativePurchases.purchaseProduct({
        productIdentifier: pack.id,
        productType: PURCHASE_TYPE.INAPP,
        appAccountToken,
        // The backend verifies and consumes only after recording the purchase.
        // Leaving it pending here prevents an unverified client-side grant.
        isConsumable: false,
        autoAcknowledgePurchases: false,
      });
      if (transaction.productIdentifier !== pack.id) return null;
      const receipt = this.receiptFromTransaction(transaction);
      if (receipt.appAccountToken !== appAccountToken) return null;
      return receipt;
    } catch (error) {
      if ((error as Error).message === 'login_required') throw error;
      return null;
    }
  }

  private receiptFromTransaction(transaction: NativeTransactionReceipt): PurchaseReceipt {
    return {
        platform: ((window as any).Capacitor?.getPlatform?.() === 'ios' ? 'ios' : 'android'),
        productId: transaction.productIdentifier,
        transactionId: transaction.transactionId,
        purchaseToken: transaction.purchaseToken,
        receipt: transaction.receipt,
        jwsRepresentation: transaction.jwsRepresentation,
        appAccountToken: transaction.appAccountToken ?? undefined,
      };
  }

  private queueNativeTransaction(transaction: NativeTransactionReceipt) {
    queuePendingPurchase(this.receiptFromTransaction(transaction));
  }

  async finish(receipt: PurchaseReceipt): Promise<void> {
    if (receipt.platform === 'ios' && receipt.transactionId)
      await NativePurchases.acknowledgePurchase({ purchaseToken: receipt.transactionId });
  }

  async restoreForAccount(accountId: string): Promise<void> {
    const appAccountToken = await accountUuid(accountId);
    this.activeAccountToken = appAccountToken;
    try {
      const { purchases } = await NativePurchases.getPurchases({
        productType: PURCHASE_TYPE.INAPP,
        appAccountToken,
        onlyCurrentEntitlements: false,
      });
      for (const transaction of purchases) {
        if (!M_PACKS.some(pack => pack.id === transaction.productIdentifier)
            || transaction.appAccountToken !== appAccountToken) continue;
        this.queueNativeTransaction(transaction);
      }
    } catch { /* offline/store unavailable; the local durable queue remains */ }
  }

}

/** Native IAP (Capacitor). Wired at store-launch; falls back to placeholder. */
export async function initPurchases(): Promise<PurchaseProvider> {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const provider = new NativePurchaseProvider();
    try { await provider.loadCatalog(); }
    catch { /* Play unavailable/offline: the shop shows products unavailable */ }
    return provider;
  }
  return new PlaceholderPurchases();
}
