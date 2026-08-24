# Google service configuration evidence

Verified in the signed-in Google consoles on 2026-08-24. These are public
application identifiers, not credentials.

## Official account and app

- Google account shown by AdMob: `co.nosiah@gmail.com`
- Play developer: `Nomogames` (personal account)
- Play developer account ID: `5091760294547448831`
- Android package: `com.nosiah.discipline`
- Highest uploaded Play artifact when checked: version code `11`, version name
  `1.0.10`; release version code `12` / version name `1.0.11` is unused and is
  the next valid artifact identity.
- Local upload keystore certificate matches Play Console's upload-key
  certificate exactly: SHA-1
  `0F:DD:32:1C:11:A8:C3:56:2E:DD:F6:DF:FB:A2:14:C6:3D:BF:A3:9A` and SHA-256
  `2E:22:42:35:52:F6:45:0D:4F:9E:29:42:E0:CD:A8:AF:F9:E7:AF:E6:6D:C3:BD:96:48:6E:33:7B:A2:DD:9B:BC`.

## Play Integrity

- Play Console app: `DISCIPLINE.`
- Selected existing Cloud project: `da clicker DISCIPLINE`
- Cloud project number: `536017417892`
- Source location: Play Console > DISCIPLINE. > Protected with Play > Play
  Integrity API settings > Project configuration.
- Verification state: linked successfully on 2026-08-24. Play Console shows
  `da clicker DISCIPLINE` / `536017417892` as the app's linked project.
- Required standard responses are active: App licensing, Application
  integrity, and Device integrity. Optional Recent device activity, Device
  attributes, Play Protect status, and App access risk remain off.

## AdMob

- Publisher ID: `pub-4117022659694420`
- App ID: `ca-app-pub-4117022659694420~4780270105`
- App state: `DISCIPLINE.` / Android / Google Play package
  `com.nosiah.discipline` / Verified / Ready.
- Interstitial unit: `DISCIPLINE Interstitial 6.28m` —
  `ca-app-pub-4117022659694420/9576892090`
- Rewarded unit: `DISCIPLINE Rewarded` —
  `ca-app-pub-4117022659694420/6776690128`

The production `.env.production.local`, `android/private-release.properties`,
and `wrangler.toml` values must match these identifiers exactly. Do not use
identifiers from the other Google accounts visible in the account switcher.
