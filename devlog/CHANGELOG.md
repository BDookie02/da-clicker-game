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
