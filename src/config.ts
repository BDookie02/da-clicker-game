// ---------------------------------------------------------------------------
// DISCIPLINE. — game balance & content data
// Economy mirrors the classic idle-clicker loop: tap currency (Respect),
// premium currency (Mentality), tap-power upgrades, idle generators (Crew),
// staged opponents (the "planets"), cosmetic unlockables, and ad boosters.
// All art is placeholder — 2D character sprites get mounted later (Higgsfield).
// ---------------------------------------------------------------------------

export interface OpponentDef {
  id: string;
  name: string;
  blurb: string;          // flavor text shown when you pull up to the light
  tapsRequired: number;   // total respect-taps to finish this opponent
  carColor: number;       // body paint
  carAccent: number;      // trim/roof
  carStyle: 'sedan' | 'hatch' | 'cube' | 'van' | 'lowrider' | 'muscle' | 'metro' | 'limo' | 'compact' | 'divine';
  mentalityReward: number;
  spriteSlot: string;     // asset key for the future 2D character billboard
}

// Opponent pipeline — each one is the next red light. Names/flavor reference
// the discipline car meme lineage (original sketch, "Mentality" caption edit,
// and the popular recreation styles). All placeholder visuals, no ripped assets.
export const OPPONENTS: OpponentDef[] = [
  { id: 'og',        name: 'The O.G.',        blurb: 'The one who started it all. Maintains eye contact. Refuses to stop.', tapsRequired: 100,        carColor: 0x8a7a5c, carAccent: 0x5c5140, carStyle: 'sedan',    mentalityReward: 5,   spriteSlot: 'char_og' },
  { id: 'mentality', name: 'MENTALITY',       blurb: 'Top text. He IS the caption.',                                        tapsRequired: 650,        carColor: 0xd8d8d8, carAccent: 0x888888, carStyle: 'hatch',    mentalityReward: 8,   spriteSlot: 'char_mentality' },
  { id: 'blockhead', name: 'Blockhead',       blurb: 'Built different. Literally out of cubes.',                            tapsRequired: 3200,       carColor: 0x6fa243, carAccent: 0x4a6e2e, carStyle: 'cube',     mentalityReward: 12,  spriteSlot: 'char_blockhead' },
  { id: 'easyface',  name: 'Easy Face',       blurb: 'Rated: Easy. This will not be easy.',                                 tapsRequired: 14000,      carColor: 0x4aa8e0, carAccent: 0x2d6f99, carStyle: 'compact',  mentalityReward: 18,  spriteSlot: 'char_easyface' },
  { id: 'merc',      name: 'The Mercenary',   blurb: 'Straight out of a source engine render. Mumbles about sandwiches.',   tapsRequired: 52000,      carColor: 0xb04a3a, carAccent: 0x6e2d24, carStyle: 'van',      mentalityReward: 25,  spriteSlot: 'char_merc' },
  { id: 'metro',     name: 'Subway Stranger', blurb: 'Not even a car. He brought the whole metro cart to the light.',       tapsRequired: 190000,     carColor: 0x9aa0a8, carAccent: 0x3d4148, carStyle: 'metro',    mentalityReward: 35,  spriteSlot: 'char_metro' },
  { id: 'cowboy',    name: 'Steel Cowboy',    blurb: 'He took the first Napkin. He will take this light too.',              tapsRequired: 700000,     carColor: 0x7a4a9e, carAccent: 0x4d2d66, carStyle: 'lowrider', mentalityReward: 50,  spriteSlot: 'char_cowboy' },
  { id: 'demon',     name: 'Demon Face',      blurb: 'Rated: Extreme Demon. 0.1% of players pass this light.',              tapsRequired: 3200000,    carColor: 0x2a2a2e, carAccent: 0x8e1f1f, carStyle: 'muscle',   mentalityReward: 75,  spriteSlot: 'char_demon' },
  { id: 'sigma',     name: 'The Sigma',       blurb: 'Grindset engaged. His limo idles louder than your engine.',           tapsRequired: 14000000,   carColor: 0xc9a227, carAccent: 0x8a6d14, carStyle: 'limo',     mentalityReward: 110, spriteSlot: 'char_sigma' },
  { id: 'discipline',name: 'DISCIPLINE.',     blurb: 'The final light. Pure white. Pure focus. Bottom text.',               tapsRequired: 60000000,   carColor: 0xf2f2f2, carAccent: 0xcfcfcf, carStyle: 'divine',   mentalityReward: 200, spriteSlot: 'char_discipline' },
];

