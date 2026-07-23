# DISCIPLINE. privacy-policy deployment

The production account service serves the public policy at `/privacy` and the web account-deletion flow at `/account-deletion`. The Play Console entries must use the deployed HTTPS URLs, not this repository file.

The policy currently discloses:

- username, salted password hash, account identifier, and hashed session tokens;
- cloud-save progress, settings, inventory, verified purchase grants, and leaderboard taps;
- product IDs, platform transaction IDs, purchase-token hashes, and granted currency used for verification and duplicate-grant prevention;
- Google Mobile Ads data processing for advertising, analytics, diagnostics, and fraud prevention;
- cross-device synchronization, purchase restoration, retention, security, and account deletion;
- in-app and web deletion paths.

Launch checklist:

- Deploy `server/worker.js` and its D1 schema to the production account-service domain.
- Confirm `https://<production-api>/privacy` loads without authentication.
- Confirm `https://<production-api>/account-deletion` loads without authentication.
- Test deletion on a disposable account and verify the account, sessions, save, score, and purchase-ledger rows are gone.
- Put the production `/privacy` URL in Play Console → App content → Privacy policy.
- Put the production `/account-deletion` URL in Play Console’s account-deletion field.
- Use the same public links when an iOS build is added.

Relevant Google requirements:

- [Account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Data safety form guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Google Mobile Ads data disclosure](https://developers.google.com/ad-manager/mobile-ads-sdk/android/privacy/play-data-disclosure)
