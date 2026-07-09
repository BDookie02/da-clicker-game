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

## Remaining — needs you
1. **Art pass** — authorize the Higgsfield MCP: run `/mcp` in an interactive
   Claude Code session in this folder, approve OAuth. Then Claude generates
   character art for the sprite slots (`char_og` ... `char_gen_39`), cosmetic
   icons, and store screenshots from devlog captures.
2. **Native projects** — install Android Studio (+SDK) and/or access a Mac
   with Xcode, then:
   `npm run build && npx cap add android && npx cap add ios && npx cap sync`
3. **AdMob** — create an AdMob account + app, add
   `@capacitor-community/admob`, create a Rewarded ad unit, implement the
   `AdProvider` swap in src/ui.ts with the real unit IDs.
4. **Leaderboards** — App Store Connect -> Game Center and Play Console ->
   Play Games Services: create the "All-Time Taps" board on each, paste IDs
   into `BOARD` in src/leaderboard.ts, and
   `npm i @openforge/capacitor-game-connect && npx cap sync`.
5. **Username API** — stand up the atomic name registry (Cloudflare Worker
   KV or Firebase; name = unique key, insert-if-absent) and swap
   `LocalUsernameService` in src/main.ts.
6. **Store listings** — developer accounts ($99/yr Apple, $25 Google),
   screenshots (devlog/ has plenty), description, and content rating
   questionnaires. Expect 17+ / Mature-humor rating for the goop.
