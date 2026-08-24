# Google Play Data safety declaration - working copy

Use this as the entry sheet for Play Console. It describes the current Android
code and must be reconciled against the exact signed AAB, production service
configuration, and SDK versions immediately before submission.

## Top-level answers

| Play Console question | Launch answer | Basis / required verification |
| --- | --- | --- |
| Does the app collect or share required user-data types? | **Yes** | The production account service, Google Play Billing, Google Play Games, Play Integrity, and Google Mobile Ads transmit data off-device. |
| Is all collected user data encrypted in transit? | **Yes, pending final-artifact verification** | Android disables cleartext traffic and every configured first-party endpoint uses HTTPS/TLS. Confirm the signed AAB and production URLs before submitting the form. |
| Can users request deletion? | **Yes, pending live verification** | The app has an authenticated delete action and the service has a public `/account-deletion` flow. Confirm both against the deployed production service before submitting the form. |
| Is an account required? | **Yes** | A production build with the account API configured requires registration or login for a new player. |
| Is collection optional? | Mixed | Account/save/leaderboard collection is required for the production account experience. Referrals, friends, multiplayer, purchases, rewarded ads, and Google Play Games participation are optional features. |
| Independent security review completed? | **No / unresolved** | Do not claim an independent review unless one is actually completed and documented. |

## Data-type entries

This is a conservative declaration. Public display and transfers to Google are
shown as sharing so the form does not under-report the app's behavior.

| Play data type | Collected | Shared | Required / optional | Purposes | Current behavior |
| --- | --- | --- | --- | --- | --- |
| Personal info - Name | Yes | **Yes** | Required | Account management; app functionality | A player-created username is stored with the DISCIPLINE account and publicly displayed with rank and tap total on the unauthenticated worldwide leaderboard. No legal name is requested. |
| Personal info - User IDs | Yes | **Yes** | Required for the DISCIPLINE account; optional for ads/Play Games | Account management; app functionality; security and fraud prevention; advertising | The service uses an internal account ID and hashed session token. AdMob server-side verification receives an account-derived pseudonymous user ID plus custom data containing the internal account ID, nonce, and reward kind. Google Play Games processes its signed-in identity separately. |
| Personal info - Other info (authentication credential) | Yes | No, except infrastructure processing | Required | Account management; security | The password is transmitted to the account service over HTTPS. Only a salted PBKDF2 hash and salt are stored; plaintext passwords are not stored. |
| Financial info - Purchase history | Yes | Yes | Optional | App functionality; fraud prevention; account management | The service verifies purchases with Google Play and stores platform, product ID, transaction ID, purchase-token hash, grant amount, purchase type, quantity, billing region, actual paid amount/currency, order state, consumption status, and refund/void evidence. It does not receive payment-card details. |
| App activity - App interactions | Yes | **Yes** | Required for cloud progress/leaderboard; optional for referrals, multiplayer, and ads | App functionality; analytics; advertising; fraud prevention | Cloud-save gameplay/settings/inventory data and a client-submitted cumulative leaderboard tap total are stored. The account service accepts increases only within a server-side plausibility ceiling of 25 taps per second plus a small synchronization allowance; it does not independently verify each physical tap. Optional referral evidence, friend requests, PvP invitations, match settings, server-controlled round timing, client-submitted/server-recorded plausibility-limited PvP tap totals (not verified physical taps), Quick Draw raw server-receipt reaction times, bounded RTT telemetry and submission transport, match results, and eligible five-Mentality winner rewards are stored. The reward ledger retains the match ID, winner and unordered pair IDs, amount, and award time while both accounts exist; deletion removes the deleted winner's rewards and erases a deleted opponent's numeric ID from a surviving winner's record. Username, leaderboard tap total, and rank are public. A PvP opponent receives the shared match state and result. Google Mobile Ads automatically processes interactions such as app launches, taps, rewarded-video views, and interstitial views. |
| App activity - Other user-generated content | Yes | **Yes** | Required for a public account; reporting is optional | App functionality; account management; security and compliance | The user-selected public username is UGC. A signed-in player may also submit a report reason and optional report explanation for private operator review. Use this entry as well as **Name** unless Play Console support gives a documented reason not to. |
| Location - Approximate location | Yes | Yes | Optional purchase and rewarded-ad features | App functionality; advertising; analytics; fraud prevention | Google Play returns the two-letter billing region for a verified purchase, which DISCIPLINE stores with its financial ledger. Google Mobile Ads also states that it collects IP addresses that may estimate general location. DISCIPLINE does not request Android location permission or store GPS/precise location. |
| App info and performance - Diagnostics | Yes | Yes | Optional rewarded-ad feature | Analytics; fraud prevention; advertising | Google Mobile Ads states that it automatically collects SDK/app performance information such as launch time, hang rate, and energy use. |
| Device or other IDs | Yes | Yes | Optional ads/Play Games; required for account registration and when a referral claim is submitted | Advertising; analytics; fraud prevention; app functionality | Google Mobile Ads may collect advertising ID, app-set ID, and applicable account-related identifiers. Google Play Games uses Google/Play Games identifiers for sign-in and leaderboard submission. A referral claim invokes Play Integrity, which processes app metadata, Play license status, and device-attestation material to validate the request. For registration and referral anti-abuse, the account service receives the Cloudflare-supplied source IP and stores only a scope-separated keyed HMAC fingerprint, count, and window time—not the raw IP in D1. |