// --- procedural opponents after the handcrafted 10 -------------------------
// Mix-and-match generator so no two lights feel the same: seeded style, paint,
// name, and flavor. Combined with district themes this gives effectively
// endless non-repeating content for replay value.
const NAME_A = ['Turbo', 'Silent', 'Grinding', 'Unbothered', 'Feral', 'Humble', 'Menacing', 'Locked-In', 'Zen', 'Rogue', 'Midnight', 'Caffeinated', 'Stoic', 'Unhinged', 'Patient', 'Certified'];
const NAME_B = ['Mentor', 'Intern', 'Uncle', 'Prophet', 'Valet', 'Landlord', 'Sensei', 'Streamer', 'Accountant', 'Gymrat', 'Philosopher', 'Doordasher', 'Detective', 'Salesman', 'Monarch', 'Janitor'];
const BLURBS = [
  'Pulled up. Locked eyes. Zero remorse.',
  'His engine idles in 4/4. Yours stutters.',
  'He has been at this light since Tuesday.',
  'Does not blink. Physically cannot.',
  'The window is down. The mentality is up.',
  'You can smell the discipline from here.',
  'His playlist is one song. It is on loop.',
  'Local legend. Regional menace.',
  'He nodded at you. It felt like a threat.',
  'Somewhere, a caption writes itself.',
];
const STYLES: OpponentDef['carStyle'][] = ['sedan', 'hatch', 'cube', 'compact', 'van', 'metro', 'lowrider', 'muscle', 'limo'];
const PAINTS = [0xb03a3a, 0x3a6ab0, 0x3ab06a, 0xb08a3a, 0x8a3ab0, 0x3aa8a0, 0xc0c0c8, 0x30303a, 0xd87a3a, 0x6a8a4a, 0x9a4a6a, 0x4a5a8a];

