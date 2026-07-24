# Google Play Data safety declaration - working copy

Use this as the entry sheet for Play Console. It describes the current Android
code and must be reconciled against the exact signed AAB, production service
configuration, and SDK versions immediately before submission.

## Top-level answers

| Play Console question | Launch answer | Basis / required verification |
| --- | --- | --- |
| Does the app collect or share required user-data types? | **Yes** | The production account service, Google Play Billing, Google Play Games, and optional AdMob rewarded ads transmit data off-device. |
| Is all collected user data encrypted in transit? | **Yes, only after production verification** | Android disables cleartext traffic and the planned endpoints use HTTPS/TLS. Confirm the final AAB and every production URL before selecting **Yes**. |
| Can users request deletion? | **Yes, only after production verification** | The app has an authenticated delete action and the service has a public `/account-deletion` flow. Confirm both against production before selecting **Yes**. |
| Is an account required? | **Yes** | A production build with the account API configured requires registration or login for a new player. |
| Is collection optional? | Mixed | Account/save/leaderboard collection is required for the production account experience. Purchases, rewarded ads, and Google Play Games participation are optional features. |
| Independent security review completed? | **No / unresolved** | Do not claim an independent review unless one is actually completed and documented. |

## Data-type entries

This is a conservative declaration. Public display and transfers to Google are
shown as sharing so the form does not under-report the app's behavior.

| Play data type | Collected | Shared | Required / optional | Purposes | Current behavior |
| --- | --- | --- | --- | --- | --- |
| Personal info - Name | Yes | **Yes** | Required | Account management; app functionality | A player-created username is stored with the DISCIPLINE account and publicly displayed with rank and tap total on the unauthenticated worldwide leaderboard. No legal name is requested. |
| Personal info - User IDs | Yes | **Yes** | Required for the DISCIPLINE account; optional for ads/Play Games | Account management; app functionality; security and fraud prevention; advertising | The service uses an internal account ID and hashed session token. AdMob SSV receives an account-derived user ID plus custom data containing the internal account ID, nonce, and reward kind. Google Play Games processes the signed-in Play Games identity separately. |
| Personal info - Other info (authentication credential) | Yes | No, except infrastructure processing | Required | Account management; security | The password is transmitted to the account service over HTTPS. Only a salted PBKDF2 hash and salt are stored; plaintext passwords are not stored. |
| Financial info - Purchase history | Yes | Yes | Optional | App functionality; fraud prevention; account management | The service verifies purchases with Google Play and stores platform, product ID, transaction ID, purchase-token hash, grant amount, purchase type, quantity, billing region, actual paid amount/currency, order state, consumption status, and refund/void evidence. It does not receive payment-card details. |
| App activity - App interactions | Yes | **Yes** | Required for cloud progress/leaderboard; optional for ads | App functionality; analytics; advertising; fraud prevention | Cloud-save gameplay/settings/inventory data and raw physical tap totals are stored. Username, tap total, and rank are public. AdMob automatically processes interactions such as app launches, taps, and video views. |
| App activity - Other user-generated content | Yes | **Yes** | Required for a public account; reporting is optional | App functionality; account management; security and compliance | The user-selected public username is UGC. A signed-in player may also submit a report reason and optional report explanation for private operator review. Use this entry as well as **Name** unless Play Console support gives a documented reason not to. |
| Location - Approximate location | Yes | Yes | Optional purchase and rewarded-ad features | App functionality; advertising; analytics; fraud prevention | Google Play returns the two-letter billing region for a verified purchase, which DISCIPLINE stores with its financial ledger. Google Mobile Ads also states that it collects IP addresses that may estimate general location. DISCIPLINE does not request Android location permission or store GPS/precise location. |
| App info and performance - Diagnostics | Yes | Yes | Optional rewarded-ad feature | Analytics; fraud prevention; advertising | Google Mobile Ads states that it automatically collects SDK/app performance information such as launch time, hang rate, and energy use. |
| Device or other IDs | Yes | Yes | Optional rewarded-ad and Play Games features | Advertising; analytics; fraud prevention; app functionality | Google Mobile Ads may collect advertising ID, app-set ID, and applicable account-related identifiers. Google Play Games uses Google/Play Games identifiers for sign-in and leaderboard submission. |