Do **not** declare precise location, contacts, photos/videos, audio files,
health/fitness data, messages, email address, phone number, mailing address, or
payment-card data unless the final AAB or a newly added SDK actually collects
them.

## Provider-specific notes

### DISCIPLINE account service (Cloudflare Worker and D1)

- Stores username, account ID, password salt/hash, hashed session tokens, cloud
  save, inventory/settings contained in the save, tap score, accepted Terms
  version/time, referral code and verified provider-normalized referral evidence, friend
  code and friend relationships, PvP invitations/timing/scores/results/rewards,
  private block relationships, submitted report content and moderation state,
  verified purchase ledger, Android consumption status, and verified
  rewarded-ad ledger.
- For registration/referral abuse prevention, stores scope-separated keyed HMAC
  fingerprints of the Cloudflare-supplied source IP and relevant account/code
  scope, plus fixed-window counts and start times. It does not store the raw IP
  or raw referral code in the throttle table and never applies a global quota
  to a public referral code.
- The public `/v1/board` endpoint exposes leaderboard username, the
  client-submitted cumulative tap total accepted under the server plausibility
  ceiling, and rank. It does not expose password hashes, account IDs, saves,
  sessions, or purchase records.
- D1 account rows remain while the account exists. Successful account deletion
  removes the account, profile/Terms state, sessions, cloud save, score,
  personal referral records involving the account, its friend code and friendships,
  its PvP matches/round submissions and its own PvP reward ledger, reports
  involving that account, block relationships, purchase/consumption rows, and
  rewarded-ad rows. A reward previously won by another player remains in that
  winner's ledger without retaining the deleted opponent's account record. A
  keyed HMAC fingerprint of one-use referral evidence remains to block replay;
  it does not retain the referral code or install timestamps.
- The configured retention notice states that the app creates no separate
  archive; Cloudflare D1 Time Travel may retain recoverable history for 7 days
  on Free or 30 days on Paid, and Workers Logs, when enabled, for 3 days on Free
  or 7 days on Paid. Cloudflare may retain limited security/network data under
  its policies and legal obligations.
- The hourly Worker task prunes pseudonymous throttle rows once their window
  start is more than 24 hours old; normal live-D1 retention is under 25 hours.

### Google Mobile Ads / AdMob rewarded and interstitial ads

- Rewarded ads are user-initiated; interstitials can appear at configured
  opponent breaks. The SDK automatically collects and shares IP address, user
  product interactions, diagnostics, and device/account identifiers for
  advertising, analytics, and fraud prevention.
- SSV sends a pseudonymous account-derived user ID and reward-verification
  custom data to Google; the verified callback ledger is stored in D1.
- Purposes: advertising, analytics, fraud prevention, and issuing the requested
  in-game reward.
- Recheck the disclosure for the exact SDK resolved in the signed AAB. The
  repository pins `play-services-ads:24.9.0`; Google's disclosure page describes
  the latest SDK and can change.

### Google Play Integrity

- Android referral claims request a standard Play Integrity token bound to the
  exact claim hash. The server sends that token to Google for decoding and
  requires a recognized package/signing context, app integrity, Play licensing,
  device integrity, matching request hash, matching app version, and freshness.
- Google documents that Play Integrity always processes the app-provided
  request hash/nonce, package/version/signing metadata, Play license status,
  key-attestation certificate, and device-attestation token. DISCIPLINE does
  not opt into Play Protect or app-access-risk environment details in this
  release.
- Google states that this data is encrypted, not transferred to third parties,
  and deleted after a fixed retention period. The developer remains responsible
  for the final Play Data safety answers.

### Google Play Games Services

- The app attempts Play Games sign-in and submits its app-recorded cumulative
  tap score to the configured all-time leaderboard. That score is not an
  independently verified count of physical touches. Google processes the Play
  Games identity and score under Google's terms.
