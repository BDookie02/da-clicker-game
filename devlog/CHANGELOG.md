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

## 2026-07-09-08-fury-face.png
**Build state:** usernames + escalating driver anger.
- **Unique username system**: claim modal on first launch (can't be dismissed
  until a name is secured), 3-14 chars, case-insensitive uniqueness so names
  can't be re-registered or sniped by case variants. Renames cost 100K Respect
  (RANKS panel). Behind a `UsernameService` interface — local registry now,
  atomic insert-if-absent API at launch. All 49 rival names permanently
  reserved. First live claim: "TheCreator".
- **Drivers rage as you tap**: face redraws at every shake milestone — skin
  flushes toward beet red, brows angle into a V, eyes narrow, pupils go red,
  mouth goes neutral line → frown → gritted teeth, forehead vein at max fury.
  Anger restores correctly on save load mid-opponent.
- Leaderboard YOU row now shows your claimed username.

## 2026-07-09-09-new-route-prestige.png
**Build state:** ship-readiness pass — balance, prestige, polish.
- **Balance retune, simulation-backed**: procedural curve 1.55x → 1.8x per
  light; late handcrafted gaps widened (Demon 3.2M, Sigma 14M,
  DISCIPLINE. 60M). Sim showed 1.55 collapsing into trivial progress by
  day 30 while 1.8 keeps lights as session goals with steady daily motion.
  Boosters and base tap economy untouched (they're the fun + the revenue).
- **New Route prestige**: unlocks at light 15 (+10 per route). Two-tap
  confirm resets the run for a PERMANENT x2 respect multiplier; keeps
  Mentality, garage, username, raw tap total. Verified end-to-end.
- **Mute toggle** in the HUD, persisted.
- **App icons** (512/192/apple-touch) generated by a zero-dependency PNG
  writer — pixel traffic light with a goop drip — plus PWA manifest.
- SHIPPING.md added: everything code-side is done; remaining items are
  account/dashboard work (Higgsfield OAuth, AdMob, store consoles, name API).

## 2026-07-09-10-character-art-og.png / -discipline.png
**Build state:** full automation pass — art, backend, native scaffolds.
- **Original character art** for all 10 handcrafted opponents: distinct 48px
  pixel characters (The O.G. with stubble, MENTALITY's cap, green cube-headed
  Blockhead, yellow ball-faced Easy Face, masked Mercenary, beanie'd Subway
  Stranger, hatted+bandana'd Steel Cowboy, horned Demon Face, suited+shades
  Sigma, glowing haloed DISCIPLINE.). All anger-reactive; procedural
  opponents keep seeded variant looks. Original designs — archetype homage,
  no copied character art.
- **Real backend written and deploy-ready** (server/worker.js + schema.sql +
  wrangler.toml): Cloudflare Worker + D1 with atomic username claims
  (UNIQUE constraint — no race can steal a name), score upsert, and a
  worldwide board endpoint (top 10 + caller neighborhood). Client fully
  wired behind `API_URL` in src/config.ts: empty = local placeholders,
  set = live worldwide board + real name registry. Three commands to deploy.
- **Native projects generated**: android/ (Gradle) and ios/ (Xcode) via
  Capacitor, web bundle synced. Open in Android Studio / Xcode and run.

## 2026-07-09-11-roster-gymbro-pickup.png / -samurai-wedge.png
**Build state:** content expansion — 4x the handcrafted roster.
- **40 named opponents** (was 10), each with a unique original character:
  act 2 (Gym Bro, The NPC, Doomer, Bloomer, The Yapper, Crypto Uncle, Aura
  Farmer, Granny Torque, The Mime, Cone Kingpin), act 3 professionals
  (Valet Prime, Chef Redline, Det. Yellowlight, The Surgeon, Off-Duty
  Lifeguard, Grounded Astronaut, The Conductor, Beekeeper, The Librarian,
  Final Delivery), act 4 legends (Traffic Knight, Lane Pharaoh, Roundabout
  Viking, Signal Samurai, Parking Pirate, Gridlock Wizard, Visitor 51,
  Unit T-RAFFIC, Count Idle, The Chrononaut). Requirements continue the
  simulation-tuned 1.8x curve out to ~2.75e15 taps at light 40.
- **3 new car styles**: pickup (open bed), wedge (low sports), taxi (roof
  sign) — used across the roster and the endless procedural pool.
- **Character feature system expanded**: hairstyles (mohawk/afro/spiky/long),
  beards, mustaches, headphones, eyepatches, visors, crowns, helmets, chef
  and wizard hats, face paint — endless procedural drivers now draw from the
  full combinatorial space, so repeats are effectively never.
- **4 new districts/skies** (Storm Docks, Toxic Flats, Noir Quarter, Mint
  Boulevard) — 10 districts total on the 10-light rotation.
- **13 new garage cosmetics** (goop colors, decals, skies, ornaments, horn).
- Procedural name/blurb pools widened (24x24 name combos).

## 2026-07-09-12-fourlane-eyecontact.png / -green-eyes-on-road.png / -next-light-arrival.png
**Build state:** positioning + camera rework to final spec.
- **One-way 4-lane road**: lane dividers at three positions, solid edge
  lines, full-width stop line and crosswalk. Player parked in lane 2
  (driver's seat eye point at the left seat), opponent parallel in lane 1,
  4 units apart, both nose-down the road at the light.
- **Gaze state machine**: at a red light the head smoothly turns left for
  eye contact with the opponent; on green it automatically swings back to
  face the road, holds forward through the drive, then turns to the next
  opponent at the next light. (Bug fixed en route: the slerp helper must be
  a THREE.Camera — Object3D.lookAt aims +z, cameras view -z, which pointed
  the head 180° away.)
- **Cockpit fixed to the car, not the head** — dash/hood/wheel stay put
  when you look left; wheel moved in front of the driver's seat; A-pillars
  moved to the windshield line so the side view is clean glass.
- Traffic light box recentered over the two middle lanes.
- Verified full cycle in-browser with real taps: eye contact -> goop ->
  green -> eyes-on-road drive -> arrival -> head turns to Blockhead.

## (no capture) 2026-07-10 — store-ready native integration
- **Real AdMob rewarded ads coded end-to-end** (src/ads.ts):
  `@capacitor-community/admob@8` installed and synced into android/ + ios/;
  provider grants only on the SDK's Rewarded event; ships on Google's
  official public TEST ids (app ids wired into AndroidManifest.xml and
  Info.plist) so device ads work before any account exists. Production =
  paste 2 unit ids + 2 app ids, set TESTING false.
- Game Center / Play Games plugin installed & synced (dynamic import was
  already wired).
- **81 native assets generated**: Android mipmap launcher icons (incl.
  adaptive fg/bg), portrait/land/dark splash screens, iOS AppIcon + splash
  set — all from the original pixel traffic-light art via @capacitor/assets.
- iOS ATT usage string + SKAdNetwork entry added.
- Ad watch-verification re-verified after the refactor (background-tab
  timer throttling correctly pauses the placeholder countdown — the
  anti-cheat working as designed).

## 2026-07-10-13-title-screen.png
**Build state:** game finalization pass.
- **Title screen**: PS1-style card (DISCIPLINE. / "a red light story" /
  TAP TO ENGAGE) — first tap dismisses it without counting as a game tap
  and unlocks WebAudio.
- **Final-art drop-in system**: any PNG at `public/sprites/<slot>.png`
  automatically replaces that character's procedural sprite at runtime
  (nearest-filtered; anger becomes a red tint + shake). Zero code changes
  to swap art.
- **Art pipeline packaged**: docs/ART-PIPELINE.md (30-second Higgsfield
  OAuth instructions — the one step that requires an interactive session)
  + docs/sprite-manifest.json with a generation prompt for every one of
  the 50 sprite slots, all describing our original character designs.
- **Horn cosmetics are real now**: Sad Violin and Freight Airhorn actually
  play (synthesized) when an opponent gets finished.
- **Haptics**: vibration on shake milestones (scaling with tier) and the
  goop event, on devices that support it.

## 2026-07-10-14-abreast-eyecontact.png / -abreast-forward.png
**Build state:** positioning corrected to truly side-by-side.
- The opponent was sitting 3+ meters ahead (diagonal, not parallel). Now
  both cars are ABREAST: front bumpers even at the stop line, drivers
  side by side, eye contact straight across the lane (~82° head turn) —
  the opponent's window fills the side view with the driver dead center.
- Nose alignment is per body style: limos/metros extend behind you like
  real long vehicles instead of poking through the crosswalk.
- Stop line moved to just past the bumpers, crosswalk and traffic light
  brought to the actual intersection you're stopped at — the forward
  (green-light) view now has the light hanging directly overhead.
