# DISCIPLINE.

DISCIPLINE. is a portrait, PS1-styled idle clicker set at an endless series of
red lights. Hold eye contact, tap for Respect, build a Crew, upgrade your route,
and outlast increasingly unhinged rivals.

## Game

- Tap while facing the rival to earn Respect and fill the current light.
- Watch the opposing car and driver react at 25%, 50%, 75%, and 90% progress.
- Recruit Crew for idle Respect and buy upgrades for stronger taps.
- Take New Routes for permanent progression.
- Drive through changing city districts and an extended opponent roster.
- Look around smoothly in both the main first-person view and the garage.
- Customize the player car with six fixed dashboard mounts, mirror danglers,
  decals, goop finishes, horns, sky styles, and a roof-mounted taxi sign.
- Use separate music, effects, and engine volume controls plus FOV, look
  sensitivity, reduced motion, four text-size tiers, and optional haptics.
- Follow a skippable first-launch tutorial that keeps unrelated controls locked
  until each highlighted step is complete.

Respect is earned by playing. Mentality (M) is separate premium currency: it is
granted only by verified store purchases or a completed rewarded ad. Booster
ads never grant M. Closing an ad early or failing verification grants nothing.

## Accounts and rankings

The included platform-neutral account service provides unique usernames,
cross-device cloud saves, durable inventory, verified purchase recovery, and a
real-player leaderboard. Fake ranked fillers are not used. Google Play Games
provides the Android platform leaderboard overlay; a future iOS build can use
Game Center while the same DISCIPLINE. account continues to own portable game
progress.

Production accounts require the Worker and D1 service in `server/`. The game
remains playable offline for a previously authenticated player, but paid
purchases, rewarded-ad grants, rankings, and cloud synchronization require a
connection.

## Android support

- Package: `com.nosiah.discipline`
- Minimum: Android 7 / API 24
- Target and compile SDK: API 36
- Store format: signed Android App Bundle

The Android build uses Capacitor, Google Mobile Ads rewarded ads, Google Play
Billing, and Play Games Services. Release builds fail closed when production
IDs, the deployed account API, store art, or upload signing configuration are
missing.

## Development

```powershell
cmd /c npm install
cmd /c npm test
cmd /c npm run build:test
cmd /c npm run android:test:apk
```

`build:test` deliberately uses Google's public test ad units. Development-only
visual-audit handles are excluded from a normal production bundle.

## Play release

Configure the ignored production files and external services described in
`SHIPPING.md`, then run exactly:

```powershell
cmd /c npm run release:play
```

That command runs the tests and release preflight, creates a fresh production
web bundle, synchronizes that exact bundle into Android, verifies that the
packaged payload matches it byte-for-byte, runs release lint, builds the signed
AAB, and verifies its signature. It never uploads or publishes anything.

Do not build a Play candidate with `gradlew bundleRelease` alone, and do not
upload an older AAB or APK from the repository root.

## Architecture

- Vite + TypeScript
- Three.js low-resolution pixel/PS1 rendering
- Capacitor Android/iOS shells
- Cloudflare Worker + D1 account and verification service
- Google Mobile Ads rewarded ads with signed server-side verification
- Google Play Billing with server verification and a durable transaction ledger
- Google Play Games / Game Center leaderboard adapters

Store listing copy, Data Safety notes, privacy deployment notes, and the
release checklist are in `docs/` and `SHIPPING.md`.
