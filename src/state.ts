import {
  BOOSTERS, COSMETICS, CREW, SAVE_KEY, SHAKE_TIERS, UPGRADES,
  getOpponent, type BoosterDef,
} from './config';

export interface SaveData {
  username: string | null;
  prestiges: number;        // completed "New Routes"
  respect: number;
  mentality: number;
  totalTaps: number;
  opponentIndex: number;
  opponentProgress: number;            // taps landed on the current opponent
  upgradeLevels: Record<string, number>;
  crewCounts: Record<string, number>;
  ownedCosmetics: string[];
  equippedCosmetics: Partial<Record<string, string>>; // slot -> cosmetic id
  boostMult: number;
  boostEndsAt: number;                 // epoch ms
  lastSeen: number;                    // epoch ms, for offline earnings
  adsWatched: number;
}

const fresh = (): SaveData => ({
  username: null,
  prestiges: 0,
  respect: 0,
  mentality: 0,
  totalTaps: 0,
  opponentIndex: 0,
  opponentProgress: 0,
  upgradeLevels: {},
  crewCounts: {},
  ownedCosmetics: [],
  equippedCosmetics: {},
  boostMult: 1,
  boostEndsAt: 0,
  lastSeen: Date.now(),
  adsWatched: 0,
});

export type GameEvent =
  | { type: 'tap'; gain: number }
  | { type: 'milestone'; tier: number; label: string }
  | { type: 'defeated'; mentality: number; name: string }
  | { type: 'boost'; mult: number; seconds: number }
  | { type: 'offline'; gain: number; seconds: number }
  | { type: 'prestige'; count: number };

// New Route (prestige): unlocks at light 15, then +10 lights per route taken.
export const PRESTIGE_BASE = 15;
export const PRESTIGE_STEP = 10;

type Listener = (e: GameEvent) => void;

export class Game {
  s: SaveData;
  private listeners: Listener[] = [];
  private lastTier = 0;

  constructor() {
    this.s = this.load();
    this.applyOffline();
    this.lastTier = this.currentTier();
  }

  on(fn: Listener) { this.listeners.push(fn); }
  private emit(e: GameEvent) { for (const fn of this.listeners) fn(e); }

  // ---- derived values -----------------------------------------------------
  get opponent() { return getOpponent(this.s.opponentIndex); }

  get progress01() {
    return Math.min(1, this.s.opponentProgress / this.opponent.tapsRequired);
  }

  currentTier(): number {
    const p = this.progress01;
    let tier = 0;
    SHAKE_TIERS.forEach((t, i) => { if (p >= t.at) tier = i; });
    return tier;
  }

  get shakeAmp(): number { return SHAKE_TIERS[this.currentTier()].amp; }

  get boostActive(): boolean { return Date.now() < this.s.boostEndsAt; }
  get activeMult(): number { return this.boostActive ? this.s.boostMult : 1; }

  /** Permanent x2 respect per completed New Route. */
  get routeMult(): number { return Math.pow(2, this.s.prestiges); }
  get prestigeRequirement(): number { return PRESTIGE_BASE + PRESTIGE_STEP * this.s.prestiges; }
  get canPrestige(): boolean { return this.s.opponentIndex >= this.prestigeRequirement; }

  get respectPerTap(): number {
    let add = 1;
    let mult = 1;
    for (const u of UPGRADES) {
      const lv = this.s.upgradeLevels[u.id] ?? 0;
      add += u.tapAdd * lv;
      if (u.tapMult) mult *= Math.pow(u.tapMult, lv);
    }
    return Math.round(add * mult * this.activeMult * this.routeMult);
  }

  get respectPerSec(): number {
    let rps = 0;
    for (const c of CREW) rps += (this.s.crewCounts[c.id] ?? 0) * c.tapsPerSec;
    return Math.round(rps * this.activeMult * this.routeMult);
  }

  upgradeCost(id: string): number {
    const u = UPGRADES.find(x => x.id === id)!;
    const lv = this.s.upgradeLevels[id] ?? 0;
    return Math.round(u.baseCost * Math.pow(u.costGrowth, lv));
  }

  crewCost(id: string): number {
    const c = CREW.find(x => x.id === id)!;
    const n = this.s.crewCounts[id] ?? 0;
    return Math.round(c.baseCost * Math.pow(c.costGrowth, n));
  }

  // ---- actions --------------------------------------------------------------
  tap() {
    const gain = this.respectPerTap;
    this.s.respect += gain;
    // totalTaps is RAW physical input only — always +1, never multiplied by
    // boosters/upgrades, never fed by idle crew. It backs the worldwide board.
    this.s.totalTaps += 1;
    this.advance(gain);
    this.emit({ type: 'tap', gain });
  }

  /** idle tick — call with elapsed seconds */
  tick(dt: number) {
    const gain = this.respectPerSec * dt;
    if (gain > 0) {
      this.s.respect += gain;
      this.advance(gain);
    }
    if (!this.boostActive && this.s.boostMult !== 1) this.s.boostMult = 1;
  }

