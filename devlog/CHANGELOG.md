# Devlog — capture-by-capture changelog

Every screenshot/recording in this folder gets an entry here describing what
changed in the build at the moment it was taken.

---

## 2026-07-08-01-daytime-redlight.png
**Build state:** first fully-playable build.
- Complete game scaffold: Vite + TypeScript + Three.js, PS1 pipeline (320×240
  render target, vertex snapping, Bayer dither, point-filtered textures).
- Fixed the linear→sRGB gamma bug that made the first render pitch black.
- Switched default time-of-day to **daytime** and repositioned the opponent
  car **parallel in the next lane** (was wrongly angled nose-in, "kissing").
- Traffic light arm extended into the camera frame; buildings pushed off the
  road edge.

## 2026-07-08-02-first-goop-event.webm
**Build state:** same as above — first recorded full loop.
- 10s recording of ~1050 automated taps: shake milestone tiers escalate,
  MENTALITY (opponent 2) hits 100%, goop event fires (34 blobs + drips +
  26 splat particles), green light, drive-off transition, arrival at
  RED LIGHT 3 (Blockhead).

## 2026-07-08-03-boosted-cosmetic-test.png
**Build state:** systems verification pass.
- Rewarded-ad booster verified live: x10 multiplier active, tap value 1→10,
  ads-watched counter incrementing.
- Garage purchase path verified: First Napkin Ornament bought with Mentality
  and equipped (dash ornament renders in cockpit).
- District system wired: environment re-skins every 10 lights, first district
  fixed to day.

## 2026-07-08-04-transparent-windows.png
**Build state:** adjustment pass #1 (user feedback).
- Car glass is now **see-through** (PSX-style semi-transparency, 35% opacity)
  so the future driver characters are visible.
- All car interiors got **empty seats** (front buckets on unibody styles,
  bench in the cube) so vehicles read as empty, not hollow.
- Character sprite mount moved to the actual **driver's seat**, head-height,
  billboard-facing the player — meme-accurate eye contact through the glass.
- Ad rewards are now **watch-verified**: the countdown only credits time while
  the page is visible (hiding the tab pauses it), there is no skip/dismiss,
  and the claim can't resolve before full watch time accumulates. Production
  AdMob provider will rely on SDK reward events + server-side verification.

## 2026-07-09-05-worldwide-ranks-panel.png
**Build state:** adjustment pass #2 — worldwide leaderboards.
- New 🏆 RANKS menu: two worldwide boards — **Red Lights Cleared** and
  **Lifetime Taps** — behind a swappable `LeaderboardProvider` interface.
- On device it drives Game Center (iOS) / Google Play Games (Android) via
  the Capacitor game-connect plugin: sign-in, auto score submit on every
  opponent defeated, and the platform's native worldwide leaderboard overlay.
- Web build falls back to local personal-best tracking with the native
  actions gated off ("DEVICE ONLY").
- Board IDs are placeholders until the App Store Connect / Play Console
  leaderboards are created at publish time (documented in README).

## 2026-07-09-06-taps-leaderboard-list.png
**Build state:** adjustment pass #3 — leaderboard redesigned as a ranked list.
- Single board now: **All-Time Taps** only (Red Lights Cleared board removed).
- RANKS renders an in-game ranked list (mobile-runner style): medals for the
  top 3, top 10 shown, a ··· gap, then your neighborhood (±2 ranks) with
  **⭐ YOU** highlighted in gold.
- 49 seeded placeholder rivals with fixed skill curves — the player genuinely
  overtakes them one by one as taps accumulate (verified: YOU at #28 with
  3.59K, 40 taps behind #27). Swapped for real global data at store launch;
  the render path is identical.
- Native sync unchanged: taps auto-submit to Game Center / Play Games on
  every opponent defeated.

## 2026-07-09-07-visible-drivers.png
**Build state:** adjustment pass #4 + continued dev.
- **Drivers are visible now.** Car cabins rebuilt as glass greenhouses (with a
  body-colored roof slab) instead of opaque boxes with glass skins — the old
  structure entombed the interior. Glass opacity dropped to 22%.
- Every opponent gets a **procedural placeholder driver**: seeded 32px
  pixel-art head-and-shoulders billboard (skin/hair/shirt variations),
  wide-open eyes locked on the player. THREE.Sprite always faces the camera,
  so eye contact never breaks. Swapped for real meme art via the asset
  pipeline later.
- **Menu UX:** tapping anywhere outside an open menu closes it (the closing
  tap doesn't count as a game tap), and starting a booster ad auto-closes
  whatever menu is open — no stacked overlays anywhere.
- **Raw-tap guarantee** documented in code and labeled in the RANKS panel:
  the worldwide score counts physical taps only; boosters multiply Respect,
  never the tap count.
- Capacitor scaffolding added (capacitor.config.ts + deps) so native iOS /
  Android packaging is `npx cap add <platform>` away.