Do **not** declare precise location, contacts, photos/videos, audio files,
health/fitness data, messages, email address, phone number, mailing address, or
payment-card data unless the final AAB or a newly added SDK actually collects
them.

## Provider-specific notes

### DISCIPLINE account service (Cloudflare Worker and D1)

- Stores username, account ID, password salt/hash, hashed session tokens, cloud
  save, inventory/settings contained in the save, tap score, accepted Terms
  version/time, private block relationships, submitted report content and
  moderation state, verified purchase ledger, Android consumption status, and
  verified rewarded-ad ledger.
- The public `/v1/board` endpoint exposes leaderboard username, tap total, and
  rank. It does not expose password hashes, account IDs, saves, sessions, or
  purchase records.
- D1 account rows remain while the account exists. Successful account deletion
  removes the account, profile/Terms state, sessions, cloud save, score,
  reports involving that account, block relationships, purchase/consumption
  rows, and rewarded-ad rows.
- **Unresolved before release:** document any Cloudflare/operational log,
  backup, abuse-prevention, or legal retention that survives the primary D1
  deletion. Do not enter a retention period until the owner and provider
  configuration establish one.

### Google Mobile Ads / AdMob rewarded ads

- Rewarded ads are user-initiated and optional, but the SDK automatically
  collects and shares IP address, user product interactions, diagnostics, and
  device/account identifiers after use.
- SSV sends a pseudonymous account-derived user ID and reward-verification
  custom data to Google; the verified callback ledger is stored in D1.
- Purposes: advertising, analytics, fraud prevention, and issuing the requested
  in-game reward.
- Recheck the disclosure for the exact SDK resolved in the signed AAB. The
  repository pins `play-services-ads:24.9.0`; Google's disclosure page describes
  the latest SDK and can change.

### Google Play Games Services

- The app attempts Play Games sign-in and submits physical tap totals to the
  configured all-time leaderboard. Google processes the Play Games identity
  and score under Google's terms.
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
- **Retention:** primary D1 account data remains until account deletion. Exact
  provider log/backup retention is **unresolved** and must be documented before
  launch. Do not promise immediate erasure from third-party systems.

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

## Required owner-supplied fields

- `[REQUIRED: developer legal/publishing name]`
- `[REQUIRED: private support/privacy contact email]`
- `[REQUIRED: actual policy effective date]`
- `[REQUIRED: production HTTPS privacy-policy URL]`
- `[REQUIRED: production HTTPS account-deletion URL]`
- `[REQUIRED: exact infrastructure log/backup retention policy]`
- `[REQUIRED: target-audience/age decision]`
- `[REQUIRED: named moderation operator, review cadence, escalation and appeals process]`

## Deployment facts that source code cannot prove

- The Worker routes still need to pass production environment configuration to
  the legal-page renderers. Until the five `LEGAL_*` values documented in
  `docs/privacy-policy.md` are supplied, the pages intentionally show
  **Not launch-ready**.
- The base D1 schema and every unapplied migration through `0005` must be
  applied to the actual production database in numeric order and exercised
  with disposable accounts.
- A high-entropy `MODERATION_ADMIN_TOKEN` must be stored as a Worker secret and
  used only by the assigned operator; it must not be committed or shipped.
- The final signed AAB, deployed HTTPS endpoints, SDK behavior, account
  deletion, and Data safety answers must be tested together.
- Data safety accuracy does not establish rights to visual or audio assets.
  Every **Hold** in `docs/ASSET-PROVENANCE.md` remains a separate launch
  blocker.

## Official references (checked 2026-07-23)

- [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Google Mobile Ads Android data disclosure](https://developers.google.com/admob/android/privacy/play-data-disclosure)
- [Google Play account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Delete Play Games data or profile](https://support.google.com/googleplay/answer/9130646)
- [Google Play UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