  private advance(amount: number) {
    this.s.opponentProgress += amount;
    const tier = this.currentTier();
    if (tier > this.lastTier) {
      this.lastTier = tier;
      this.emit({ type: 'milestone', tier, label: SHAKE_TIERS[tier].label });
    }
    if (this.s.opponentProgress >= this.opponent.tapsRequired) {
      const beaten = this.opponent;
      this.s.mentality += beaten.mentalityReward;
      this.s.opponentIndex += 1;
      this.s.opponentProgress = 0;
      this.lastTier = 0;
      this.emit({ type: 'defeated', mentality: beaten.mentalityReward, name: beaten.name });
    }
  }

  /** New Route: reset the run for a permanent x2 respect multiplier.
   *  Keeps mentality, cosmetics, username, raw tap total, ads watched. */
  prestige(): boolean {
    if (!this.canPrestige) return false;
    this.s.prestiges += 1;
    this.s.respect = 0;
    this.s.opponentIndex = 0;
    this.s.opponentProgress = 0;
    this.s.upgradeLevels = {};
    this.s.crewCounts = {};
    this.s.boostMult = 1;
    this.s.boostEndsAt = 0;
    this.lastTier = 0;
    this.save();
    this.emit({ type: 'prestige', count: this.s.prestiges });
    return true;
  }

  buyUpgrade(id: string): boolean {
    const u = UPGRADES.find(x => x.id === id)!;
    const lv = this.s.upgradeLevels[id] ?? 0;
    if (u.maxLevel && lv >= u.maxLevel) return false;
    const cost = this.upgradeCost(id);
    if (this.s.respect < cost) return false;
    this.s.respect -= cost;
    this.s.upgradeLevels[id] = lv + 1;
    return true;
  }

  buyCrew(id: string): boolean {
    const cost = this.crewCost(id);
    if (this.s.respect < cost) return false;
    this.s.respect -= cost;
    this.s.crewCounts[id] = (this.s.crewCounts[id] ?? 0) + 1;
    return true;
  }

  buyCosmetic(id: string): boolean {
    const c = COSMETICS.find(x => x.id === id)!;
    if (this.s.ownedCosmetics.includes(id) || this.s.mentality < c.cost) return false;
    this.s.mentality -= c.cost;
    this.s.ownedCosmetics.push(id);
    this.s.equippedCosmetics[c.slot] = id;
    return true;
  }

  toggleCosmetic(id: string) {
    const c = COSMETICS.find(x => x.id === id)!;
    if (!this.s.ownedCosmetics.includes(id)) return;
    this.s.equippedCosmetics[c.slot] =
      this.s.equippedCosmetics[c.slot] === id ? undefined : id;
  }

  equipped(slot: string): string | undefined {
    const id = this.s.equippedCosmetics[slot];
    return id ? COSMETICS.find(c => c.id === id)?.value : undefined;
  }

  /** Called by the ad service after a rewarded ad completes. No daily cap. */
  grantBooster(b: BoosterDef) {
    const now = Date.now();
    if (this.boostActive && this.s.boostMult === b.mult) {
      this.s.boostEndsAt += b.durationSec * 1000;       // same tier: extend
    } else if (!this.boostActive || b.mult >= this.s.boostMult) {
      this.s.boostMult = b.mult;                        // higher tier: replace
      this.s.boostEndsAt = now + b.durationSec * 1000;
    } else {
      this.s.boostEndsAt += (b.durationSec * 1000) / 2; // lower tier: extend half
    }
    this.s.adsWatched += 1;
    this.emit({ type: 'boost', mult: this.s.boostMult, seconds: Math.round((this.s.boostEndsAt - now) / 1000) });
  }

  // ---- persistence ----------------------------------------------------------
  private load(): SaveData {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) return { ...fresh(), ...JSON.parse(raw) };
    } catch { /* corrupted save -> start fresh */ }
    return fresh();
  }

  save() {
    this.s.lastSeen = Date.now();
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.s));
  }

  private applyOffline() {
    const away = Math.min((Date.now() - this.s.lastSeen) / 1000, 8 * 3600); // cap 8h
    if (away > 30) {
      let rps = 0;
      for (const c of CREW) rps += (this.s.crewCounts[c.id] ?? 0) * c.tapsPerSec;
      const gain = Math.round(rps * away * 0.5); // offline earns at 50%
      if (gain > 0) {
        this.s.respect += gain;
        this.s.opponentProgress += gain;
        // clamp: offline can at most bring the current opponent to 99%
        this.s.opponentProgress = Math.min(this.s.opponentProgress, this.opponent.tapsRequired - 1);
        queueMicrotask(() => this.emit({ type: 'offline', gain, seconds: Math.round(away) }));
      }
    }
  }
}

export const BOOSTER_DEFS = BOOSTERS;

export function fmt(n: number): string {
  if (n < 1000) return Math.floor(n).toString();
  const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
  let u = -1;
  let v = n;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0) + units[u];
}
