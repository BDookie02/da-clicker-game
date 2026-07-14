import { music } from './audio';

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
  /** Shows a rewarded ad. Resolves true only on a verified completed watch. */
  show(lengthSec: number): Promise<boolean>;
}

export const AD_CONFIG = {
  TESTING: true, // set false for production ads
  // Google's documented test rewarded-video unit IDs (safe to ship in dev):
  rewardedAndroid: 'ca-app-pub-3940256099942544/5224354917',
  rewardedIos: 'ca-app-pub-3940256099942544/1712485313',
  // production unit IDs go here after AdMob account setup:
  prodRewardedAndroid: 'PASTE_ANDROID_REWARDED_UNIT_ID',
  prodRewardedIos: 'PASTE_IOS_REWARDED_UNIT_ID',
};

class AdMobAdProvider implements AdProvider {
  private ready = false;
  constructor(private admob: any, private isIOS: boolean) {}

  private unitId(): string {
    if (AD_CONFIG.TESTING) return this.isIOS ? AD_CONFIG.rewardedIos : AD_CONFIG.rewardedAndroid;
    return this.isIOS ? AD_CONFIG.prodRewardedIos : AD_CONFIG.prodRewardedAndroid;
  }

  private async init() {
    if (this.ready) return;
    await this.admob.AdMob.initialize({ initializeForTesting: AD_CONFIG.TESTING });
    this.ready = true;
  }

  async show(): Promise<boolean> {
    try {
      await this.init();
      const { AdMob, RewardAdPluginEvents } = this.admob;
      await AdMob.prepareRewardVideoAd({ adId: this.unitId() });
      return await new Promise<boolean>((resolve) => {
        let rewarded = false;
        const subs: { remove(): void }[] = [];
        const done = (ok: boolean) => {
          subs.forEach(s => s.remove());
          resolve(ok);
        };
        AdMob.addListener(RewardAdPluginEvents.Rewarded, () => { rewarded = true; }).then((s: any) => subs.push(s));
        AdMob.addListener(RewardAdPluginEvents.Dismissed, () => done(rewarded)).then((s: any) => subs.push(s));
        AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => done(false)).then((s: any) => subs.push(s));
        void AdMob.showRewardVideoAd();
      });
    } catch {
      return false; // no fill / offline — player just retries
    }
  }
}

export class PlaceholderAdProvider implements AdProvider {
  show(lengthSec: number): Promise<boolean> {
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
          setTimeout(() => { overlay.remove(); resolve(true); }, 600);
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
    try {
      const specifier = '@capacitor-community/admob';
      const mod = await import(/* @vite-ignore */ specifier);
      provider = new AdMobAdProvider(mod, cap.getPlatform() === 'ios');
      return withMusicPause(provider);
    } catch { /* plugin missing — fall through */ }
  }
  provider = new PlaceholderAdProvider();
  return withMusicPause(provider);
}

export function withMusicPause(provider: AdProvider): AdProvider {
  return {
    async show(lengthSec: number) {
      music.pauseForAd();
      try { return await provider.show(lengthSec); }
      finally { music.resumeAfterAd(); }
    },
  };
}
