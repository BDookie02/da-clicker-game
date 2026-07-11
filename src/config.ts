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
  carStyle: 'sedan' | 'hatch' | 'cube' | 'van' | 'lowrider' | 'muscle' | 'metro' | 'limo' | 'compact' | 'divine' | 'pickup' | 'wedge' | 'taxi';
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
  // -- act 2: the city gets weirder --------------------------------------------
  { id: 'gymbro',    name: 'Gym Bro',         blurb: 'Never skips leg day. Skips every green light.',                       tapsRequired: 1.08e8,  carColor: 0xd84a4a, carAccent: 0x8e2222, carStyle: 'pickup',   mentalityReward: 230, spriteSlot: 'char_gymbro' },
  { id: 'npc',       name: 'The NPC',         blurb: 'Same three sentences. Unbreakable eye contact.',                      tapsRequired: 1.95e8,  carColor: 0x9a9a9a, carAccent: 0x6e6e6e, carStyle: 'sedan',    mentalityReward: 245, spriteSlot: 'char_npc' },
  { id: 'doomer',    name: 'Doomer',          blurb: 'Knows the light will never change. Waits anyway.',                    tapsRequired: 3.5e8,   carColor: 0x2e3440, carAccent: 0x1a1e26, carStyle: 'hatch',    mentalityReward: 260, spriteSlot: 'char_doomer' },
  { id: 'bloomer',   name: 'Bloomer',         blurb: 'Grateful for this red light, actually.',                              tapsRequired: 6.3e8,   carColor: 0x7ac47a, carAccent: 0x4a8a4a, carStyle: 'compact',  mentalityReward: 280, spriteSlot: 'char_bloomer' },
  { id: 'yapper',    name: 'The Yapper',      blurb: 'Has been mid-sentence since you pulled up.',                          tapsRequired: 1.13e9,  carColor: 0xe08ab0, carAccent: 0x9a5a7a, carStyle: 'taxi',     mentalityReward: 300, spriteSlot: 'char_yapper' },
  { id: 'cryptouncle',name:'Crypto Uncle',    blurb: 'The van is an office. The office is down 97%.',                       tapsRequired: 2.0e9,   carColor: 0xc9a227, carAccent: 0x7a6214, carStyle: 'van',      mentalityReward: 325, spriteSlot: 'char_cryptouncle' },
  { id: 'aurafarmer',name: 'Aura Farmer',     blurb: 'Every second of eye contact is +50 aura for him.',                    tapsRequired: 3.7e9,   carColor: 0x8a3ab0, carAccent: 0x5a2472, carStyle: 'wedge',    mentalityReward: 350, spriteSlot: 'char_aurafarmer' },
  { id: 'granny',    name: 'Granny Torque',   blurb: 'Sweetest lady on the block. Revs like a demon.',                      tapsRequired: 6.6e9,   carColor: 0xb8a8d8, carAccent: 0x7a6a9a, carStyle: 'lowrider', mentalityReward: 380, spriteSlot: 'char_granny' },
  { id: 'mime',      name: 'The Mime',        blurb: 'Honks silently. Somehow you hear it.',                                tapsRequired: 1.2e10,  carColor: 0xe8e8e8, carAccent: 0x2a2a2e, carStyle: 'compact',  mentalityReward: 410, spriteSlot: 'char_mime' },
  { id: 'kingpin',   name: 'Cone Kingpin',    blurb: 'Runs the construction zone. The cones obey him.',                     tapsRequired: 2.15e10, carColor: 0xe8862a, carAccent: 0x9a5214, carStyle: 'pickup',   mentalityReward: 445, spriteSlot: 'char_kingpin' },
  // -- act 3: professionals ----------------------------------------------------
  { id: 'valet',     name: 'Valet Prime',     blurb: 'Parks cars. Yours is next whether you like it or not.',               tapsRequired: 3.9e10,  carColor: 0x2a2a2e, carAccent: 0xc9a227, carStyle: 'limo',     mentalityReward: 480, spriteSlot: 'char_valet' },
  { id: 'chef',      name: 'Chef Redline',    blurb: 'His engine is always at a rolling boil.',                             tapsRequired: 7.0e10,  carColor: 0xe8e0d0, carAccent: 0xb03a3a, carStyle: 'van',      mentalityReward: 520, spriteSlot: 'char_chef' },
  { id: 'detective', name: 'Det. Yellowlight',blurb: 'Investigating who keeps finishing at this light. It is him.',         tapsRequired: 1.26e11, carColor: 0x8a7a5c, carAccent: 0x4a4234, carStyle: 'sedan',    mentalityReward: 560, spriteSlot: 'char_detective' },
  { id: 'surgeon',   name: 'The Surgeon',     blurb: 'Steady hands. Unsettling focus.',                                     tapsRequired: 2.27e11, carColor: 0x7ab8c8, carAccent: 0x4a7a8a, carStyle: 'wedge',    mentalityReward: 600, spriteSlot: 'char_surgeon' },
  { id: 'lifeguard', name: 'Off-Duty Lifeguard', blurb: 'No water for miles. Whistle fully operational.',                   tapsRequired: 4.08e11, carColor: 0xe8482a, carAccent: 0x9a2e1a, carStyle: 'pickup',   mentalityReward: 650, spriteSlot: 'char_lifeguard' },
  { id: 'astronaut', name: 'Grounded Astronaut', blurb: 'Cleared for launch. Denied by the light.',                         tapsRequired: 7.35e11, carColor: 0xd8d8e0, carAccent: 0x8a8a9a, carStyle: 'cube',     mentalityReward: 700, spriteSlot: 'char_astronaut' },
  { id: 'conductor', name: 'The Conductor',   blurb: 'Left the orchestra. The baton stayed.',                               tapsRequired: 1.3e12,  carColor: 0x1c1c22, carAccent: 0xe8e0d0, carStyle: 'limo',     mentalityReward: 760, spriteSlot: 'char_conductor' },
  { id: 'beekeeper', name: 'Beekeeper',       blurb: 'The van hums. It is not the engine.',                                 tapsRequired: 2.4e12,  carColor: 0xe8c84a, carAccent: 0x2a2a2e, carStyle: 'van',      mentalityReward: 820, spriteSlot: 'char_beekeeper' },
  { id: 'librarian', name: 'The Librarian',   blurb: 'Shushed your engine. It worked.',                                     tapsRequired: 4.3e12,  carColor: 0x6a4a2e, carAccent: 0x3a2818, carStyle: 'hatch',    mentalityReward: 880, spriteSlot: 'char_librarian' },
  { id: 'mailman',   name: 'Final Delivery',  blurb: 'One package left. It is addressed to you.',                           tapsRequired: 7.7e12,  carColor: 0x4a6ab0, carAccent: 0x2e4472, carStyle: 'metro',    mentalityReward: 950, spriteSlot: 'char_mailman' },
  // -- act 4: legends ----------------------------------------------------------
  { id: 'knight',    name: 'Traffic Knight',  blurb: 'Sworn to guard this intersection. Also to menace it.',                tapsRequired: 1.4e13,  carColor: 0x8a8a9a, carAccent: 0x4a4a5a, carStyle: 'muscle',   mentalityReward: 1020, spriteSlot: 'char_knight' },
  { id: 'pharaoh',   name: 'Lane Pharaoh',    blurb: 'His dynasty has held the left lane for 3,000 years.',                 tapsRequired: 2.5e13,  carColor: 0xc9a227, carAccent: 0x2a6a8a, carStyle: 'lowrider', mentalityReward: 1100, spriteSlot: 'char_pharaoh' },
  { id: 'viking',    name: 'Roundabout Viking', blurb: 'Raids roundabouts. Refuses to yield.',                              tapsRequired: 4.5e13,  carColor: 0x5a4a3a, carAccent: 0x8a2e1a, carStyle: 'pickup',   mentalityReward: 1180, spriteSlot: 'char_viking' },
  { id: 'samurai',   name: 'Signal Samurai',  blurb: 'Honor demands he wait. Honor says nothing about staring.',            tapsRequired: 8.1e13,  carColor: 0xb03a3a, carAccent: 0x1c1c22, carStyle: 'wedge',    mentalityReward: 1270, spriteSlot: 'char_samurai' },
  { id: 'pirate',    name: 'Parking Pirate',  blurb: 'Buried treasure under every meter. Never paid one.',                  tapsRequired: 1.46e14, carColor: 0x2a2a2e, carAccent: 0xc9a227, carStyle: 'van',      mentalityReward: 1370, spriteSlot: 'char_pirate' },
  { id: 'wizard',    name: 'Gridlock Wizard', blurb: 'Cast the spell that made every light red. Including his.',            tapsRequired: 2.62e14, carColor: 0x4a2a8a, carAccent: 0xc9a227, carStyle: 'cube',     mentalityReward: 1480, spriteSlot: 'char_wizard' },
  { id: 'alien',     name: 'Visitor 51',      blurb: 'Crossed the galaxy. Stuck at your light.',                            tapsRequired: 4.72e14, carColor: 0x4ae0c0, carAccent: 0x2a8a72, carStyle: 'divine',   mentalityReward: 1600, spriteSlot: 'char_alien' },
  { id: 'robot',     name: 'Unit T-RAFFIC',   blurb: 'Programmed for patience. Firmware update: menace.',                   tapsRequired: 8.5e14,  carColor: 0x6a7a8a, carAccent: 0x3a4a5a, carStyle: 'muscle',   mentalityReward: 1730, spriteSlot: 'char_robot' },
  { id: 'vampire',   name: 'Count Idle',      blurb: 'Cannot enter the intersection uninvited.',                            tapsRequired: 1.53e15, carColor: 0x1c1016, carAccent: 0x8e1f1f, carStyle: 'limo',     mentalityReward: 1870, spriteSlot: 'char_vampire' },
  { id: 'timetraveler', name: 'The Chrononaut', blurb: 'Has seen this light turn green in 40 timelines. Not this one.',     tapsRequired: 2.75e15, carColor: 0xb87a2a, carAccent: 0x4ae0c0, carStyle: 'taxi',     mentalityReward: 2000, spriteSlot: 'char_timetraveler' },
];

