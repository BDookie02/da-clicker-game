# DISCIPLINE. privacy policy - production copy specification

The production account service must serve the final policy at `/privacy` and
the unauthenticated deletion flow at `/account-deletion`. Play Console must use
deployed HTTPS URLs, not this repository file.

`server/legal-pages.js` describes the implemented account, referral, friends,
multiplayer, purchase, rewarded-ad, leaderboard, report/hide, moderation, and
deletion behavior. It deliberately renders a visible **Not launch-ready**
warning when required legal facts are absent. Publisher, effective date,
contact, retention, and target-audience values are configured in
`wrangler.toml`; production migration/deployment and live-page verification
remain release gates.

## Required header

- Policy title: `DISCIPLINE. Privacy Policy`
- Developer/data controller: `Nomogames`
- Effective date: `2026-08-24`
- Privacy/support contact: `co.nosiah@gmail.com`
- Privacy URL: `https://discipline-api.nomogames.workers.dev/privacy`
- Account-deletion URL: `https://discipline-api.nomogames.workers.dev/account-deletion`

Do not use a public issue tracker as the sole privacy contact unless the owner
has intentionally approved public disclosure of support requests.

The renderer accepts these server-only configuration values:

- `LEGAL_PUBLISHER_NAME`
- `LEGAL_CONTACT_EMAIL`
- `LEGAL_EFFECTIVE_DATE` in `YYYY-MM-DD` form
- `LEGAL_RETENTION_NOTICE`
- `LEGAL_TARGET_AUDIENCE_NOTICE`

The Worker routes pass their `env` object to the renderers. The fail-visible
warning remains expected until all five values are configured in the deployed
server environment. Do not work around it by hardcoding personal details in
source.

## Play-ready policy copy

### Information we collect and process

**DISCIPLINE account.** We process your chosen username, an internal account
identifier, your password while authenticating, and session credentials. We
store a random password salt and a PBKDF2 password hash rather than the
plaintext password. Server-side session tokens are stored as hashes.

**Abuse-prevention metadata.** For registration and referral claims, Cloudflare
supplies the network source IP to the account service. The service immediately
turns the IP and relevant account/referral scope into separate keyed HMAC
fingerprints. D1 stores only the scope, pseudonymous fingerprint, fixed-window
count, and window start—not the raw IP or raw referral code in this throttle
table. This limits automated account creation and protects Google verification
quota without globally limiting a public invite code.

**Cloud game data.** We process the cloud save associated with your account,
including game progress, settings contained in the save, inventory,
entitlements, premium-currency balance, and a client-submitted cumulative tap
total. The account service accepts increases only within a server-side
plausibility ceiling of 25 taps per second plus a small synchronization
allowance; it does not independently verify each physical tap.

**Public leaderboard.** Your username, client-submitted cumulative tap total
accepted under that server-side plausibility ceiling, and rank are public and
can be viewed by other players and by anyone who can access the leaderboard
service. We do not intentionally publish your account ID, password data,
session token, cloud save, or purchase ledger.

**Community safety.** We process the current Terms version and acceptance time.
If you report another public leaderboard account, we store the reported
account, selected reason, optional explanation, review status, and moderator
note. If you hide another account, we store that private block relationship so
the account remains absent from your leaderboard until you unhide it.

**Referrals.** If a new Android player installs through an invite link, Google
Play provides the referral code, referral-click time, install time, and installed
app version. The app requests a Google Play Integrity token bound to the exact
claim, and the server verifies the official app, licensed account, device
integrity, request hash, version, and freshness with Google before accepting it.
We connect that evidence to the new DISCIPLINE account to validate one claim,
prevent duplicate or self-referrals, cap rewarded referrals at ten, and grant
the referrer one random shop item they do not already own. Permanent replay
protection stores a keyed HMAC fingerprint rather than the referral code or
install timestamps. The referral domain is platform-neutral; iOS remains
disabled until a reviewed Apple proof/attribution adapter is implemented.

