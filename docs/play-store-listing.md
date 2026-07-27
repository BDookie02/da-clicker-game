# Google Play pre-release listing - DISCIPLINE.

## Short description (80 characters)

Tap through red lights, build Respect, and outlast every rival.

## Full description

DISCIPLINE. is a pixel-styled idle tapper about one red light, one shaking car,
and the will to keep tapping.

Build Respect with every tap, recruit a Crew that keeps the grind going, and
upgrade your power to outlast increasingly unhinged rivals. When the meter hits
100%, the light turns green - and the next challenger pulls up.

- Tap to build Respect.
- Recruit a Crew for idle progress.
- Upgrade tap power and permanent route abilities.
- Face handcrafted rivals, then endless procedurally assembled opponents.
- Drive through city districts that change as you progress.
- Customize your ride with garage cosmetics, dashboard collectibles, horns,
  danglers, decals, and more.
- Earn optional boosters or M by fully watching rewarded ads.
- Create a DISCIPLINE account to keep progress, inventory, and verified
  purchases with that account across supported devices.
- Compete using raw physical taps on the public worldwide leaderboard.

No brakes. No excuses. Make eye contact.

## Play Console declaration sheet

| Field | Launch entry / status |
| --- | --- |
| Contains ads | **Yes** - optional rewarded AdMob ads |
| In-app purchases | **Yes** - consumable M currency products |
| Account creation | **Yes** - username/password DISCIPLINE account |
| Public UGC | **Yes** - username shown with tap total and rank |
| Google Play Games | **Yes** - sign-in and all-time-taps leaderboard |
| Privacy-policy URL | `[REQUIRED: deployed HTTPS /privacy URL]` |
| Account-deletion URL | `[REQUIRED: deployed HTTPS /account-deletion URL]` |
| Developer/publisher name | `[REQUIRED: exact Play listing name]` |
| Support/privacy email | `[REQUIRED: monitored private contact]` |
| Target audience | `[REQUIRED: owner selection after content/ad review]` |
| Content rating | `[REQUIRED: complete IARC questionnaire from actual content]` |
| Data safety | Use `docs/play-data-safety.md`; recheck against final signed AAB |

Do not submit while placeholders remain.

## Public-username UGC launch gate

The source now implements all of the following:

- Terms/user-policy acceptance before the username becomes public;
- clear rules prohibiting objectionable usernames and behavior;
- in-app report and block/hide actions;
- a durable moderation queue and secret-protected review/action API.

That implementation does not by itself make the public board launch-ready.
Before submission, apply the UGC migration to production D1, set a real
`MODERATION_ADMIN_TOKEN`, assign a human operator, document the review cadence,
escalation, and appeals/contact process, and exercise the complete runbook
against disposable production-track accounts. If that operating process will
not exist at launch, replace public player-chosen names with
developer-generated identifiers before submission.

## Unresolved launch blockers

- Provide the real publisher/legal name, monitored support/privacy email,
  actual policy effective date, production policy/deletion URLs, provider
  log/backup retention wording, and target-audience/age decision.
- Pass the production Worker environment to the legal-page renderers and
  configure the five `LEGAL_*` values listed in `docs/privacy-policy.md`.
- Apply the current base D1 schema and every unapplied migration through `0005`
  to the production database in numeric order, then verify account deletion,
  moderation, purchase financials, and refund reconciliation end to end.
- Assign the moderation operator and configure the production-only moderation
  secret described in `docs/MODERATION.md`.
- Resolve every **Hold** in `docs/ASSET-PROVENANCE.md`, including generated
  portraits, music, sound effect, icon/likeness evidence, and final listing
  imagery. Do not treat a successful build as rights clearance.

## Screenshot plan

Use only a normal player account and ordinary gameplay. Do not capture
developer tools, cheat settings, debug text, emulator controls, test ads, test
currency, private account information, or unmoderated/offensive usernames.

1. Red-light gameplay - active rival, progress meter, and primary HUD.
2. Garage - first-person interior with centered mirror and correctly placed
   dashboard-slot cosmetics.
3. Upgrades or Crew - a naturally progressed view showing the progression loop.
4. Market - normal storefront with clearly recognizable cosmetics and prices.
5. Ranks - only after the real public board and moderation controls are live;
   use safe test usernames created for the listing.

Capture portrait screenshots from the exact release candidate at
1080 x 1920 or another Play-accepted portrait size. Retain the game UI, but do
not include emulator-only controls or desktop chrome.

## Final listing checks

- The short description is 63 characters including punctuation.
- The listing discloses ads, purchases, account creation, public usernames, and
  the public tap leaderboard.
- The privacy policy and deletion URLs work while logged out.
- The Data safety form matches the exact active AAB/SDK versions.
- The implemented Terms/moderation controls are deployed to the migrated
  production database and operated by the assigned reviewer before any public
  user-chosen username is shown.
- No legal page displays **Not launch-ready**, and no item in the unresolved
  launch-blocker list above remains.

Official references:

- [Store listing requirements](https://support.google.com/googleplay/android-developer/answer/9859152)
- [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Google Play UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