// --- procedural opponents after the handcrafted 10 -------------------------
// Mix-and-match generator so no two lights feel the same: seeded style, paint,
// name, and flavor. Combined with district themes this gives effectively
// endless non-repeating content for replay value.
const NAME_A = ['Turbo', 'Silent', 'Grinding', 'Unbothered', 'Feral', 'Humble', 'Menacing', 'Locked-In', 'Zen', 'Rogue', 'Midnight', 'Caffeinated', 'Stoic', 'Unhinged', 'Patient', 'Certified', 'Ancient', 'Sleepless', 'Polite', 'Cracked', 'Undefeated', 'Suburban', 'Nocturnal', 'Freshly-Waxed'];
const NAME_B = ['Mentor', 'Intern', 'Uncle', 'Prophet', 'Valet', 'Landlord', 'Sensei', 'Streamer', 'Accountant', 'Gymrat', 'Philosopher', 'Doordasher', 'Detective', 'Salesman', 'Monarch', 'Janitor', 'Barber', 'Plumber', 'Bassist', 'Realtor', 'Lifeguard', 'Mechanic', 'Barista', 'Mayor'];
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
const STYLES: OpponentDef['carStyle'][] = ['sedan', 'hatch', 'cube', 'compact', 'van', 'metro', 'lowrider', 'muscle', 'limo', 'pickup', 'wedge', 'taxi'];
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
  { name: 'Storm Docks',        sky: 'storm',  buildingHue: 0x1a2026 },
  { name: 'Toxic Flats',        sky: 'toxic',  buildingHue: 0x1c2416 },
  { name: 'Noir Quarter',       sky: 'noir',   buildingHue: 0x101014 },
  { name: 'Mint Boulevard',     sky: 'mint',   buildingHue: 0x1c2a24 },
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
// Steep cost growth (1.33–1.42) so income can't trivially max everything —
// each level is a real decision, not a spam-buy.
export const UPGRADES: UpgradeDef[] = [
  { id: 'focus',    name: 'Focus',            desc: '+1 respect per tap. Lock in.',                       baseCost: 25,      costGrowth: 1.33, tapAdd: 1 },
  { id: 'grip',     name: 'Grip Strength',    desc: '+5 per tap. Years of training.',                     baseCost: 400,     costGrowth: 1.34, tapAdd: 5 },
  { id: 'wrist',    name: 'Wrist Cardio',     desc: '+25 per tap. Unmatched endurance.',                  baseCost: 6000,    costGrowth: 1.36, tapAdd: 25 },
  { id: 'posture',  name: 'Sigma Posture',    desc: '+120 per tap. Sit up straight at the light.',        baseCost: 90000,   costGrowth: 1.38, tapAdd: 120 },
  { id: 'eyecont',  name: 'Eye Contact',      desc: 'x2 tap power. Never blink first.',                   baseCost: 1500000, costGrowth: 12.0, tapAdd: 0, tapMult: 2, maxLevel: 8 },
  { id: 'mindset',  name: 'Monk Mindset',     desc: '+900 per tap. Inner peace, outer violence.',         baseCost: 1500000, costGrowth: 1.42, tapAdd: 900 },
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
  { id: 'hypeman',  name: 'Hype Man',          desc: 'Rides shotgun. Taps for you.',            baseCost: 120,     costGrowth: 1.32, tapsPerSec: 1 },
  { id: 'backseat', name: 'Backseat Guy',      desc: 'How did he even get in here?',            baseCost: 1600,    costGrowth: 1.33, tapsPerSec: 8 },
  { id: 'camera',   name: 'Street Cameraman',  desc: 'Films everything vertically.',            baseCost: 20000,   costGrowth: 1.34, tapsPerSec: 45 },
  { id: 'editor',   name: 'TikTok Editor',     desc: 'Adds the caption in real time.',          baseCost: 260000,  costGrowth: 1.36, tapsPerSec: 260 },
  { id: 'coach',    name: 'Discipline Coach',  desc: 'Screams "MENTALITY" out the window.',     baseCost: 3500000, costGrowth: 1.38, tapsPerSec: 1600 },
  { id: 'monk',     name: 'Traffic Monk',      desc: 'Meditates on the hood. Radiates focus.',  baseCost: 45000000,costGrowth: 1.40, tapsPerSec: 10000 },
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
  { id: 'orn_napkin',   name: 'First Napkin Ornament', desc: 'A napkin on the dash. Historic.',              cost: 50,  slot: 'ornament', value: '#e8e4d8' },
  { id: 'decal_ment',   name: '"MENTALITY" Decal',     desc: 'Top text for your windshield.',                cost: 75,  slot: 'decal',    value: 'MENTALITY' },
  { id: 'decal_disc',   name: '"discipline" Decal',    desc: 'Bottom text. Lowercase. Powerful.',            cost: 75,  slot: 'decal',    value: 'discipline' },
  { id: 'goop_gold',    name: 'Golden Goop',           desc: 'The finish of champions.',                     cost: 200,  slot: 'goop',     value: '#e6c84a' },
  { id: 'goop_slime',   name: 'Toxic Goop',            desc: 'Radioactive green. Unsanitary.',               cost: 200,  slot: 'goop',     value: '#7be04a' },
  { id: 'sky_sunset',   name: 'Golden Hour',           desc: 'Cinematic sunset for your edits.',             cost: 125,  slot: 'sky',      value: 'sunset' },
  { id: 'sky_vapor',    name: 'Vaporwave Night',       desc: 'A E S T H E T I C intersection.',              cost: 125,  slot: 'sky',      value: 'vapor' },
  { id: 'horn_sad',     name: 'Sad Violin Horn',       desc: 'Plays when opponents finish.',                 cost: 150,  slot: 'horn',     value: 'violin' },
  { id: 'dash_gd',      name: 'Difficulty Face Dice',  desc: 'Fuzzy dice, but they judge you.',              cost: 100,  slot: 'dash',     value: 'gd' },
  { id: 'orn_cowboy',   name: 'Tiny Steel Cowboy',     desc: 'Bobblehead doing a pose on your dash.',        cost: 175,  slot: 'ornament', value: '#7a4a9e' },
  { id: 'decal_bottom', name: '"bottom text" Decal',   desc: 'The caption completes itself.',                cost: 100,  slot: 'decal',    value: 'bottom text' },
  { id: 'decal_aura',   name: '"AURA +1000" Decal',    desc: 'Certified aura farming equipment.',            cost: 125,  slot: 'decal',    value: 'AURA +1000' },
  { id: 'decal_engage', name: '"DO NOT ENGAGE" Decal', desc: 'They will engage anyway.',                     cost: 125,  slot: 'decal',    value: 'DO NOT ENGAGE' },
  { id: 'goop_pink',    name: 'Bubblegum Goop',        desc: 'Smells like victory and strawberries.',        cost: 225,  slot: 'goop',     value: '#f0a0c8' },
  { id: 'goop_blue',    name: 'Wiper Fluid Goop',      desc: 'Technically car-related.',                     cost: 225,  slot: 'goop',     value: '#4a9ae0' },
  { id: 'goop_oil',     name: 'Crude Oil Goop',        desc: 'Environmentally devastating finish.',          cost: 300,  slot: 'goop',     value: '#1c1c22' },
  { id: 'sky_storm',    name: 'Stormchaser',           desc: 'Permanent dramatic weather.',                  cost: 150,  slot: 'sky',      value: 'storm' },
  { id: 'sky_noir',     name: 'Film Noir',             desc: 'The city knows what it did.',                  cost: 150,  slot: 'sky',      value: 'noir' },
  { id: 'sky_toxic',    name: 'Toxic Hour',            desc: 'The air is 40% regret.',                       cost: 150,  slot: 'sky',      value: 'toxic' },
  { id: 'sky_mint',     name: 'Mint Condition',        desc: 'Refreshing. Suspiciously so.',                 cost: 150,  slot: 'sky',      value: 'mint' },
  { id: 'orn_cone',     name: 'Tiny Traffic Cone',     desc: 'A fallen soldier from the Kingpin wars.',      cost: 125,  slot: 'ornament', value: '#e8862a' },
  { id: 'orn_monk',     name: 'Dashboard Monk',        desc: 'Radiates focus onto your steering wheel.',     cost: 225,  slot: 'ornament', value: '#e8c84a' },
  { id: 'horn_air',     name: 'Freight Airhorn',       desc: 'Startles opponents mid-shake.',                cost: 175,  slot: 'horn',     value: 'airhorn' },
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

// Backend (usernames + worldwide taps board). Empty string = local placeholder
// providers. After deploying server/worker.js (see file header), set this to
// the worker URL, e.g. 'https://discipline-api.<account>.workers.dev'
export const API_URL = '';