**Friends and multiplayer.** We store a random public friend code, friend
requests and accepted friendships, PvP invitations, selected mode and duration,
server-controlled round timing, client-submitted and server-recorded tap totals
limited to a plausible rate (not verified physical taps), Quick Draw raw
server-receipt reaction times, bounded RTT telemetry and submission transport,
match results, and eligible five-Mentality winner rewards. A rolling gate permits
at most ten rewarded wins per winner and one rewarded result per unordered player
pair in 24 hours; a completed win can therefore have no reward. Your
friend and opponent can see your username, friend code where relevant, shared
match state, scores or reaction result, and match outcome. DISCIPLINE friends do
not depend on a Google Play Games identity, which keeps the system usable across
supported platforms.

**Purchases.** For Google Play purchases, we process the platform, product ID,
transaction ID, purchase-token hash, granted amount, verification time,
purchase type, quantity, billing region, actual paid amount and currency,
financial/refund status, Android consumption status, and void/refund evidence.
Google processes the payment and payment-account information; DISCIPLINE does
not receive your payment-card number. Test, promo, and rewarded purchase types
are excluded from real-money spend totals.

**Rewarded and interstitial ads.** Google Mobile Ads may process IP-derived
approximate location, app/product interactions, diagnostic/performance
information, and device or account identifiers for advertising, analytics,
and fraud prevention. Rewarded ads are user-initiated; interstitials may appear
at configured opponent breaks. To verify a completed rewarded ad, DISCIPLINE sends Google an
account-derived pseudonymous user ID and custom data containing an internal
account ID, one-time nonce, and reward type. We store the signed ad transaction
and reward details to prevent duplicate or spoofed grants.

**Play Integrity.** When a new Android player submits a referral claim, the app
asks Google Play for an integrity token bound to that exact claim. Google
processes the request hash, package/version/signing metadata, Play license
status, key-attestation certificate, and device-attestation token to return an
encrypted verdict. DISCIPLINE uses that verdict only to validate the referral
claim and prevent abuse; it does not use Play Integrity to fingerprint or track
players.

**Google Play Games.** If Play Games is available, the app may sign in to Play
Games and submit its app-recorded cumulative tap score to Google's leaderboard.
That score is not an independently verified count of physical touches. Google
processes the Play Games identity and score under its own privacy terms. Your
Play Games identity is separate from your DISCIPLINE account and is not stored
in the DISCIPLINE D1 account database by the current app.

**Technical service data.** Network and infrastructure providers may process
IP addresses, request metadata, diagnostics, security events, and service logs
needed to deliver and protect the service. The app creates no separate archive.
Cloudflare D1 Time Travel may retain recoverable history for 7 days on the Free
plan or 30 days on a Paid plan. Workers Logs, if enabled, are retained for 3
days on Free or 7 days on Paid. Cloudflare may retain limited security or
network data under its own policies and legal obligations.

### Why we use information

We use information to create and authenticate accounts; synchronize game
progress across devices; operate the public leaderboard; validate referrals;
connect requested friends; run and settle PvP matches; verify, grant, and
restore purchases, referral rewards, PvP rewards, and rewarded-ad rewards;
prevent fraud and duplicate grants; provide advertising; maintain security;
diagnose failures; and operate the game.

### Who receives information

- Cloudflare processes account-service and D1 data as DISCIPLINE's
  infrastructure provider.
- Google Play processes Play Games identity/leaderboard data, Google Play
  purchase data, Android install-referral attribution, and Play Integrity
  request/device/app/licensing signals.
- Google Mobile Ads/AdMob processes advertising, interaction, diagnostic, and
  identifier data, including the SSV values described above.
- Public leaderboard viewers receive the username, client-submitted and
  plausibility-limited cumulative tap total, and rank you make public through
  the game.

DISCIPLINE does not directly sell plaintext passwords, cloud saves, or purchase
ledgers. Do not make a broader "we never sell/share data" claim while AdMob and
public leaderboard sharing are present.

### Security

Production app traffic is intended to use HTTPS/TLS, and the Android app
disables cleartext network traffic. Passwords are stored as salted PBKDF2
hashes; server session and Android purchase tokens are stored as hashes. These
measures reduce risk but no system can guarantee absolute security.

Select "encrypted in transit" in Play Console only after testing the exact
signed AAB against every production endpoint and SDK.

### Retention

Primary DISCIPLINE account records remain while the account exists. A
successful account deletion removes the account, sessions, cloud save,
leaderboard score, personal referral attribution, its friend code and
friendships, its PvP matches and round submissions, its own referral and PvP
reward ledgers, purchase and consumption ledger, and rewarded-ad ledger from
the primary D1 database. A keyed HMAC fingerprint of one-use install evidence
remains to prevent replay; it contains neither the referral code nor install
timestamps. A referral or five-Mentality reward already earned by another
player remains in that player's ledger without retaining the deleted account's
identifier.

