import { music } from './audio';
import {
  AdMob,
  InterstitialAdPluginEvents,
  RewardAdPluginEvents,
} from '@capacitor-community/admob';

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
  /** Loads the next non-rewarded break ad without blocking gameplay. */
  preloadInterstitial(): Promise<boolean>;
  /** Shows only an already-loaded break ad. Never waits on the network. */
  showInterstitial(): Promise<boolean>;
  /** Prevents rewarded and non-rewarded full-screen ads from overlapping. */
  isFullscreenAdActive(): boolean;
}

export interface AdVerification {
  userId: string;
  customData: string;
  nonce: string;
  kind: 'm' | 'boost' | 'offline';
}

export interface AdResult {
  rewarded: boolean;
  watchedSeconds: number;
  rewardNonce?: string;
  verificationPending?: boolean;
  /** A native load is still running and the exact SSV intent should be reused. */
  retryable?: boolean;
}

export const AD_CONFIG = {
  TESTING: import.meta.env.VITE_ADMOB_TESTING !== 'false',
  // Google's documented test rewarded-video unit IDs (safe to ship in dev):
  rewardedAndroid: 'ca-app-pub-3940256099942544/5224354917',
  rewardedIos: 'ca-app-pub-3940256099942544/1712485313',
  interstitialAndroid: 'ca-app-pub-3940256099942544/1033173712',
  interstitialIos: 'ca-app-pub-3940256099942544/4411468910',
  // production unit IDs go here after AdMob account setup:
  prodRewardedAndroid: import.meta.env.VITE_ADMOB_ANDROID_REWARDED_ID ?? '',
  prodRewardedIos: import.meta.env.VITE_ADMOB_IOS_REWARDED_ID ?? '',
  prodInterstitialAndroid: import.meta.env.VITE_ADMOB_ANDROID_INTERSTITIAL_ID ?? '',
  prodInterstitialIos: import.meta.env.VITE_ADMOB_IOS_INTERSTITIAL_ID ?? '',
};

// These bounds stop a bad connection or a wedged SDK callback from leaving the
// loading overlay on screen indefinitely. A late load remains cached, so the
// player's next attempt can still use it immediately.
const AD_LOAD_TIMEOUT_MS = 60_000;
const AD_SHOW_TIMEOUT_MS = 120_000;
const AD_CACHE_MAX_AGE_MS = 50 * 60_000;

class AdDeadlineError extends Error {}

function deadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new AdDeadlineError(`${label} timed out`)), timeoutMs);
    promise.then(
      value => {
        window.clearTimeout(timer);
        resolve(value);
      },
      error => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class AdMobAdProvider implements AdProvider {
  private initPromise: Promise<void> | null = null;
  private preparing: { key: string; promise: Promise<void> } | null = null;
  private preparedKey = '';
  private preparedAt = 0;
  private interstitialPreparing: Promise<void> | null = null;
  private interstitialPreparedAt = 0;
  private showInProgress = false;
  private backgroundEpoch = 0;

  constructor(private isIOS: boolean) {}

  private unitId(): string {
    if (AD_CONFIG.TESTING) return this.isIOS ? AD_CONFIG.rewardedIos : AD_CONFIG.rewardedAndroid;
    return this.isIOS ? AD_CONFIG.prodRewardedIos : AD_CONFIG.prodRewardedAndroid;
  }

  private interstitialUnitId(): string {
    if (AD_CONFIG.TESTING)
      return this.isIOS ? AD_CONFIG.interstitialIos : AD_CONFIG.interstitialAndroid;
    return this.isIOS ? AD_CONFIG.prodInterstitialIos : AD_CONFIG.prodInterstitialAndroid;
  }

  private reportFailure(stage: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error || 'unknown error');
    console.warn(`[AdMob] ${stage}: ${detail}`);
  }

  private init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await AdMob.initialize({ initializeForTesting: AD_CONFIG.TESTING });
      // Google demo units do not use production inventory or personal data.
      // Requiring a publisher UMP form here blocked every closed-track demo
      // request before AdMob could load the guaranteed-fill test ad.
      if (AD_CONFIG.TESTING) return;
      let consent = await AdMob.requestConsentInfo();
      if (!consent.canRequestAds && consent.isConsentFormAvailable)
        consent = await AdMob.showConsentForm();
      if (!consent.canRequestAds) throw new Error('Ad consent is required');
    })().catch((error) => {
      // Initialization failures (including temporary network trouble) must be
      // retryable on the next foreground or button press.
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  private preparationKey(verification?: AdVerification): string {
    return verification
      ? `${this.unitId()}\n${verification.userId}\n${verification.customData}`
      : this.unitId();
  }

  private isPrepared(key: string): boolean {
    return this.preparedKey === key
      && Date.now() - this.preparedAt < AD_CACHE_MAX_AGE_MS;
  }

  private async prepare(verification?: AdVerification): Promise<void> {
    await this.init();
    const adId = this.unitId();
    if (!AD_CONFIG.TESTING && !adId) throw new Error('Missing production AdMob rewarded unit ID');
    const key = this.preparationKey(verification);
    if (this.isPrepared(key)) return;

    if (this.preparing) {
      if (this.preparing.key === key) return this.preparing.promise;
      await this.preparing.promise.catch(() => undefined);
      if (this.isPrepared(key)) return;
    }

    const load = AdMob.prepareRewardVideoAd({
      adId,
      isTesting: AD_CONFIG.TESTING,
      ...(verification ? { ssv: {
        userId: verification.userId,
        customData: verification.customData,
      } } : {}),
    }).then(() => {
      this.preparedKey = key;
      this.preparedAt = Date.now();
    });
    const pending = { key, promise: load };
    this.preparing = pending;
    load.then(
      () => { if (this.preparing === pending) this.preparing = null; },
      () => { if (this.preparing === pending) this.preparing = null; },
    );
    return load;
  }

  private isInterstitialPrepared(): boolean {
    return this.interstitialPreparedAt > 0
      && Date.now() - this.interstitialPreparedAt < AD_CACHE_MAX_AGE_MS;
  }

  private async prepareInterstitial(): Promise<void> {
    await this.init();
    const adId = this.interstitialUnitId();
    if (!AD_CONFIG.TESTING && !adId)
      throw new Error('Missing production AdMob interstitial unit ID');
    if (this.isInterstitialPrepared()) return;
    if (this.interstitialPreparing) return this.interstitialPreparing;

    const load = AdMob.prepareInterstitial({
      adId,
      isTesting: AD_CONFIG.TESTING,
      immersiveMode: true,
    }).then(() => {
      this.interstitialPreparedAt = Date.now();
    });
    this.interstitialPreparing = load;
    load.then(
      () => { if (this.interstitialPreparing === load) this.interstitialPreparing = null; },
      () => { if (this.interstitialPreparing === load) this.interstitialPreparing = null; },
    );
    return load;
  }

  async preloadInterstitial(): Promise<boolean> {
    if (document.hidden || this.showInProgress) return false;
    try {
      await deadline(this.prepareInterstitial(), AD_LOAD_TIMEOUT_MS, 'Interstitial ad preload');
      return this.isInterstitialPrepared();
    } catch (error) {
      this.reportFailure('interstitial preload failed', error);
      return false;
    }
  }

  /** Starts Mobile Ads/UMP immediately and keeps reusable inventory warm. */
  async warmup(): Promise<void> {
    if (document.hidden || this.showInProgress) return;
    await deadline(this.init(), AD_LOAD_TIMEOUT_MS, 'AdMob initialization');
    const loads: Promise<unknown>[] = [this.preloadInterstitial()];
    // Production SSV data is unique to a signed-in reward intent, so only a
    // public test rewarded ad can be loaded before the player requests it.
    if (AD_CONFIG.TESTING) loads.push(
      deadline(this.prepare(), AD_LOAD_TIMEOUT_MS, 'Rewarded ad preload'),
    );
    await Promise.allSettled(loads);
  }

  private present(): Promise<AdResult> {
    return new Promise<AdResult>((resolve) => {
      let rewarded = false;
      let dismissed = false;
      let shownAt = 0;
      let rewardedAt = 0;
      let settled = false;
      let timeout = 0;
      let dismissGrace = 0;
      const subs: { remove(): Promise<void> }[] = [];
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.clearTimeout(dismissGrace);
        for (const sub of subs) void sub.remove();
        const end = rewardedAt || performance.now();
        resolve({ rewarded: ok, watchedSeconds: shownAt ? Math.max(0, (end - shownAt) / 1000) : 0 });
      };
      const markRewarded = () => {
        if (settled) return;
        if (!rewarded) {
          rewarded = true;
          rewardedAt = performance.now();
        }
        // Capacitor can deliver dismissal before its bridged reward callback.
        // Settle only after both facts are known so a completed ad cannot be
        // mistaken for an early close.
        if (dismissed) done(true);
      };
      Promise.all([
        AdMob.addListener(RewardAdPluginEvents.Showed, () => {
          shownAt = performance.now();
        }),
        AdMob.addListener(RewardAdPluginEvents.Rewarded, markRewarded),
        AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
          dismissed = true;
          if (rewarded) done(true);
          else dismissGrace = window.setTimeout(() => done(false), 2_000);
        }),
        AdMob.addListener(RewardAdPluginEvents.FailedToShow, (error) => {
          this.reportFailure('rewarded failed to show', error);
          done(false);
        }),
      ]).then((listeners) => {
        subs.push(...listeners);
        timeout = window.setTimeout(() => done(rewarded), AD_SHOW_TIMEOUT_MS);
        return AdMob.showRewardVideoAd();
      }).then(() => {
        // Android/iOS resolve this promise from the native earned-reward
        // callback. Keep it as a second positive signal in case the bridged
        // Rewarded event arrives after Dismissed or is lost.
        markRewarded();
      }).catch((error) => {
        this.reportFailure('rewarded show failed', error);
        done(false);
      });
    });
  }

  async show(_fallbackSeconds?: number, verification?: AdVerification): Promise<AdResult> {
    if (this.showInProgress) return { rewarded: false, watchedSeconds: 0 };
    this.showInProgress = true;
    const requestedInEpoch = this.backgroundEpoch;
    try {
      const key = this.preparationKey(verification);
      await deadline(this.prepare(verification), AD_LOAD_TIMEOUT_MS, 'Rewarded ad load');
      // Never launch a full-screen ad after the player left or locked the app.
      // The completed load remains cached for the next explicit attempt.
      if (document.hidden || requestedInEpoch !== this.backgroundEpoch || !this.isPrepared(key))
        return { rewarded: false, watchedSeconds: 0 };
      this.preparedKey = '';
      this.preparedAt = 0;
      return await this.present();
    } catch (error) {
      this.reportFailure('rewarded load/show failed', error);
      return {
        rewarded: false,
        watchedSeconds: 0,
        retryable: error instanceof AdDeadlineError,
      };
    } finally {
      this.showInProgress = false;
      // Rewarded ads are single-use. Refill the test slot immediately so the
      // next allowed press normally opens without another network wait.
      if (AD_CONFIG.TESTING && !document.hidden)
        void this.warmup().catch(() => undefined);
    }
  }

  private presentInterstitial(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let showed = false;
      let settled = false;
      let timeout = 0;
      const subs: { remove(): Promise<void> }[] = [];
      const done = (didShow: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        for (const sub of subs) void sub.remove();
        resolve(didShow);
      };
      Promise.all([
        AdMob.addListener(InterstitialAdPluginEvents.Showed, () => { showed = true; }),
        AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => done(showed)),
        AdMob.addListener(InterstitialAdPluginEvents.FailedToShow, (error) => {
          this.reportFailure('interstitial failed to show', error);
          done(false);
        }),
      ]).then((listeners) => {
        subs.push(...listeners);
        timeout = window.setTimeout(() => done(showed), AD_SHOW_TIMEOUT_MS);
        return AdMob.showInterstitial();
      }).catch((error) => {
        this.reportFailure('interstitial show failed', error);
        done(false);
      });
    });
  }

  async showInterstitial(): Promise<boolean> {
    if (this.showInProgress || document.hidden || !this.isInterstitialPrepared())
      return false;
    this.showInProgress = true;
    const requestedInEpoch = this.backgroundEpoch;
    this.interstitialPreparedAt = 0;
    try {
      if (document.hidden || requestedInEpoch !== this.backgroundEpoch) return false;
      return await this.presentInterstitial();
    } finally {
      this.showInProgress = false;
      if (!document.hidden) void this.preloadInterstitial();
    }
  }

  isFullscreenAdActive(): boolean { return this.showInProgress; }

  onVisibilityChange(): void {
    if (document.hidden) {
      this.backgroundEpoch += 1;
      return;
    }
    void this.warmup().catch(() => undefined);
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
  async preloadInterstitial(): Promise<boolean> { return false; }
  async showInterstitial(): Promise<boolean> { return false; }
  isFullscreenAdActive(): boolean { return false; }
}

/** Picks AdMob on device (once the plugin is present), placeholder elsewhere. */
export async function initAds(): Promise<AdProvider> {
  let provider: AdProvider;
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const nativeProvider = new AdMobAdProvider(cap.getPlatform() === 'ios');
    // Do not block game startup on the network. Begin initialization/loading
    // now and retry whenever the native WebView returns to the foreground.
    void nativeProvider.warmup().catch(() => undefined);
    document.addEventListener('visibilitychange', () => nativeProvider.onVisibilityChange());
    provider = nativeProvider;
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
    preloadInterstitial: () => provider.preloadInterstitial(),
    async showInterstitial() {
      music.pauseForAd();
      try { return await provider.showInterstitial(); }
      finally { music.resumeAfterAd(); }
    },
    isFullscreenAdActive: () => provider.isFullscreenAdActive(),
  };
}
