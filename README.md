# DISCIPLINE. — da clicker game

A PS1-styled city idle-clicker. You're stopped at a red light. The car in the
next lane is shaking. You know the meme. Tap until the goop happens, the light
turns green, and roll on to the next opponent.

Built as a themed reimagining of the classic idle-colonizer loop: tap currency,
idle generators, staged progression, milestone rewards — reskinned around the
discipline car meme.

## Gameplay

- **Tap** anywhere to build **Respect**. The opponent's car shakes harder at
  25% / 50% / 75% / 90% milestones, then gets covered in white goop at 100%.
  Green light. You're free to go. Next light, next opponent.
- **Opponents**: 10 handcrafted meme-lineage rivals (The O.G., MENTALITY,
  Blockhead, Easy Face, The Mercenary, Subway Stranger, Steel Cowboy,
  Demon Face, The Sigma, DISCIPLINE.), then endless procedurally-assembled
  opponents (seeded names, paint, car styles) so no two lights feel the same.
- **Districts**: the environment re-skins every 10 lights (day downtown,
  sunset suburbs, vaporwave strip, fog industrial, midnight, dawn highway).
- **Upgrades** (tap power) and **Crew** (idle taps/sec).
- **Garage**: aesthetic unlockables bought with **Mentality** (earned per
  opponent defeated) — decals, ornaments, goop colors, skies, horns.
- **Boosters**: watch a (placeholder) rewarded ad for 2x/5x/10x multipliers.
  No daily limit. Longer ad, fatter boost.
- Autosaves to localStorage; earns offline at 50% rate (8h cap).

## Tech

- **Vite + TypeScript + Three.js**, zero binary assets — every texture is
  generated on canvas, every sound synthesized in WebAudio.
- **Authentic PS1 pipeline**: native 320×240-class render target with
  nearest-neighbor upscale, clip-space vertex snapping (GTE fixed-point
  wobble), vertex-lit flat shading, 15-bit color crush + 4×4 Bayer ordered
  dithering, point-filtered 64px textures, short-draw-distance fog.
- 2D character sprites mount on a named anchor at each opponent's driver
  window (`sprite:<slot>`), facing the player — art lands via the Higgsfield
  MCP pipeline (vehicles intentionally empty until then).

## Develop

```sh
npm install
npm run dev      # dev server (also enables devlog capture endpoint)
npm run build    # typecheck + production build to dist/
```

Dev helpers on `window`: `__game` (state), `__shot(name)` (save PNG to
devlog/), `__rec(name, seconds)` (save WebM to devlog/).

## Ship to iOS / Android

The app is a static web bundle (`dist/`), designed for Capacitor:

```sh
npm i -D @capacitor/core @capacitor/cli
npx cap init "DISCIPLINE." com.nosiah.discipline --web-dir dist
npx cap add android   # needs Android Studio
npx cap add ios       # needs Xcode on macOS
npm run build && npx cap sync
```

Rewarded ads: the game calls a single `AdProvider.show(lengthSec)` interface
(src/ui.ts). Swap the placeholder for `@capacitor-community/admob` RewardedAd
for store builds. Note: the goop humor likely lands a 17+ rating; plan App
Review positioning accordingly.

Worldwide leaderboards (🏆 RANKS menu): `LeaderboardProvider` (src/leaderboard.ts)
submits **Red Lights Cleared** and **Lifetime Taps** to Game Center / Google
Play Games on every opponent defeated. Publish checklist:

1. `npm i @openforge/capacitor-game-connect && npx cap sync`
2. App Store Connect → Game Center → create both leaderboards → paste IDs
   into `BOARD_IDS.*.ios`
3. Play Console → Play Games Services → create both leaderboards → paste IDs
   into `BOARD_IDS.*.android`

## Asset pipeline (next phase)

Higgsfield MCP (hosted, OAuth: `https://mcp.higgsfield.ai/mcp`) generates the
2D discipline-meme character sprites and cosmetic art. Slots are already wired:
`char_og`, `char_mentality`, `char_blockhead`, `char_easyface`, `char_merc`,
`char_metro`, `char_cowboy`, `char_demon`, `char_sigma`, `char_discipline`,
plus 40 rotating `char_gen_*` slots for procedural opponents.

## Devlog

Screenshots and recordings of development milestones live in `devlog/`.
