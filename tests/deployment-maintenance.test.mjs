import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(
  new URL('../scripts/deploy-worker-with-maintenance.ps1', import.meta.url),
  'utf8',
);
const playStoreListing = readFileSync(
  new URL('../docs/play-store-listing.md', import.meta.url),
  'utf8',
);

test('Worker release keeps maintenance fail-closed through migrations and live smoke checks', () => {
  const maintenanceDeploy = script.indexOf("DEPLOYMENT_MAINTENANCE:1");
  const maintenanceProof = script.indexOf('Assert-MaintenanceActive', maintenanceDeploy);
  const migration = script.indexOf('d1 migrations apply', maintenanceProof);
  const catchup = script.indexOf('--file server/migrations/0011_release_catchup.sql', migration);
  const schemaProof = script.indexOf('Assert-ReleaseSchema', catchup);
  const preOpenReferralSmoke = script.indexOf('    Assert-ReferralReadiness', schemaProof);
  const normalDeploy = script.indexOf("Invoke-Checked 'Final Worker deployment failed", preOpenReferralSmoke);
  const postOpenReferralSmoke = script.indexOf('        Assert-ReferralReadiness', normalDeploy);
  const legalSmoke = script.indexOf('$apiRoot/v1/legal', postOpenReferralSmoke);
  const d1Smoke = script.indexOf('$apiRoot/v1/board?limit=1', legalSmoke);
  const pvpDoSmoke = script.indexOf('$apiRoot/v1/pvp/readiness', d1Smoke);
  const recoveryDeploy = script.lastIndexOf("DEPLOYMENT_MAINTENANCE:1");

  assert.ok(maintenanceDeploy >= 0, 'maintenance Worker must deploy first');
  assert.ok(maintenanceProof > maintenanceDeploy, 'public maintenance must be observed before migration');
  assert.ok(migration > maintenanceProof, 'schema migration must wait for maintenance');
  assert.ok(catchup > migration, 'idempotent catch-up must run after tracked migrations');
  assert.ok(schemaProof > catchup, 'D1 invariants must pass before reopening the API');
  assert.ok(preOpenReferralSmoke > schemaProof,
    'live referral secret/registry readiness must pass while maintenance is still active');
  assert.ok(normalDeploy > preOpenReferralSmoke, 'normal Worker must deploy only after referral readiness');
  assert.ok(postOpenReferralSmoke > normalDeploy,
    'the final active deployment must repeat referral readiness');
  assert.ok(legalSmoke > normalDeploy, 'live legal/version smoke must run after reopening');
  assert.ok(d1Smoke > legalSmoke, 'live smoke must exercise the Worker D1 binding');
  assert.ok(pvpDoSmoke > d1Smoke,
    'live smoke must cross the PvP Durable Object and its D1 binding');
  assert.ok(recoveryDeploy > pvpDoSmoke, 'any failed live smoke must redeploy maintenance');
  assert.match(script, /Add-Type -AssemblyName System\.Net\.Http/,
    'Windows PowerShell 5 must load HttpClient explicitly');
  assert.match(script, /\$recoveryRequired = \$true[\s\S]*Invoke-Checked 'Final Worker deployment failed/,
    'maintenance recovery must become mandatory before final deploy can activate');
  assert.match(script, /if \(\$recoveryRequired\)[\s\S]*DEPLOYMENT_MAINTENANCE:1[\s\S]*Assert-MaintenanceActive/,
    'ambiguous final-deploy failures must restore and publicly verify maintenance');
  assert.doesNotMatch(script, /\$apiOpened/);
  assert.match(script, /attribution_provider','attribution_version'[\s\S]*referral_provider_columns -ne 4/,
    'release must prove the forward provider-boundary migration before reopening');
  assert.match(script, /account_deletion_jobs','referral_evidence_key_registry'[\s\S]*referral_lifecycle_tables -ne 2/,
    'release must prove resumable deletion and replay-pepper registry migrations');
  assert.match(script, /name='account_mutation_leases'[\s\S]*account_mutation_lease_tables -ne 1/,
    'release must prove the account mutation lease table before reopening');
  assert.match(script, /request_id','account_id','acquired_at_ms'[\s\S]*account_mutation_lease_columns -ne 3/,
    'release must prove every account mutation lease column before reopening');
  assert.match(script, /idx_account_mutation_leases_account'[\s\S]*account_mutation_lease_indexes -ne 1/,
    'release must prove the account mutation lease cleanup index before reopening');
  assert.match(script, /name='request_rate_limits'[\s\S]*rate_limit_tables -ne 1/,
    'release must prove the durable anti-abuse throttle migration');
  assert.match(script, /REFERRAL_EVIDENCE_HMAC_KEYRING_JSON/);
  assert.match(script, /REFERRAL_EVIDENCE_REPLAY_PEPPER/);
  assert.doesNotMatch(script, /REFERRAL_EVIDENCE_HMAC_SECRET/);
  assert.match(script, /\$apiRoot\/v1\/referral\/readiness/);
  assert.match(script, /Referral secret\/registry readiness failed/);
  assert.match(script, /tap_commit_barrier_until','quick_draw_issued_at'[\s\S]*pvp_match_realtime_columns -ne 2/,
    'release must prove the 0013 and 0014 match columns before reopening');
  assert.match(script, /raw_reaction_ms','rtt_adjustment_ms','reaction_transport'[\s\S]*pvp_score_realtime_columns -ne 3/,
    'release must prove all Quick Draw audit columns before reopening');
  assert.match(script, /pair_low_account_id','pair_high_account_id'[\s\S]*pvp_reward_pair_columns -ne 2/,
    'release must prove the 0018 unordered reward-pair columns before reopening');
  assert.match(script, /idx_pvp_rewards_pair'[\s\S]*pvp_reward_pair_indexes -ne 1/,
    'release must prove the rolling pair-history index before reopening');
  assert.match(script, /pragma_foreign_key_list\('pvp_rewards'\)[\s\S]*pvp_reward_foreign_keys -ne 0/,
    'reward history must not be deleted implicitly with a match or opponent');
  assert.match(script, /pvp_socket_tickets'[\s\S]*hardening_tables -ne 4/,
    'release must prove the one-use socket-ticket table before reopening');
  assert.match(script, /trg_pvp_release_locks_deleted'[\s\S]*hardening_triggers -ne 5/,
    'release must prove every lock-release trigger, including deleted matches');
  assert.match(script, /QUICK_DRAW_ROOMS[\s\S]*QuickDrawRoom[\s\S]*durable-object[\s\S]*sqlite/,
    'release must prove the configured SQLite Durable Object binding and export');
  assert.match(script, /pvpPayload\.ready -ne \$true/,
    'live PvP/DO smoke must validate the readiness response shape');
  assert.match(script, /PSObject\.Properties\['top'\][\s\S]*Value -isnot \[System\.Array\]/,
    'live D1 smoke must validate the Worker\'s actual { top, me, blocked } board shape');
  assert.doesNotMatch(script, /boardPayload\.entries/);
  assert.match(script, /\$payload\.ready -ne \$true[\s\S]*termsVersion -ne '2026-08-24-pvp1'/,
    'live legal smoke must validate the actual { ready, termsVersion } response shape');
  assert.doesNotMatch(script, /\$payload\.ok -ne \$true/);
});

test('Play launch checklist requires the complete current migration sequence', () => {
  assert.match(playStoreListing, /through\s+`0018_pvp_reward_forfeit_hardening\.sql`/);
  assert.doesNotMatch(playStoreListing, /through\s+`0017_request_rate_limits\.sql`/);
});
