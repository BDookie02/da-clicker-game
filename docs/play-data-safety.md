# Google Play Data safety working declaration

This is the engineering source of truth for completing the Play Console form. Reconfirm it against the exact production SDK versions and backend configuration before submission.

## App/account service

| Data | Collected | Shared | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Username/account ID | Yes | No | Account management | User-created game identity; no legal name or email required. |
| Password | Yes | No | Account security | Transmitted over HTTPS; stored only as a salted PBKDF2 hash. |
| Game progress, inventory, settings | Yes | No | App functionality | Enables cloud save and cross-device transfer. |
| Physical tap total | Yes | No | App functionality | Used for the real-player leaderboard. |
| Purchase/product and transaction identifiers | Yes | Google Play processes payment | App functionality, fraud prevention | The service stores verification/ledger data, not card details. |
| Rewarded-ad transaction and reward identifiers | Yes | Google Mobile Ads processes the ad event | App functionality, fraud prevention | Signed SSV callbacks are kept in a per-account duplicate-prevention ledger. |

## Google Mobile Ads SDK

Declare the data types and purposes reported by the exact Google Mobile Ads SDK version in the production build. Google’s current Android disclosure identifies IP-derived approximate location, app/product interactions, diagnostics, device/account identifiers, and advertising data for advertising, analytics, and fraud prevention. Rewarded ads must remain optional.

## Security and deletion answers

- Data is encrypted in transit: **Yes** for the production HTTPS API and SDK network traffic.
- Users can request deletion: **Yes** in Settings → Delete account and at the public `/account-deletion` page.
- Deletion covers the account, sessions, cloud save, score/leaderboard row, rewarded-ad ledger, and DISCIPLINE. purchase ledger.
- Google Play or Apple may retain their own transaction records under their platform obligations.
- Advertising privacy choices can be revisited from Settings through the UMP privacy-options form.

Before submitting, install the exact signed internal-test AAB, exercise account creation/deletion and rewarded ads, then reconcile the form with [Google Play’s Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469) and [Google’s Mobile Ads disclosure](https://developers.google.com/ad-manager/mobile-ads-sdk/android/privacy/play-data-disclosure).
