# Referral verification and release gates

DISCIPLINE owns referral accounts, reward state, friends, and matches. Store
services are replaceable proof adapters. Android currently uses
`google_play_integrity`; a future iOS build can add `apple_app_attest` (and a
reviewed Apple attribution source) behind the same normalized server contract.
Google Play Games is not the friend database, so Android and iOS accounts can
share one friend graph and cross-play.

## Canonical invite link

The stable public link is owned by the DISCIPLINE Worker:
`https://discipline-api.nomogames.workers.dev/r/<CODE>`. Shared copy names no
store. The landing route currently exposes an Android button whose Play URL
preserves `referrer=discipline_ref%3D<CODE>`. The same `/r/<CODE>` URL remains
valid when a reviewed iOS destination is added; no App Store URL or custom
domain is guessed in this release. `PUBLIC_REFERRAL_BASE_URL` pins the current
verified Worker origin, while local/test Workers safely use their request
origin when that variable is absent. The Worker checks the code against D1
before rendering the invited/install page. Malformed, deleted, unknown, and
deletion-pending referrers return a non-attributing 404 page.

## Required Android release configuration

1. Link `com.nosiah.discipline` to the intended Google Cloud project in Play
   Console's Play Integrity settings.
2. Put that project's numeric project number in the ignored
   `android/private-release.properties` file as
   `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER=<number>`.
3. Enable the Play Integrity API and grant the Worker's service account access
   to decode integrity tokens for the app.
4. Keep `GOOGLE_SERVICE_ACCOUNT_JSON` server-only.
5. Set `REFERRAL_EVIDENCE_REPLAY_PEPPER` to the exact prior
   `REFERRAL_EVIDENCE_HMAC_SECRET` value. It is a permanent, high-entropy
   anti-replay pepper, not a routinely rotated signing key. Matching the prior
   value is what preserves every historical unversioned Android tombstone.
   The Worker stores a fixed-context HMAC tag in D1 and fails closed if this
   pepper is later replaced. Never commit it or place it in client code.
6. Store the rotatable active key configuration in the Worker secret
   `REFERRAL_EVIDENCE_HMAC_KEYRING_JSON`, for example:
   `{"current":"2026-08-a","keys":{"2026-08-a":"<32+ byte secret>","2026-07-a":"<retired secret>"}}`.
   The `current` key writes the private ledger identity; other entries are
   retired verification keys and can be removed after rollout because the
   permanent replay fingerprint is independent of them.
7. Do not apply the schema and deploy the Worker as unrelated commands. Run
   `npm run release:worker`, which first deploys this Worker with every `/v1`
   route in maintenance, applies migrations through
   `0017_request_rate_limits.sql`, reruns the idempotent 0011 catch-up,
   deploys the normal Worker, and verifies the
   public version response. Before reopening, the deployed maintenance Worker
   calls the non-secret `/v1/referral/readiness` route. That route parses and
   validates the live key-ring value, requires its current key, validates the
   permanent pepper length, verifies the D1 pepper-registry tag, and queries
   every column used from the live rate-limit table. The final active deployment
   repeats the same smoke. It returns only `{ready:true}` or a fail-closed 503;
   it never returns key IDs, tags, or secrets. If a migration,
   readiness check, final deploy, or smoke fails (including an ambiguous CLI
   failure after activation), the script restores and verifies maintenance.

## Proof contract

The Android adapter SHA-256 hashes a stable `referral_claim_v1` serialization
containing the authenticated DISCIPLINE account ID and every Android
attribution field. Play Integrity
returns that hash in a signed/encrypted standard token. The Worker sends the
token to Google's decode endpoint and requires:

- exact package and request hash;
- a fresh timestamp;
- `PLAY_RECOGNIZED` app recognition;
- release version code 12 or newer;
- `LICENSED` account verdict; and
- `MEETS_DEVICE_INTEGRITY`.

The server adapter validates those Android fields, then emits only normalized
provider, referral, evidence, timing, version, and proof metadata to the shared
claim/reward domain. That domain never parses Install Referrer or assumes Google
field names. The exact Android `referral_evidence_v1` HMAC serialization is
permanent because deletion tombstones cannot be reconstructed; future provider
adapters use their own versioned evidence canonicalization without changing it.

Before calling Google, the server parses the provider envelope and performs the
account-age, code, self-referral, already-claimed, and lifetime-replay checks in
D1. It then applies durable account, source-IP, and source-IP-plus-code limits
before consuming Play Integrity quota. The public code is never globally
throttled, so one source cannot suppress a legitimate viral invite. Raw IPs and
codes are not stored in the throttle table; scope-separated HMAC subjects,
fixed-window counts, and window times are pruned hourly after 24 hours. Google
OAuth access tokens are cached with an expiry margin and a single-flight
refresh, with one forced refresh on a rejected cached credential. The server
repeats terminal claim checks after proof verification. The first statement in
the mutation batch conditionally acquires the claim ledger only if all checks
still pass, so a deletion or competing claim at that boundary grants nothing.

Every accepted claim stores a versioned ledger HMAC under the current rotatable
key and a lifetime replay HMAC under the permanent pepper. Android claims also
store and check the exact historical `h1_` form under that same pepper. This
preserves tombstones written before the key ring existed and keeps a safely
configured emergency rollback from reopening claims created after it. Active
keys can therefore rotate out without reopening replay; changing the permanent
pepper fails closed. Missing proof, configuration, or a failed verdict grants
nothing.

Account deletion pages through live referral claims eight at a time. Each page
bulk-persists every replay fingerprint and advances an idempotent D1 cursor in
one bounded transaction. Only after no claims remain does a fixed-size final
transaction erase the account and plaintext claims. HTTP 202 includes an
advancing progress token and bounded retry delay. Clients stop on a repeated
token and cap each paced attempt, leaving the durable deletion job resumable
instead of hammering indefinitely. New claims involving that account are
blocked while the job exists.

The Android client owns the only referral retry loop: two short retries inside
a strict 20-second wall-clock bound. Native Play Integrity does not nest its
own backoff. Semantic terminal results are versioned and persisted per account;
network/provider/configuration failures remain recoverable on a later launch.
Referral proof and status refresh run in the background and never block startup
or the Terms flow.

## Verification boundary

A sideloaded debug APK intentionally cannot prove a Play-delivered referral.
End-to-end release evidence requires installing the signed build from a Google
Play internal or closed track through a real referral link, then confirming the
claim and reward in the production-equivalent backend. Do not call referral
verification complete based only on a sideload or mocked verdict.

## Future iOS adapter boundary

`apple_app_attest` is reserved as a proof provider and fails closed today. The
Apple attribution source is deliberately not guessed. An iOS release must
select and review an Apple-supported attribution source, implement and test it
together with App Attest, normalize their result into the existing server claim
contract, and add an iOS destination to `/r/<CODE>`. It must not reuse Google
timestamps, Android Install Referrer, Play Integrity, or the Android HMAC
canonicalization.
