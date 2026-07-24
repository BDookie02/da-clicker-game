# DISCIPLINE. privacy policy - production copy specification

The production account service must serve the final policy at `/privacy` and
the unauthenticated deletion flow at `/account-deletion`. Play Console must use
deployed HTTPS URLs, not this repository file.

`server/legal-pages.js` now describes the implemented account, purchase,
rewarded-ad, leaderboard, report/hide, moderation, and deletion behavior. It
deliberately renders a visible **Not launch-ready** warning when required legal
facts are absent. It is still **not release-ready** because the owner fields,
retention decision, target-audience decision, production deployment, and
runtime environment wiring below are unresolved.

## Required header

- Policy title: `DISCIPLINE. Privacy Policy`
- Developer/data controller: `[REQUIRED: legal or publishing name exactly as it will appear on Google Play]`
- Effective date: `[REQUIRED: actual effective date]`
- Privacy/support contact: `[REQUIRED: monitored private email or contact form]`
- Privacy URL: `[REQUIRED: deployed HTTPS /privacy URL]`
- Account-deletion URL: `[REQUIRED: deployed HTTPS /account-deletion URL]`

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

**Cloud game data.** We process the cloud save associated with your account,
including game progress, settings contained in the save, inventory,
entitlements, premium-currency balance, and total physical taps.

**Public leaderboard.** Your username, physical tap total, and rank are public
and can be viewed by other players and by anyone who can access the leaderboard
service. We do not intentionally publish your account ID, password data,
session token, cloud save, or purchase ledger.

**Community safety.** We process the current Terms version and acceptance time.
If you report another public leaderboard account, we store the reported
account, selected reason, optional explanation, review status, and moderator
note. If you hide another account, we store that private block relationship so
the account remains absent from your leaderboard until you unhide it.

**Purchases.** For Google Play purchases, we process the platform, product ID,
transaction ID, purchase-token hash, granted amount, verification time,
purchase type, quantity, billing region, actual paid amount and currency,
financial/refund status, Android consumption status, and void/refund evidence.
Google processes the payment and payment-account information; DISCIPLINE does
not receive your payment-card number. Test, promo, and rewarded purchase types
are excluded from real-money spend totals.

**Rewarded ads.** Google Mobile Ads may process IP-derived approximate
location, app/product interactions, diagnostic/performance information, and
device or account identifiers for advertising, analytics, and fraud
prevention. To verify a completed reward, DISCIPLINE sends Google an
account-derived pseudonymous user ID and custom data containing an internal
account ID, one-time nonce, and reward type. We store the signed ad transaction
and reward details to prevent duplicate or spoofed grants.

**Google Play Games.** If Play Games is available, the app may sign in to Play
Games and submit your physical tap total to Google's leaderboard. Google
processes the Play Games identity and score under its own privacy terms. Your
Play Games identity is separate from your DISCIPLINE account and is not stored
in the DISCIPLINE D1 account database by the current app.

**Technical service data.** Network and infrastructure providers may process
IP addresses, request metadata, diagnostics, security events, and service logs
needed to deliver and protect the service. `[REQUIRED BEFORE RELEASE: describe
the exact production logging, backup, security, and retention configuration.]`

### Why we use information

We use information to create and authenticate accounts; synchronize game
progress across devices; operate the public leaderboard; verify, grant, and
restore purchases and rewarded-ad rewards; prevent fraud and duplicate grants;
provide advertising; maintain security; diagnose failures; and operate the
game.

### Who receives information

- Cloudflare processes account-service and D1 data as DISCIPLINE's
  infrastructure provider.
- Google Play processes Play Games identity/leaderboard data and Google Play
  purchase data.
- Google Mobile Ads/AdMob processes advertising, interaction, diagnostic, and
  identifier data, including the SSV values described above.
- Public leaderboard viewers receive the username, tap total, and rank you make
  public through the game.

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
leaderboard score, purchase and consumption ledger, and rewarded-ad ledger
from the primary D1 database.

`[REQUIRED BEFORE RELEASE: state any retention that applies to Cloudflare or
other provider logs, backups, fraud/security records, legal obligations, and
deletion completion timing. No period is approved yet.]`

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

`[REQUIRED BEFORE RELEASE: insert language consistent with the final Play
target-audience selection, content rating, AdMob treatment setting, and any
neutral age screen. Do not claim an age threshold that has not been selected
and implemented.]`

### Changes and contact

Explain how material policy changes will be announced and provide the monitored
privacy/support contact named in the header.

## Deployment and verification checklist

- [ ] Fill every `[REQUIRED ...]` field; remove all brackets/placeholders.
- [x] Implement and automate tests for Terms acceptance, report,
      block/hide, and moderator suspension.
- [x] Make unconfigured legal pages fail visibly instead of publishing
      invented identity, contact, date, retention, or age claims.
- [ ] Assign and document the real moderation owner, cadence, escalation, and
      appeals/contact process; exercise `docs/MODERATION.md` in production.
- [x] Pass the production Worker `env` object to the legal-page renderers.
- [ ] Configure all five `LEGAL_*` values above as server-side variables.
- [ ] Apply the current D1 schema plus every unapplied file through
      `server/migrations/0005_purchase_financials_and_reversals.sql` in numeric
      order; verify the expected tables and indexes exist.
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
- [Delete Play Games data or profile](https://support.google.com/googleplay/answer/9130646)
- [Google Play UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