function seeded(n: number) {
  let a = (n * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getOpponent(index: number): OpponentDef {
  if (index < OPPONENTS.length) return OPPONENTS[index];
  const n = index - OPPONENTS.length;           // 0-based procedural index
  const r = seeded(index);
  const last = OPPONENTS[OPPONENTS.length - 1];
  const paint = PAINTS[Math.floor(r() * PAINTS.length)];
  return {
    id: `gen${index}`,
    name: `${NAME_A[Math.floor(r() * NAME_A.length)]} ${NAME_B[Math.floor(r() * NAME_B.length)]}`,
    blurb: BLURBS[Math.floor(r() * BLURBS.length)],
    // 1.8x per light — simulation-tuned so lights stay session goals instead
    // of trending easier forever (1.55 collapsed by ~day 30, 2.1 walled out)
    tapsRequired: Math.round(last.tapsRequired * Math.pow(1.8, n + 1)),
    carColor: paint,
    carAccent: Math.max(0, paint - 0x202020),
    carStyle: STYLES[Math.floor(r() * STYLES.length)],
    mentalityReward: last.mentalityReward + (n + 1) * 25,
    spriteSlot: `char_gen_${index % 40}`,       // 40 rotating sprite slots for the art pass
  };
}

// District themes — the whole environment re-skins every 10 red lights.
export interface DistrictDef { name: string; sky: string; buildingHue: number; }
export const DISTRICTS: DistrictDef[] = [
  { name: 'Downtown',           sky: 'day',    buildingHue: 0x16161e },
  { name: 'Golden Suburbs',     sky: 'sunset', buildingHue: 0x2a2018 },
  { name: 'Neon Strip',         sky: 'vapor',  buildingHue: 0x1a1030 },
  { name: 'Fog Industrial',     sky: 'fog',    buildingHue: 0x20242a },
  { name: 'Midnight Downtown',  sky: 'night',  buildingHue: 0x14141c },
  { name: 'Dawn Highway',       sky: 'dawn',   buildingHue: 0x24202c },
];
export function getDistrict(opponentIndex: number): DistrictDef {
  return DISTRICTS[Math.floor(opponentIndex / 10) % DISTRICTS.length];
}

// Shake escalates through milestone tiers as the opponent's bar fills.
export const SHAKE_TIERS = [
  { at: 0.0,  amp: 0.010, label: '' },
  { at: 0.25, amp: 0.028, label: 'The car starts shaking...' },
  { at: 0.5,  amp: 0.055, label: 'The shaking intensifies.' },
  { at: 0.75, amp: 0.100, label: 'VIOLENT shaking.' },
  { at: 0.9,  amp: 0.170, label: 'CRITICAL. Do not break eye contact.' },
];

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  baseCost: number;
  costGrowth: number;   // cost multiplier per level
  tapAdd: number;       // flat respect-per-tap added per level
  tapMult?: number;     // multiplicative respect-per-tap per level
  maxLevel?: number;
}

// Tap-power upgrades (the "technology" track)
export const UPGRADES: UpgradeDef[] = [
  { id: 'focus',    name: 'Focus',            desc: '+1 respect per tap. Lock in.',                       baseCost: 15,      costGrowth: 1.15, tapAdd: 1 },
  { id: 'grip',     name: 'Grip Strength',    desc: '+5 per tap. Years of training.',                     baseCost: 200,     costGrowth: 1.16, tapAdd: 5 },
  { id: 'wrist',    name: 'Wrist Cardio',     desc: '+25 per tap. Unmatched endurance.',                  baseCost: 2500,    costGrowth: 1.17, tapAdd: 25 },
  { id: 'posture',  name: 'Sigma Posture',    desc: '+120 per tap. Sit up straight at the light.',        baseCost: 30000,   costGrowth: 1.18, tapAdd: 120 },
  { id: 'eyecont',  name: 'Eye Contact',      desc: 'x2 tap power. Never blink first.',                   baseCost: 500000,  costGrowth: 8.0,  tapAdd: 0, tapMult: 2, maxLevel: 8 },
  { id: 'mindset',  name: 'Monk Mindset',     desc: '+900 per tap. Inner peace, outer violence.',         baseCost: 400000,  costGrowth: 1.19, tapAdd: 900 },
];

export interface CrewDef {
  id: string;
  name: string;
  desc: string;
  baseCost: number;
  costGrowth: number;
  tapsPerSec: number;   // passive respect per second per unit
}

// Idle generators (the "crew of astronauts" track)
export const CREW: CrewDef[] = [
  { id: 'hypeman',  name: 'Hype Man',          desc: 'Rides shotgun. Taps for you.',            baseCost: 60,      costGrowth: 1.15, tapsPerSec: 1 },
  { id: 'backseat', name: 'Backseat Guy',      desc: 'How did he even get in here?',            baseCost: 800,     costGrowth: 1.15, tapsPerSec: 8 },
  { id: 'camera',   name: 'Street Cameraman',  desc: 'Films everything vertically.',            baseCost: 9000,    costGrowth: 1.16, tapsPerSec: 45 },
  { id: 'editor',   name: 'TikTok Editor',     desc: 'Adds the caption in real time.',          baseCost: 95000,   costGrowth: 1.16, tapsPerSec: 260 },
  { id: 'coach',    name: 'Discipline Coach',  desc: 'Screams "MENTALITY" out the window.',     baseCost: 1000000, costGrowth: 1.17, tapsPerSec: 1600 },
  { id: 'monk',     name: 'Traffic Monk',      desc: 'Meditates on the hood. Radiates focus.',  baseCost: 12000000,costGrowth: 1.18, tapsPerSec: 10000 },
];

export interface CosmeticDef {
  id: string;
  name: string;
  desc: string;
  cost: number;          // Mentality
  slot: 'ornament' | 'decal' | 'goop' | 'sky' | 'horn' | 'dash';
  value: string;         // renderer hint (color hex, style key, etc.)
}

// Aesthetic unlockables (the reskinned "milestone rewards") — all meme-themed.
export const COSMETICS: CosmeticDef[] = [
  { id: 'orn_napkin',   name: 'First Napkin Ornament', desc: 'A napkin on the dash. Historic.',              cost: 10,  slot: 'ornament', value: '#e8e4d8' },
  { id: 'decal_ment',   name: '"MENTALITY" Decal',     desc: 'Top text for your windshield.',                cost: 15,  slot: 'decal',    value: 'MENTALITY' },
  { id: 'decal_disc',   name: '"discipline" Decal',    desc: 'Bottom text. Lowercase. Powerful.',            cost: 15,  slot: 'decal',    value: 'discipline' },
  { id: 'goop_gold',    name: 'Golden Goop',           desc: 'The finish of champions.',                     cost: 40,  slot: 'goop',     value: '#e6c84a' },
  { id: 'goop_slime',   name: 'Toxic Goop',            desc: 'Radioactive green. Unsanitary.',               cost: 40,  slot: 'goop',     value: '#7be04a' },
  { id: 'sky_sunset',   name: 'Golden Hour',           desc: 'Cinematic sunset for your edits.',             cost: 25,  slot: 'sky',      value: 'sunset' },
  { id: 'sky_vapor',    name: 'Vaporwave Night',       desc: 'A E S T H E T I C intersection.',              cost: 25,  slot: 'sky',      value: 'vapor' },
  { id: 'horn_sad',     name: 'Sad Violin Horn',       desc: 'Plays when opponents finish.',                 cost: 30,  slot: 'horn',     value: 'violin' },
  { id: 'dash_gd',      name: 'Difficulty Face Dice',  desc: 'Fuzzy dice, but they judge you.',              cost: 20,  slot: 'dash',     value: 'gd' },
  { id: 'orn_cowboy',   name: 'Tiny Steel Cowboy',     desc: 'Bobblehead doing a pose on your dash.',        cost: 35,  slot: 'ornament', value: '#7a4a9e' },
];

export interface BoosterDef {
  id: string;
  name: string;
  desc: string;
  adSeconds: number;     // placeholder ad length (maps to rewarded-ad tiers)
  mult: number;          // tap + idle multiplier
  durationSec: number;
}

// Ad boosters — unlimited watches. Longer ad = fatter multiplier.
export const BOOSTERS: BoosterDef[] = [
  { id: 'quick', name: 'Quick Clip',    desc: 'Watch a 5s ad → 2x everything for 90s.',   adSeconds: 5,  mult: 2,  durationSec: 90 },
  { id: 'mid',   name: 'Full Ad',       desc: 'Watch a 15s ad → 5x everything for 120s.', adSeconds: 15, mult: 5,  durationSec: 120 },
  { id: 'mega',  name: 'Director\'s Cut', desc: 'Watch a 30s ad → 10x everything for 90s.', adSeconds: 30, mult: 10, durationSec: 90 },
];

export const SAVE_KEY = 'discipline-clicker-save-v1';
