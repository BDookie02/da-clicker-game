// ---------------------------------------------------------------------------
// Worldwide high-score leaderboard — ONE board: all-time taps.
// Rendered in-game as a ranked list (rank / name / taps, your row highlighted).
//
// Score sync: on device the provider drives @openforge/capacitor-game-connect
// to submit taps to Game Center (iOS) / Google Play Games (Android) and can
// open the official platform overlay. The in-game list itself uses a seeded
// placeholder population until real global data is wired at publish (the
// platform services or a tiny score API can back it — same render path).
//
// Publish-time setup:
//  - App Store Connect -> Game Center -> create the taps leaderboard -> ios id
//  - Play Console -> Play Games Services -> create it -> android id
//  - npm i @openforge/capacitor-game-connect && npx cap sync
// ---------------------------------------------------------------------------

export const BOARD = {
  name: 'All-Time Taps',
  ios: import.meta.env.VITE_GAME_CENTER_LEADERBOARD_ID ?? '',
  android: import.meta.env.VITE_PLAY_GAMES_LEADERBOARD_ID ?? '',
};

export interface LeaderboardProvider {
  /** 'gamecenter' | 'playgames' | 'web' */
  readonly platform: string;
  signIn(): Promise<boolean>;
  submit(taps: number): Promise<void>;
  /** Opens the platform's official leaderboard overlay (native only). */
  show(): Promise<void>;
}

class LocalLeaderboard implements LeaderboardProvider {
  readonly platform = 'web';
  async signIn() { return false; }
  async submit(taps: number) {
    const best = Number(localStorage.getItem('lb-best-taps') ?? 0);
    if (taps > best) localStorage.setItem('lb-best-taps', String(taps));
  }
  async show() { /* the in-game RANKS list is the display on web */ }
}

class GameConnectLeaderboard implements LeaderboardProvider {
  readonly platform: string;
  private signedIn = false;

  constructor(private plugin: any, isIOS: boolean) {
    this.platform = isIOS ? 'gamecenter' : 'playgames';
  }

  private get boardId() { return this.platform === 'gamecenter' ? BOARD.ios : BOARD.android; }

  async signIn(): Promise<boolean> {
    try { await this.plugin.signIn(); this.signedIn = true; }
    catch { this.signedIn = false; }
    return this.signedIn;
  }

  async submit(taps: number) {
    if (!this.boardId) return;
    if (!this.signedIn && !(await this.signIn())) return;
    try {
      await this.plugin.submitScore({ leaderboardID: this.boardId, totalScoreAmount: Math.floor(taps) });
    } catch { /* offline / not configured — resubmits on next defeat */ }
  }

  async show() {
    if (!this.boardId) return;
    if (!this.signedIn && !(await this.signIn())) return;
    try { await this.plugin.showLeaderboard({ leaderboardID: this.boardId }); } catch { /* ignore */ }
  }
}

export async function initLeaderboards(): Promise<LeaderboardProvider> {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    try {
      // Keep this as a real Vite import so the JavaScript bridge is included
      // in the packaged WebView bundle. An ignored bare import cannot be
      // resolved by an Android WebView and silently disabled Play Games.
      const mod = await import('@ni2khanna/capacitor-game-connect');
      return new GameConnectLeaderboard(mod.CapacitorGameConnect, cap.getPlatform() === 'ios');
    } catch { /* plugin not installed yet — fall through to local */ }
  }
  return new LocalLeaderboard();
}

// ---- worldwide list ---------------------------------------------------------

export interface LbEntry { rank: number; name: string; taps: number; you: boolean; }

/** Submit the player's raw tap total to the real backend (fire-and-forget). */
export function submitScoreRemote(apiUrl: string, name: string, taps: number) {
  fetch(`${apiUrl}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, taps: Math.floor(taps) }),
  }).catch(() => { /* offline — next defeat resubmits */ });
}

/** Fetch the real worldwide board: top 10 + the caller's neighborhood. */
export async function fetchBoardRemote(apiUrl: string, name: string): Promise<LbEntry[] | null> {
  try {
    const token = localStorage.getItem('discipline-account-token-v1');
    const res = await fetch(`${apiUrl}/v1/board`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    const data = await res.json();
    const rows: LbEntry[] = data.top ?? [];
    const entries: LbEntry[] = rows.map((r, i) => ({ ...r, rank: r.rank ?? i + 1,
      you: r.you || (!!name && r.name.toLowerCase() === name.toLowerCase()) }));
    if (data.me && !entries.some(e => e.you)) {
      entries.push({ rank: data.me.rank, name: data.me.name, taps: data.me.taps, you: true });
    }
    return entries;
  } catch { return null; }
}

/** Ranked worldwide list with the player's row inserted and highlighted. */
export function getWorldList(playerTaps: number, playerName = 'YOU'): LbEntry[] {
  // Never fabricate competitors. Until the authenticated backend responds,
  // show only the local player as preview data.
  return [{ rank: 1, name: playerName, taps: Math.floor(playerTaps), you: true }];
}