- The Play Games identity is not used as the DISCIPLINE account and is not
  stored in D1 by the current code.
- Recheck the exact `play-services-games-v2` dependency and Play Console
  configuration before filing. The repository currently pins version `21.0.0`.

### Google Play Billing

- Google handles payment and payment-account information. The app receives the
  product/purchase identifiers needed to verify and grant the consumable item.
- DISCIPLINE stores a hashed Android purchase token, not the raw token, after
  verification. The server also stores the matching Google order's actual
  Money amount/currency, purchase type, quantity, billing region, financial
  state, and durable void/refund signals. License-test, promo, and rewarded
  purchase types are excluded from real-money spend totals.
- Scheduled Android reconciliation uses the Orders and Voided Purchases APIs.
  Reversed transactions are excluded from the authoritative M ledger and
  grouped spend totals. Google retains its own transaction records
  independently.
- The financial schema is platform-extensible, but StoreKit price/currency and
  automated iOS revocation reconciliation are not implemented. Do not claim
  cross-platform financial reporting is complete.

## Deletion and retention wording

- **Deleting a DISCIPLINE account:** removes the account's D1 records listed
  above. In-app deletion also clears the current account's local save/session
  data on that device. A web deletion does not erase copies still stored in an
  app installation; the user must clear that app's local data or uninstall it.
- **Deleting Google Play Games data:** is a separate Google action. It does not
  delete DISCIPLINE D1 account data.
- **Deleting DISCIPLINE data:** does not delete the Google Play Games profile,
  Google leaderboard records, Google purchase history, or Google/AdMob records.
  Users must use the applicable Google controls for those records.
- **Retention:** primary D1 account data remains until account deletion. The
  configured D1 Time Travel and Workers Logs windows are stated above; Google
  and Cloudflare may retain their own provider-controlled records. Do not
  promise immediate erasure from third-party systems.

## Public usernames (UGC): implemented controls and remaining launch work

The current source requires versioned Terms acceptance before registration and
public-board participation, defines prohibited conduct, provides authenticated
in-app report and hide/unhide actions, stores a durable deduplicated report
queue, and provides a secret-protected operator action API. Automated tests
cover Terms enforcement, report authentication/deduplication, block filtering,
unblock, and moderator suspension.

Before submission, a real operator still must be assigned, the production
moderation secret must be configured, the runbook in `docs/MODERATION.md` must
be exercised against disposable production-track accounts, and the actual
review cadence/escalation/appeals policy must be documented. Source code cannot
prove that a human moderation process is staffed. The production D1 database
must also have `server/migrations/0003_ugc_terms_and_moderation.sql` applied;
source files in Git do not prove the production database was migrated.

## Verified owner-supplied fields

- Developer/publishing name: `Nomogames`
- Privacy/support contact: `co.nosiah@gmail.com`
- Effective date: `2026-08-24`
- Privacy URL: `https://discipline-api.nomogames.workers.dev/privacy`
- Account-deletion URL: `https://discipline-api.nomogames.workers.dev/account-deletion`
- Target audience: age 13 and older; not directed to children under 13; no birth
  date is requested and age is not independently verified.
- Remaining human-operational requirement: name the moderation operator and
  document review cadence, escalation, and appeals handling.

## Deployment facts that source code cannot prove

- The five `LEGAL_*` values are present in `wrangler.toml`; the live deployed
  pages must still be checked for absence of the **Not launch-ready** warning.
- The base D1 schema and every unapplied migration through
  `0017_request_rate_limits.sql` must be
  applied to the actual production database in numeric order and exercised
  with disposable accounts.
- Play Integrity must link the verified `da clicker DISCIPLINE` Cloud project
  (`536017417892`) in the official `code.nosia` / `Nomo Games` Play account.
- A high-entropy `MODERATION_ADMIN_TOKEN` must be stored as a Worker secret and
  used only by the assigned operator; it must not be committed or shipped.
- The final signed AAB, deployed HTTPS endpoints, SDK behavior, account
  deletion, and Data safety answers must be tested together.
- Data safety accuracy does not establish rights to visual or audio assets.
  Every **Hold** in `docs/ASSET-PROVENANCE.md` remains a separate launch
  blocker.

## Official references (checked 2026-08-24)

- [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Google Mobile Ads Android data disclosure](https://developers.google.com/admob/android/privacy/play-data-disclosure)
- [Play Integrity terms and data safety](https://developer.android.com/google/play/integrity/terms)
- [Google Play account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Delete Play Games data or profile](https://support.google.com/googleplay/answer/9130646)
- [Google Play UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
