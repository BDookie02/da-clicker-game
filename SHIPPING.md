# Shipping checklist — DISCIPLINE.

Code-complete items are done. What remains is account/dashboard work and
machine setup that requires a human.

## Done (code-side)
- [x] Full game loop, balance simulation-tuned (1.8x procedural curve)
- [x] New Route prestige (light 15, +10 per route, permanent x2 respect)
- [x] Unique usernames (1M Respect rename) behind `UsernameService`
- [x] Rewarded-ad boosters, verified watch, auto-redeem, behind `AdProvider`
- [x] Worldwide All-Time Taps leaderboard list behind `LeaderboardProvider`
- [x] Escalating driver rage, PS1 pipeline, procedural opponents + districts
- [x] Save/offline earnings, mute toggle, app icons, PWA manifest
- [x] Capacitor config (`com.nosiah.discipline`)

## Also done (this pass)
- [x] Original character art for all 10 handcrafted opponents (48px pixel
  characters, anger-reactive; procedural opponents get seeded variants).
  Optional upgrade later: Higgsfield MCP art (authorize via `/mcp` in an
  interactive session) can replace any sprite via the same mount system.
- [x] Backend written & deploy-ready: server/worker.js (Cloudflare Worker +
  D1, atomic name claims, score board), schema.sql, wrangler.toml. Client
  wired behind `API_URL` in src/config.ts.
- [x] Native projects generated: android/ (Gradle) and ios/ (Xcode), web
  bundle synced.

## Also done (final automation pass)
- [x] **AdMob fully integrated** — `@capacitor-community/admob@8` installed
  and synced into both native projects. `AdMobAdProvider` (src/ads.ts) shows
  real rewarded video on device, granting only on the SDK reward event.
  Ships pointed at Google's official PUBLIC TEST ids (app ids already in
  AndroidManifest.xml + Info.plist), so ads work on device with NO account.
- [x] **Game Center / Play Games plugin** installed & synced
  (`@openforge/capacitor-game-connect`).
- [x] **Native launcher icons + splash screens** generated for both
  platforms (81 assets via @capacitor/assets from the pixel traffic light).
- [x] iOS ATT usage string + SKAdNetwork entry in Info.plist.

## Remaining — literally just accounts (your part)
1. **Cloudflare (free, ~3 min)** — deploy the backend:
   `npm i -g wrangler && wrangler login`
   `wrangler d1 create discipline-db`  (paste id into wrangler.toml)
   `wrangler d1 execute discipline-db --file=server/schema.sql --remote`
   `wrangler deploy`
   Then set `API_URL` in src/config.ts to the worker URL, `npm run build`.
2. **Android** — install Android Studio (free), open `android/`, press Run:
   the game runs on a phone/emulator with WORKING test ads immediately.
   Play Console ($25 one-time) when publishing.
3. **Apple** — Mac with Xcode, open `ios/App`. Apple Developer ($99/yr) to
   publish. (Note: if Xcode complains about game-connect + SPM, that plugin
   is optional — the game runs without it; the in-game board still works.)
4. **AdMob account** — create app + one Rewarded unit per platform, paste
   the two ids into `AD_CONFIG.prodRewarded*` (src/ads.ts), set
   `TESTING: false`, paste the two APP ids into AndroidManifest.xml and
   Info.plist. That's the entire ad setup.
5. **Platform leaderboards (optional)** — Game Center / Play Games board
   ids into `BOARD` (src/leaderboard.ts).
6. **Store listings** — screenshots (devlog/ is full of them), description,
   content rating. Expect 17+ / Mature-humor for the goop.
