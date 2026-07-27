# Leaderboard moderation runbook

The public leaderboard accepts only accounts that have accepted the current
Terms version. Signed-in players can report another leaderboard row and can
hide/unhide it for their own account. The client never receives a D1 account
id, session token belonging to another player, or any moderator credential.

The source implementation and automated tests exist, but that is only the
software half of the control. This runbook is not operational until the
production D1 migration is applied, a real secret is configured, and a named
human operator owns the review schedule and escalation path.

## Production database prerequisite

Apply `server/migrations/0003_ugc_terms_and_moderation.sql` to the production
D1 database after the base schema and prior migrations. Verify that
`account_profiles`, `account_blocks`, and `username_reports` plus their indexes
exist before enabling the public board. Use disposable accounts to test Terms
acceptance, report deduplication, hide/unhide, suspension, restoration, and
account deletion against that exact database.

Do not infer migration success from the presence of the SQL file in Git.

## Production secret

Create a high-entropy token (at least 32 characters) in a password manager and
store it only as the Worker secret:

```powershell
wrangler secret put MODERATION_ADMIN_TOKEN
```

Never put that value in `.env*`, Android resources, JavaScript, screenshots, or
Play Console listing text. The moderation endpoints return `503` when the
secret is not configured and `401` for a missing or incorrect bearer token.
The public board and report submission also fail closed while the secret is
missing, so player-created names cannot go live without a review path.

## Review queue

Use an authenticated HTTP client from an operator-controlled machine:

```text
GET /v1/admin/reports?status=open&limit=50
Authorization: Bearer <MODERATION_ADMIN_TOKEN>
```

Valid queue states are `open`, `reviewing`, `actioned`, and `dismissed`. A
report contains the public usernames, reason, optional player explanation,
timestamps, and an opaque reported-player reference. It never returns password
hashes, session tokens, purchase tokens, or D1 account ids.

Claim or resolve a report with:

```text
PUT /v1/admin/reports/123
Authorization: Bearer <MODERATION_ADMIN_TOKEN>
Content-Type: application/json
```

```json
{
  "status": "reviewing",
  "moderatorNote": "Review started.",
  "leaderboardAction": "none"
}
```

After reviewing the visible username and score evidence, use one of:

- `leaderboardAction: "suspend"` with `status: "actioned"` to remove that
  account from every public leaderboard response.
- `leaderboardAction: "restore"` to restore a previously suspended account.
- `leaderboardAction: "none"` with `status: "dismissed"` when no action is
  warranted.

Moderator notes are limited to 500 characters. There is intentionally no
shipped moderator screen in the game.

## Operating requirement

Before enabling the public board in production, assign a real operator and a
review cadence, test the queue using disposable accounts, document escalation
criteria and an appeals/contact path, and rotate the secret if it is ever
exposed. Record the operator role, backup operator, expected response time, and
where evidence of each decision is retained. Code can provide the queue and
enforcement path; it cannot guarantee that a human review process is staffed.

The monitored moderation/privacy contact must be the owner-approved
`LEGAL_CONTACT_EMAIL`; do not substitute a public issue tracker or invent an
operator identity in documentation.

## Terms updates

For a material Terms change:

1. Update the Terms copy and `TERMS_VERSION` in `server/worker.js`.
2. Deploy the Worker.
3. Verify an existing account can still play and retain local/offline progress.
4. Verify its public board access returns `terms_required` until the in-app
   reaccept flow succeeds.
5. Verify a new account cannot be created with the previous version.