A successful deletion removes account-linked records from live D1, and the app
does not create a separate archive. Cloudflare D1 Time Travel may retain
recoverable history for 7 days on Free or 30 days on Paid. Workers Logs, if
enabled, are retained for 3 days on Free or 7 days on Paid. Cloudflare may keep
limited security or network data under its policies and legal obligations.
Pseudonymous rate-limit fingerprints and counts are pruned hourly once their
window start is more than 24 hours old, so normal live-D1 retention is less
than 25 hours. They are not retained as a permanent account record.

Google may retain Play Games, Google Play purchase, and AdMob data under
Google's own policies and legal obligations.

### Your choices and deletion

You can revisit available AdMob privacy choices from the game's Settings menu.
A signed-in player can use **Settings > Delete account**, and a former player
can use the public account-deletion URL.

Deleting a DISCIPLINE account deletes the primary DISCIPLINE D1 records
described above. In-app deletion also clears the current account's local data
on that device. If deletion is completed on the web, copies stored in an
installed app may remain on that device until its app data is cleared or the
app is uninstalled.

DISCIPLINE account deletion does **not** delete Google Play Games data, the
Google Play Games profile, Google purchase history, or Google/AdMob records.
Users can delete Play Games data separately through their Google Play Games
profile/settings. Deleting Play Games data does **not** delete the DISCIPLINE
account or D1 cloud data.

### Public usernames and moderation

Usernames are public UGC. The app requires versioned Terms acceptance before a
new account is created or an account participates in the public leaderboard.
Signed-in players can report another row and hide/unhide it from their own
board. Reports enter a durable private moderation queue, and an operator can
suspend or restore public-board visibility through a server-secret-protected
API. The operator process and escalation/contact details must follow the
production moderation runbook.

### Children and target audience

DISCIPLINE. is intended for players age 13 and older and is not directed to
children under 13. The game does not ask for a birth date or independently
verify age. Players under 13 should not create a DISCIPLINE. account or use its
online community features. A parent or guardian who believes a child under 13
created an account may use the account-deletion page or contact the privacy
address above.

### Changes and contact

Explain how material policy changes will be announced and provide the monitored
privacy/support contact named in the header.

## Deployment and verification checklist

- [x] Configure publisher, effective date, contact, retention, and target
      audience in `wrangler.toml`.
- [x] Implement and automate tests for Terms acceptance, report,
      block/hide, and moderator suspension.
- [x] Make unconfigured legal pages fail visibly instead of publishing
      invented identity, contact, date, retention, or age claims.
- [ ] Assign and document the real moderation owner, cadence, escalation, and
      appeals/contact process; exercise `docs/MODERATION.md` in production.
- [x] Pass the production Worker `env` object to the legal-page renderers.
- [x] Configure all five `LEGAL_*` values above as server-side variables.
- [ ] Run `npm run release:worker`; do not run migration and Worker deployment
      separately. Verify migrations through `0017_request_rate_limits.sql`, the
      maintenance exit, expected tables/indexes/triggers, and the public
      version smoke check.
- [ ] Deploy the Worker and D1 schema to the production account-service domain.
- [ ] Confirm the public HTTPS `/privacy` and `/account-deletion` pages load
      without authentication and no **Not launch-ready** warning remains.
- [ ] Verify the in-app privacy link opens the same production policy.
- [ ] Delete a disposable account and verify all primary D1 rows are removed.
- [ ] Confirm Play Games data remains a clearly separate Google-controlled
      deletion path.
- [ ] Put the production URLs into Play Console and retest them from a logged-out
      browser.
- [ ] Resolve every release **Hold** in `docs/ASSET-PROVENANCE.md`; legal-page
      readiness does not clear media, music, icon, or likeness rights.

Official references:

- [Account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Google Mobile Ads data disclosure](https://developers.google.com/admob/android/privacy/play-data-disclosure)
- [Play Integrity terms and data safety](https://developer.android.com/google/play/integrity/terms)
- [Delete Play Games data or profile](https://support.google.com/googleplay/answer/9130646)
- [Google Play UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
