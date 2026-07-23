import { music } from './audio';
import { AdMob, RewardAdPluginEvents } from '@capacitor-community/admob';

// ---------------------------------------------------------------------------
// Rewarded ads. One interface, two providers:
//  - AdMobAdProvider: real rewarded video via @capacitor-community/admob on
//    iOS/Android. Ships pointed at Google's official PUBLIC TEST unit IDs, so
//    ads work on device immediately with no account. When the AdMob account
//    exists: create one Rewarded unit per platform, paste the IDs below, set
//    TESTING to false, rebuild. That is the entire ad setup.
//  - PlaceholderAdProvider: web/dev fallback with a verified-watch countdown.
// Reward is only granted on the SDK's reward event (i.e., a completed watch);
// enable server-side verification in the AdMob console for hard proof.
// ---------------------------------------------------------------------------

export interface AdProvider {
  /** Shows a rewarded ad. fallbackSeconds is used only by the web placeholder. */
  show(fallbackSeconds: number, verification?: AdVerification): Promise<AdResult>;
}

export interface AdVerification {
  userId: string;
  customData: string;
}

export interface AdResult {
  rewarded: boolean;
  watchedSeconds: number;
}

export const AD_CONFIG = {
  TESTING: import.meta.env.VITE_ADMOB_TESTING !== 'false',
  // Google's documented test rewarded-video unit IDs (safe to ship in dev):
  rewardedAndroid: 'ca-app-pub-3940256099942544/5224354917',
  rewardedIos: 'ca-app-pub-3940256099942544/1712485313',
  // production unit IDs go here after AdMob account setup:
  prodRewardedAndroid: import.meta.env.VITE_ADMOB_ANDROID_REWARDED_ID ?? '',
  prodRewardedIos: import.meta.env.VITE_ADMOB_IOS_REWARDED_ID ?? '',
};

class AdMobAdProvider implements AdProvider {
  private ready = false;
  constructor(private isIOS: boolean) {}

  private unitId(): string {
    if (AD_CONFIG.TESTING) return this.isIOS ? AD_CONFIG.rewardedIos : AD_CONFIG.rewardedAndroid;
    return this.isIOS ? AD_CONFIG.prodRewardedIos : AD_CONFIG.prodRewardedAndroid;
  }

  private async init() {
    if (this.ready) return;
    await AdMob.initialize({ initializeForTesting: AD_CONFIG.TESTING });
    let consent = await AdMob.requestConsentInfo();
    if (!consent.canRequestAds && consent.isConsentFormAvailable)
      consent = await AdMob.showConsentForm();
    if (!consent.canRequestAds) throw new Error('Ad consent is required');
    this.ready = true;
  }

  async show(_fallbackSeconds?: number, verification?: AdVerification): Promise<AdResult> {
    try {
      await this.init();
      const adId = this.unitId();
      if (!AD_CONFIG.TESTING && !adId) throw new Error('Missing production AdMob rewarded unit ID');
      return await new Promise<AdResult>((resolve) => {
        let rewarded = false;
        let shownAt = 0;
        let rewardedAt = 0;
        let settled = false;
        const subs: { remove(): void }[] = [];
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          subs.forEach(s => s.remove());
          const end = rewardedAt || performance.now();
          resolve({ rewarded: ok, watchedSeconds: shownAt ? Math.max(0, (end - shownAt) / 1000) : 0 });
        };
        Promise.all([
          AdMob.addListener(RewardAdPluginEvents.Rewarded, () => {
            rewarded = true;
            rewardedAt = performance.now();
          }),
          AdMob.addListener(RewardAdPluginEvents.Dismissed, () => done(rewarded)),
          AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => done(false)),
        ]).then((listeners) => {
          subs.push(...listeners);
          return AdMob.prepareRewardVideoAd({
            adId,
            ...(verification ? { ssv: verification } : {}),
          });
        }).then(() => {
          shownAt = performance.now();
          return AdMob.showRewardVideoAd();
        }).catch(() => done(false));
      });
    } catch {
      return { rewarded: false, watchedSeconds: 0 }; // no fill / offline — player just retries
    }
  }
}

/** Reopens Google's UMP choices when the region/account requires them. */
export async function showAdPrivacyOptions(): Promise<boolean> {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.()) return false;
  try {
    await AdMob.initialize({ initializeForTesting: AD_CONFIG.TESTING });
    await AdMob.requestConsentInfo();
    await AdMob.showPrivacyOptionsForm();
    return true;
  } catch { return false; }
}

export class PlaceholderAdProvider implements AdProvider {
  show(lengthSec: number): Promise<AdResult> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ad-overlay';
      overlay.innerHTML = `
        <div class="ad-box">
          <div class="ad-label">AD · PLACEHOLDER</div>
          <div class="ad-screen">
            <div class="ad-art">📺</div>
            <div class="ad-copy">Your ad network renders here.<br/>(AdMob rewarded slot)</div>
          </div>
          <div class="ad-timer"></div>
          <button class="ad-skip" disabled>reward in <span></span>s</button>
        </div>`;
      document.body.appendChild(overlay);
      const btn = overlay.querySelector('.ad-skip') as HTMLButtonElement;
      const span = btn.querySelector('span')!;
      span.textContent = String(lengthSec);
      // verified watch: only visible time counts; no skip path exists
      let watched = 0;
      let lastT = performance.now();
      const iv = setInterval(() => {
        const now = performance.now();
        if (!document.hidden) watched += (now - lastT) / 1000;
        lastT = now;
        const left = Math.max(0, Math.ceil(lengthSec - watched));
        span.textContent = document.hidden ? `${left} (paused)` : String(left);
        if (watched >= lengthSec) {
          clearInterval(iv);
          btn.disabled = true;
          btn.innerHTML = 'REWARD CLAIMED ✓';
          setTimeout(() => { overlay.remove(); resolve({ rewarded: true, watchedSeconds: watched }); }, 600);
        }
      }, 250);
    });
  }
}

/** Picks AdMob on device (once the plugin is present), placeholder elsewhere. */
export async function initAds(): Promise<AdProvider> {
  let provider: AdProvider;
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    provider = new AdMobAdProvider(cap.getPlatform() === 'ios');
    return withMusicPause(provider);
  }
  provider = new PlaceholderAdProvider();
  return withMusicPause(provider);
}

export function withMusicPause(provider: AdProvider): AdProvider {
  return {
    async show(lengthSec: number, verification?: AdVerification) {
      music.pauseForAd();
      try { return await provider.show(lengthSec, verification); }
      finally { music.resumeAfterAd(); }
    },
  };
}
