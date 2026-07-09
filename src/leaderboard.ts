// ---------------------------------------------------------------------------
// Worldwide leaderboards — Game Center (iOS) + Google Play Games (Android).
//
// Same pattern as ads: one interface, swappable providers. On device, the
// native provider drives @openforge/capacitor-game-connect (sign-in, score
// submit, and the platform's own worldwide leaderboard overlay). In the web
// build it falls back to a local placeholder that tracks personal bests.
//
// Publish-time setup (dashboard work, not code):
//  - App Store Connect -> Game Center -> create both leaderboards, put their
//    IDs in BOARD_IDS.ios
//  - Google Play Console -> Play Games Services -> create both leaderboards,
//    put their IDs in BOARD_IDS.android
//  - npm i @openforge/capacitor-game-connect && npx cap sync
// ---------------------------------------------------------------------------

export type BoardKey = 'lights' | 'taps';

export const BOARD_IDS: Record<BoardKey, { name: string; ios: string; android: string }> = {
  lights: { name: 'Red Lights Cleared', ios: 'grp.dclicker.lights', android: 'REPLACE_WITH_PLAY_CONSOLE_ID_lights' },
  taps:   { name: 'Lifetime Taps',      ios: 'grp.dclicker.taps',   android: 'REPLACE_WITH_PLAY_CONSOLE_ID_taps' },
};

export interface LeaderboardProvider {
  /** 'gamecenter' | 'playgames' | 'web' */
  readonly platform: string;
  signIn(): Promise<boolean>;
  submit(board: BoardKey, value: number): Promise<void>;
  /** Opens the platform's worldwide leaderboard overlay (native only). */
  show(board: BoardKey): Promise<void>;
}

class LocalLeaderboard implements LeaderboardProvider {
  readonly platform = 'web';
  async signIn() { return false; }
  async submit(board: BoardKey, value: number) {
    const key = `lb-best-${board}`;
    const best = Number(localStorage.getItem(key) ?? 0);
    if (value > best) localStorage.setItem(key, String(value));
  }
  async show() { /* web placeholder — the RANKS panel renders personal bests */ }
  best(board: BoardKey): number {
    return Number(localStorage.getItem(`lb-best-${board}`) ?? 0);
  }
}

class GameConnectLeaderboard implements LeaderboardProvider {
  readonly platform: string;
  private signedIn = false;

  constructor(private plugin: any, isIOS: boolean) {
    this.platform = isIOS ? 'gamecenter' : 'playgames';
  }

  async signIn(): Promise<boolean> {
    try {
      await this.plugin.signIn();
      this.signedIn = true;
    } catch { this.signedIn = false; }
    return this.signedIn;
  }

  async submit(board: BoardKey, value: number) {
    if (!this.signedIn && !(await this.signIn())) return;
    const id = this.platform === 'gamecenter' ? BOARD_IDS[board].ios : BOARD_IDS[board].android;
    try {
      await this.plugin.submitScore({ leaderboardID: id, totalScoreAmount: Math.floor(value) });
    } catch { /* offline / not configured yet — scores resubmit on next defeat */ }
  }

  async show(board: BoardKey) {
    if (!this.signedIn && !(await this.signIn())) return;
    const id = this.platform === 'gamecenter' ? BOARD_IDS[board].ios : BOARD_IDS[board].android;
    try { await this.plugin.showLeaderboard({ leaderboardID: id }); } catch { /* ignore */ }
  }
}

export const localBests = new LocalLeaderboard();

export async function initLeaderboards(): Promise<LeaderboardProvider> {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    try {
      // resolved at runtime only once the native plugin is installed
      // (variable specifier keeps tsc/vite from resolving it at build time)
      const specifier = '@openforge/capacitor-game-connect';
      const mod = await import(/* @vite-ignore */ specifier);
      return new GameConnectLeaderboard(mod.GameConnect, cap.getPlatform() === 'ios');
    } catch { /* plugin not installed yet — fall through to local */ }
  }
  return localBests;
}
