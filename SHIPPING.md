# DISCIPLINE. release checklist

## Verified in this repository

- Android package: `com.nosiah.discipline`; minSdk 24 (Android 7), target/compile SDK 36.
- Debug runtime tested on Android 12 / API 31. Android 7 / API 24 and API 36
  must be rerun against each final release candidate.
- Rewarded AdMob integration grants only from the SDK reward event. Checked-in defaults are Google test IDs.
- Seven Google Play one-time product IDs are wired: `m_handful`, `m_stack`, `m_pouch`, `m_crate`, `m_vault`, `m_hoard`, `m_empire`.
- Purchases are queued before verification, verified server-side with Google/Apple, recorded in a unique transaction ledger, then granted once.
- A purchase completed before login remains pending and is attached after login. Store recovery finds unfinished purchases after reinstall. The shared Discipline account cloud save carries progress, inventory, and verified grants between Android and iOS.
- Usernames are unique in D1 and filtered on both client and server. Fake leaderboard fillers are removed.
- Google Play Games submission/overlay and the required Android manifest metadata are wired. A real Play Games app ID and leaderboard ID are still required.
- Accessibility settings include four persistent universal text sizes, reduced motion, FOV/look sensitivity, individual audio levels, and optional graduated haptics (subtle taps through strong defeat explosions).
- A 13-step first-launch tutorial spotlights each required control, blocks unrelated touch input, supports an always-visible Skip option, and persists completion/skip so it never repeats for that account save.
- `npm test`, `npm audit`, production TypeScript/Vite build, Android debug lint,
  and debug APK build pass for the current source. A signed production AAB
  cannot pass until the external values and upload key below are configured.

## Architecture decision: Google Play versus shared account service

Google Play Games can own the Android platform leaderboard and sign-in overlay. It does **not** provide a seamless shared Android+iOS identity, purchase ledger, username registry, or cross-platform inventory. Game Center is a different identity system. Therefore a small platform-neutral account backend is required for the requested Android-to-iOS transfer behavior. The included Cloudflare Worker + D1 implementation is that backend; Cloudflare can be replaced by another backend, but cannot be removed without dropping cross-platform accounts.

## Required production values

Create `.env.production.local` (not committed). Emulator/phone-test builds use
`npm run build:test`, which deliberately keeps Google's public test ad units:

```ini
VITE_ADMOB_TESTING=false
VITE_ADMOB_ANDROID_REWARDED_ID=ca-app-pub-REPLACE/REPLACE
VITE_ADMOB_IOS_REWARDED_ID=
VITE_API_URL=https://discipline-api.YOUR-SUBDOMAIN.workers.dev
VITE_PLAY_GAMES_LEADERBOARD_ID=CgkI_REPLACE
VITE_GAME_CENTER_LEADERBOARD_ID=
```

Create `android/private-release.properties` (not committed):

```properties
ADMOB_ANDROID_APP_ID=ca-app-pub-REPLACE~REPLACE
PLAY_GAMES_APP_ID=123456789012
VERSION_CODE=1
VERSION_NAME=1.0.0
```

`VERSION_CODE` must be greater than every version code already accepted by Play.
Do not guess it; confirm the current highest artifact in Play Console.

```powershell
cmd /c npm run release:play
```

This is the only supported Play-candidate command. It runs the release checker,
builds a fresh production web bundle, performs Capacitor sync, verifies the
Android payload against that exact bundle, runs release lint, builds the signed
AAB, and verifies the signature. It does not upload or publish.

## Backend deployment and secrets

1. Install/authenticate Wrangler: `npm install -g wrangler`, then `wrangler login`.
2. Run `wrangler d1 create discipline-db` and place the returned ID in `wrangler.toml`.
3. For a fresh database run `wrangler d1 execute discipline-db --file=server/schema.sql --remote`. For an existing database, apply every unapplied file in `server/migrations/` in numeric order.
4. In Google Cloud/Play Console, create a service account with Android Publisher access and save its JSON as the Worker secret: `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`.
5. Generate a high-entropy moderation secret and save it with `wrangler secret put MODERATION_ADMIN_TOKEN`; follow `docs/MODERATION.md` and assign a real review owner/cadence.
6. Later for iOS, add `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, and `APPLE_BUNDLE_ID` as Worker secrets.
7. Deploy with `wrangler deploy`, then use its HTTPS URL as `VITE_API_URL`.

## Play Console configuration

1. Create all seven in-app products using the exact IDs above and activate them.
2. Add a license tester account. Install through an Internal testing track to test purchases without a real charge; Google displays a test-payment method to licensed testers.
3. Configure Play Games Services for `com.nosiah.discipline` using the Play App Signing SHA-1 and upload-key SHA-1 as required, create the All-Time Taps leaderboard, then publish the Play Games configuration.
4. Link AdMob to the Play app and create a Rewarded ad unit. Copy the app ID and rewarded-unit ID into the private files above.
5. After the account API is deployed, set the ad unit's server-side verification callback to `https://YOUR-API/v1/admob/reward`. Add the ad unit's numeric suffix as the Worker secret/variable `ADMOB_REWARDED_AD_UNIT_ID`, then use AdMob's callback tester before any live traffic.
6. Run `npm run release:play`. Do not upload unless the entire command passes.
7. Upload the newly reported AAB to Internal testing first. Do not promote to
   production until login, offline launch, background earnings, test purchase,
   consumption/repurchase, reinstall recovery, ad reward/early-close/offline
   rejection, account deletion, and both leaderboard views pass from that
   Play-installed build.

Do not upload any existing `app-play-upload*.aab`: those artifacts predate the latest source and/or contain test/placeholder service configuration. A launch candidate is valid only after `npm run release:check` passes and the newly built AAB verifies against the backed-up Discipline upload certificate.
