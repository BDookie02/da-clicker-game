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
  /** Charge for a pack. Resolves true only on a completed purchase. */
  buy(pack: MPack): Promise<boolean>;
}

/** Web/dev provider: a confirm dialog stands in for the store sheet. */
export class PlaceholderPurchases implements PurchaseProvider {
  readonly platform = 'web';
  buy(pack: MPack): Promise<boolean> {
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
      ov.querySelector('.buy-cancel')!.addEventListener('click', () => { ov.remove(); resolve(false); });
      ov.querySelector('.buy-ok')!.addEventListener('click', () => { ov.remove(); resolve(true); });
    });
  }
}

class NativePurchaseProvider implements PurchaseProvider {
  readonly platform = 'native';

  async buy(pack: MPack): Promise<boolean> {
    try {
      const { isBillingSupported } = await NativePurchases.isBillingSupported();
      if (!isBillingSupported) return false;
      // Query first so Google Play—not a hardcoded label—is authoritative for
      // product availability and pricing in the purchase sheet.
      await NativePurchases.getProduct({
        productIdentifier: pack.id,
        productType: PURCHASE_TYPE.INAPP,
      });
      const transaction = await NativePurchases.purchaseProduct({
        productIdentifier: pack.id,
        productType: PURCHASE_TYPE.INAPP,
        isConsumable: true,
        autoAcknowledgePurchases: true,
      });
      return transaction.productIdentifier === pack.id;
    } catch {
      return false;
    }
  }

}

/** Native IAP (Capacitor). Wired at store-launch; falls back to placeholder. */
export async function initPurchases(): Promise<PurchaseProvider> {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    return new NativePurchaseProvider();
  }
  return new PlaceholderPurchases();
}
