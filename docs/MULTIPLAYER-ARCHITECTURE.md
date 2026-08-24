# Cross-platform multiplayer architecture

## Ownership boundary

DISCIPLINE owns the canonical account ID, friend code, friendship graph, match
ID, authoritative round clock, score submissions, result, and reward ledger.
Those records live in the DISCIPLINE Worker/D1 service and never use a Google
Play Games or Apple Game Center identifier as a foreign key. An Android player
and a future iOS player therefore enter the same friend graph and match service.

Google Play Games and Game Center are optional platform integrations. They may
provide sign-in convenience, achievements, or platform leaderboards, but they
do not own friends, invitations, matches, or the eligible five-Mentality reward. If
platform-account linking is added later, the link maps a provider subject to an
existing DISCIPLINE account; it does not replace the DISCIPLINE account ID.

## Client and proof adapters

The shared TypeScript client uses the same REST contract on every platform:

- `/v1/friends/*` for the platform-neutral friend graph;
- `/v1/pvp/*` for invitations and server-authoritative rounds; and
- `/v1/referral/claim` for a normalized, provider-tagged proof envelope.

Quick Draw adds one platform-neutral realtime path to that contract. An
authenticated player first mints a short-lived, one-use socket ticket over
REST, then upgrades to the match's Cloudflare Durable Object through
`/v1/pvp/<match>/quick-draw/socket`. The ticket is atomically consumed before
the Worker injects the trusted account and match IDs; the browser cannot choose
either identity in the Durable Object request.

Each match uses one SQLite-backed `QuickDrawRoom`. The object uses Cloudflare's
WebSocket Hibernation API (`acceptWebSocket`, tagged `getWebSockets`, and
serialized attachments), stores a fresh 128-bit nonce for each round, and
pushes the same DRAW event to both players. It accepts only one nonce-bound
response per account and scores strictly from raw server receipt time. Before
DRAW it sends five server-originated pings; with at least three valid samples,
it records half the median round-trip time, capped at 75 ms, as telemetry only.
That telemetry cannot alter the competitive score or winner. D1 records the raw
reaction, bounded RTT telemetry, competitive reaction, and transport for audit.

REST state remains the recovery path, not the primary Quick Draw clock. If the
Durable Object has not issued DRAW within 750 ms of the planned time, a state
request may atomically claim the issue time and initialize the room. A REST
reaction receives no latency adjustment. Reconnection mints a new one-use
ticket and retrieves the authoritative D1 state, so hibernation or a dropped
socket does not strand the match.

Referral shares use the DISCIPLINE-owned `/r/<code>` route rather than a direct
store URL. Android's destination preserves Play Install Referrer; a future iOS
destination can be added behind that unchanged link. Provider-specific request
fields are verified and normalized at the Worker boundary before the shared
referral and reward logic runs.

Android currently implements only the `google_play_integrity` referral-proof
adapter. `apple_app_attest` is reserved and fails closed until its server
verifier and an Apple-supported attribution source are implemented. Adding the
iOS adapter must not change account, friendship, match, or reward schemas.

## Rules that preserve cross-play

- Never use Play Games real-time multiplayer or Game Center matches as the
  authoritative match transport.
- Never use a platform friend list as the DISCIPLINE friend graph.
- Never expose or trust client-selected winners, clocks, or reward amounts.
- Keep platform proof provider names versioned and verify them behind a server
  adapter before mutating shared domain records.
- Keep game modes (`tap`, `quick_draw`) and durations (30/60/90 seconds) in the
  shared API, not in Android-specific code.
- A first-round tie starts exactly one opposite-mode tiebreaker. A tie in that
  second round ends without a winner or reward; it never starts a third round.
- After a decisive-round deadline, one participant and one no-show produces a
  forfeit win; no input from either player remains a no-contest. Removing a
  friend, blocking the opponent, or deleting an account during an active match
  forfeits to the opponent, while an invitation that has not started cancels.
- An eligible win grants five Mentality without a wager. Reward insertion and
  both rolling gates are one database transaction: at most ten rewarded wins
  per winning account and at most one rewarded result per unordered player pair
  in any 24-hour window. A match can validly complete with a zero reward.
- A platform outage may disable that platform's proof adapter, but it must not
  split existing accounts or create a separate Android-only player network.

## Fairness boundary

The server no longer trusts a client clock, polling interval, chosen winner, or
reward amount. Server push, one-use tickets, per-round nonces, one response per
account, raw server receipt timing, database state revisions, and the reward
ledger remove the earlier polling/clock race from the normal
Quick Draw path.

This is anti-cheat hardening, not proof of a human finger. A modified client can
still automate a response or submit cumulative tap totals within the server's
plausibility limit. Those are client-submitted, server-recorded counts, not
verified physical taps. Delayed ping echoes only affect telemetry, never the
winner. REST recovery is also less latency-fair than the primary socket path.
These residual limits must remain explicit in release review; they must not be
represented as perfect cheat prevention. The 24-hour winner and unordered-pair
reward gates bound simple collusion but do not prove that two real accounts are
operated independently.

Wrangler uses the current declarative `[exports.QuickDrawRoom]` SQLite Durable
Object configuration because this Worker had no legacy Durable Object migration
history. It intentionally does not add legacy `[[migrations]]` entries; Wrangler
treats declarative exports and legacy Durable Object migrations as mutually
exclusive. `npm run release:worker` verifies the D1 columns/ticket table, the
binding/export configuration, and a live Worker-to-Durable-Object-to-D1
readiness path before maintenance is removed.

## iOS integration path

1. Build the Capacitor iOS target from the same web client and API types.
2. Implement an Apple proof plugin that emits the normalized
   `apple_app_attest` envelope for the exact action being verified.
3. Add and independently test the server verifier while leaving unsupported
   proofs fail-closed.
4. Optionally map Game Center identity to a DISCIPLINE account for convenience;
   retain the internal account and friend code as canonical.
5. Run two-device Android/iOS friend, invitation, tap, Quick Draw, tiebreaker,
   disconnect, and reward-ledger tests against the same backend.
