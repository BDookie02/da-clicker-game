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
  ios: 'grp.dclicker.taps',
  android: 'REPLACE_WITH_PLAY_CONSOLE_ID_taps',
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
    if (!this.signedIn && !(await this.signIn())) return;
    try {
      await this.plugin.submitScore({ leaderboardID: this.boardId, totalScoreAmount: Math.floor(taps) });
    } catch { /* offline / not configured — resubmits on next defeat */ }
  }

  async show() {
    if (!this.signedIn && !(await this.signIn())) return;
    try { await this.plugin.showLeaderboard({ leaderboardID: this.boardId }); } catch { /* ignore */ }
  }
}

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
  return new LocalLeaderboard();
}

// ---- worldwide list (placeholder population) -------------------------------
// 49 seeded rivals whose scores are fixed "skill curves" — as your taps grow
// you genuinely overtake them one by one, so the list feels alive. Swapped
// for real platform/global data at publish; the UI render path is identical.

export interface LbEntry { rank: number; name: string; taps: number; you: boolean; }

const RIVAL_NAMES = [
  'TapGod_99', 'xX_Mentality_Xx', 'RedLightRonnie', 'WristWarrior', 'GoopDodger',
  'SigmaCommuter', 'NapkinCollector', 'IdleHands77', 'CrosswalkKing', 'GreenLightGwen',
  'StoplightStan', 'ClutchCadence', 'TurnSignalTina', 'BlinkerBoi', 'HornHonker3000',
  'LaneChanger', 'YellowLightYolo', 'PedalPusher', 'DashCamDan', 'RushHourRick',
  'GridlockGary', 'MericaMotors', 'VibeCheckVal', 'NoBlinkNate', 'FocusFiend',
  'DisciplineDee', 'MonkModeMike', 'GrindsetGreg', 'LockedInLou', 'EyeContactEd',
  'StaringSteve', 'UnbotheredUma', 'PatientPete', 'CalmCarl', 'ZenZeke',
  'TapTitan', 'ClickerChamp', 'FingerFlash', 'ThumbThunder', 'RapidRita',
  'SteadyEddie', 'MellowMel', 'ChillChad', 'CoolHandCleo', 'SmoothSammy',
  'TrafficTsar', 'IntersectionIvy', 'BoulevardBex', 'AvenueAce',
];

function rivalCurve(i: number): { base: number; mult: number } {
  // deterministic per-rival skill: log-spread so the board spans casuals->gods
  let a = ((i + 1) * 2654435761) >>> 0;
  a ^= a >>> 13; a = Math.imul(a, 1274126177) >>> 0; a ^= a >>> 16;
  const r = a / 4294967296;
  return {
    base: Math.floor(50 + r * 4000),                       // head start
    mult: Math.pow(10, (i % 7) * 0.55 + r * 0.5) * 0.02,   // growth vs you
  };
}

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
    const res = await fetch(`${apiUrl}/board?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const rows: { name: string; taps: number }[] = data.top ?? [];
    const entries: LbEntry[] = rows.map((r, i) => ({
      rank: i + 1, name: r.name, taps: r.taps,
      you: !!name && r.name.toLowerCase() === name.toLowerCase(),
    }));
    if (data.me && !entries.some(e => e.you)) {
      entries.push({ rank: data.me.rank, name: data.me.name, taps: data.me.taps, you: true });
    }
    return entries;
  } catch { return null; }
}

/** Ranked worldwide list with the player's row inserted and highlighted. */
export function getWorldList(playerTaps: number, playerName = 'YOU'): LbEntry[] {
  const rows = RIVAL_NAMES.map((name, i) => {
    const { base, mult } = rivalCurve(i);
    return { name, taps: Math.floor(base + playerTaps * mult), you: false };
  });
  rows.push({ name: playerName, taps: Math.floor(playerTaps), you: true });
  rows.sort((a, b) => b.taps - a.taps);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
