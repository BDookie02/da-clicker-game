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

## Remaining — accounts only (your part)
1. **Cloudflare (free)** — deploy the backend, ~3 commands:
   `npm i -g wrangler && wrangler login`
   `wrangler d1 create discipline-db`  (paste id into wrangler.toml)
   `wrangler d1 execute discipline-db --file=server/schema.sql --remote`
   `wrangler deploy`
   Then set `API_URL` in src/config.ts to the worker URL and `npm run build`.
2. **AdMob** — account + app + Rewarded unit; add
   `@capacitor-community/admob`; swap the placeholder in `AdProvider`
   (src/ui.ts) with the real unit IDs.
3. **Android Studio** (free) — open android/, press Run for a debug APK;
   Play Console ($25 one-time) to publish.
4. **Apple** — Mac with Xcode; open ios/App; Apple Developer ($99/yr).
5. **Platform leaderboards (optional, native)** — Game Center / Play Games
   board IDs into `BOARD` (src/leaderboard.ts) +
   `npm i @openforge/capacitor-game-connect && npx cap sync`.
6. **Store listings** — screenshots (devlog/ is full of them), description,
   content rating. Expect 17+ / Mature-humor for the goop.
