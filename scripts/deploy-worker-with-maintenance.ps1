$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$root = Split-Path -Parent $PSScriptRoot
$wranglerVersion = '4.125.0'
$apiRoot = 'https://discipline-api.nomogames.workers.dev'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    & $Command
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

function Assert-RequiredSecrets {
    $raw = & npx.cmd -y "wrangler@$wranglerVersion" secret list --format json
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Worker secret inventory.' }
    $names = @($raw | ConvertFrom-Json | ForEach-Object { [string]$_.name })
    foreach ($required in @(
        'GOOGLE_SERVICE_ACCOUNT_JSON',
        'REFERRAL_EVIDENCE_HMAC_KEYRING_JSON',
        'REFERRAL_EVIDENCE_REPLAY_PEPPER'
    )) {
        if ($names -notcontains $required) {
            throw "Required Worker secret is missing: $required"
        }
    }
}

function Get-ApiResponse {
    param([Parameter(Mandatory = $true)][string]$Uri)
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    try {
        $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
    }
    finally {
        $client.Dispose()
    }
}

function Assert-MaintenanceActive {
    $response = Get-ApiResponse "$apiRoot/v1/legal"
    $payload = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -ne 503 -or $payload.error -ne 'service_maintenance') {
        throw "Maintenance deployment was not observable at the public API (HTTP $($response.StatusCode))."
    }
}

function Assert-ReferralReadiness {
    $response = Get-ApiResponse "$apiRoot/v1/referral/readiness"
    $payload = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -ne 200 -or $payload.ready -ne $true) {
        throw "Referral secret/registry readiness failed (HTTP $($response.StatusCode))."
    }
}

function Invoke-D1Json {
    param([Parameter(Mandatory = $true)][string]$Sql)
    $raw = & npx.cmd -y "wrangler@$wranglerVersion" d1 execute discipline-db `
        --remote --command $Sql --json
    if ($LASTEXITCODE -ne 0) { throw 'Could not execute the remote D1 release invariant query.' }
    $payload = @($raw | ConvertFrom-Json)
    $result = @($payload)[0]
    if ($result.success -ne $true) { throw 'Remote D1 release invariant query did not succeed.' }
    return @($result.results)[0]
}

function Assert-ReleaseSchema {
    $row = Invoke-D1Json @'
SELECT
  (SELECT COUNT(*) FROM pragma_table_info('referral_claims')
    WHERE name IN ('proof_provider','proof_app_version_code',
      'attribution_provider','attribution_version')) AS referral_provider_columns,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table'
    AND name IN ('referral_claim_ledger','referral_reward_ledger','pvp_player_locks',
      'pvp_socket_tickets')) AS hardening_tables,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table'
    AND name IN ('account_deletion_jobs','referral_evidence_key_registry'))
      AS referral_lifecycle_tables,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table'
    AND name='account_mutation_leases') AS account_mutation_lease_tables,
  (SELECT COUNT(*) FROM pragma_table_info('account_mutation_leases')
    WHERE name IN ('request_id','account_id','acquired_at_ms'))
      AS account_mutation_lease_columns,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index'
    AND name='idx_account_mutation_leases_account') AS account_mutation_lease_indexes,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table'
    AND name='request_rate_limits') AS rate_limit_tables,
  (SELECT COUNT(*) FROM pragma_table_info('pvp_matches')
    WHERE name IN ('tap_commit_barrier_until','quick_draw_issued_at')) AS pvp_match_realtime_columns,
  (SELECT COUNT(*) FROM pragma_table_info('pvp_round_scores')
    WHERE name IN ('raw_reaction_ms','rtt_adjustment_ms','reaction_transport')) AS pvp_score_realtime_columns,
  (SELECT COUNT(*) FROM pragma_table_info('pvp_rewards')
    WHERE name IN ('pair_low_account_id','pair_high_account_id')) AS pvp_reward_pair_columns,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index'
    AND name='idx_pvp_rewards_pair') AS pvp_reward_pair_indexes,
  (SELECT COUNT(*) FROM pragma_foreign_key_list('pvp_rewards')) AS pvp_reward_foreign_keys,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'
    AND name IN ('trg_referral_claim_legacy_ledger','trg_referral_reward_legacy_ledger',
      'trg_pvp_acquire_locks_insert','trg_pvp_release_locks_terminal',
      'trg_pvp_release_locks_deleted')) AS hardening_triggers,
  (SELECT COUNT(*) FROM referral_claims rc WHERE NOT EXISTS (
    SELECT 1 FROM referral_claim_ledger cl
    WHERE cl.referred_account_id=rc.referred_account_id)) AS missing_claim_ledgers,
  (SELECT COUNT(*) FROM referral_rewards rr WHERE NOT EXISTS (
    SELECT 1 FROM referral_reward_ledger rl
    JOIN referral_claim_ledger cl ON cl.evidence_key=rl.evidence_key
    WHERE cl.referred_account_id=rr.referred_account_id)) AS missing_reward_ledgers,
  (SELECT COUNT(*) FROM pvp_matches m WHERE status IN ('invited','active')
    AND 2<>(SELECT COUNT(*) FROM pvp_player_locks l WHERE l.match_id=m.id)) AS lockless_matches;
'@
    $wranglerConfig = Get-Content -LiteralPath (Join-Path $root 'wrangler.toml') -Raw
    $hasQuickDrawBinding = $wranglerConfig -match '(?s)\[\[durable_objects\.bindings\]\].*?name\s*=\s*"QUICK_DRAW_ROOMS".*?class_name\s*=\s*"QuickDrawRoom"'
    $hasQuickDrawExport = $wranglerConfig -match '(?s)\[exports\.QuickDrawRoom\].*?type\s*=\s*"durable-object".*?storage\s*=\s*"sqlite"'
    if ([int]$row.referral_provider_columns -ne 4 -or [int]$row.hardening_tables -ne 4 `
        -or [int]$row.referral_lifecycle_tables -ne 2 `
        -or [int]$row.account_mutation_lease_tables -ne 1 `
        -or [int]$row.account_mutation_lease_columns -ne 3 `
        -or [int]$row.account_mutation_lease_indexes -ne 1 `
        -or [int]$row.rate_limit_tables -ne 1 `
        -or [int]$row.pvp_match_realtime_columns -ne 2 `
        -or [int]$row.pvp_score_realtime_columns -ne 3 `
        -or [int]$row.pvp_reward_pair_columns -ne 2 `
        -or [int]$row.pvp_reward_pair_indexes -ne 1 `
        -or [int]$row.pvp_reward_foreign_keys -ne 0 `
        -or [int]$row.hardening_triggers -ne 5 -or [int]$row.missing_claim_ledgers -ne 0 `
        -or [int]$row.missing_reward_ledgers -ne 0 -or [int]$row.lockless_matches -ne 0 `
        -or -not $hasQuickDrawBinding -or -not $hasQuickDrawExport) {
        throw "Remote D1 release invariants failed: $($row | ConvertTo-Json -Compress)"
    }
}

Push-Location $root
try {
    Invoke-Checked 'Worker tests failed; nothing was deployed.' { npm.cmd test }
    Invoke-Checked 'Production web build failed; nothing was deployed.' { npm.cmd run build }
    Assert-RequiredSecrets

    # This version can load against the old schema, but every /v1 request is
    # rejected before touching D1. If any later step fails, maintenance stays
    # enabled rather than reopening a mixed-schema service.
    Invoke-Checked 'Could not enable API maintenance; migrations were not started.' {
        npx.cmd -y "wrangler@$wranglerVersion" deploy --keep-vars --var 'DEPLOYMENT_MAINTENANCE:1'
    }

    Assert-MaintenanceActive

    # Requests already executing on the prior Worker are allowed to drain only
    # after the maintenance response is publicly observable. Compatibility
    # triggers in 0011 protect any straggler at the database statement itself.
    Start-Sleep -Seconds 30

    Invoke-Checked 'D1 migration failed; API remains safely in maintenance.' {
        npx.cmd -y "wrangler@$wranglerVersion" d1 migrations apply discipline-db --remote
    }

    # Rerun the idempotent catch-up after the drain even when Wrangler already
    # recorded migration 0011. This closes any legacy row written by a request
    # that began before maintenance became visible.
    Invoke-Checked 'D1 catch-up failed; API remains safely in maintenance.' {
        npx.cmd -y "wrangler@$wranglerVersion" d1 execute discipline-db --remote `
            --file server/migrations/0011_release_catchup.sql
    }
    Assert-ReleaseSchema

    # The maintenance Worker exposes only this non-secret readiness result.
    # Run it after migration but before reopening any user API route so a
    # malformed key ring, short secret, missing current key, or replay-pepper
    # registry mismatch leaves the service safely in maintenance.
    Assert-ReferralReadiness

    $recoveryRequired = $true
    try {
        Invoke-Checked 'Final Worker deployment failed; API remains safely in maintenance.' {
            npx.cmd -y "wrangler@$wranglerVersion" deploy
        }

        # Recheck the final active deployment rather than assuming the
        # pre-open maintenance revision and final revision have identical
        # bindings and secret values.
        Assert-ReferralReadiness

        $legal = Get-ApiResponse "$apiRoot/v1/legal"
        if ($legal.StatusCode -ne 200) {
            throw "Final Worker smoke check returned HTTP $($legal.StatusCode)."
        }
        $payload = $legal.Content | ConvertFrom-Json
        if ($payload.ready -ne $true -or $payload.termsVersion -ne '2026-08-24-pvp1') {
            throw 'Final Worker legal/version response does not match this release.'
        }

        # Exercise the newly deployed Worker's actual D1 binding, not just a
        # static/public legal response or an out-of-band Wrangler query.
        $board = Get-ApiResponse "$apiRoot/v1/board?limit=1"
        if ($board.StatusCode -ne 200) {
            throw "Final Worker D1 smoke check returned HTTP $($board.StatusCode)."
        }
        $boardPayload = $board.Content | ConvertFrom-Json
        $topProperty = $boardPayload.PSObject.Properties['top']
        if ($null -eq $topProperty -or $topProperty.Value -isnot [System.Array]) {
            throw 'Final Worker D1 smoke response is missing the leaderboard payload.'
        }

        # This live path crosses the deployed Worker, the QUICK_DRAW_ROOMS
        # Durable Object binding, the new class export, and the DO's D1 binding.
        # Any missing 0013/0014 schema object returns non-200 and re-enables
        # maintenance instead of reopening an API that fails during a match.
        $pvp = Get-ApiResponse "$apiRoot/v1/pvp/readiness"
        if ($pvp.StatusCode -ne 200) {
            throw "Final Worker PvP/DO smoke check returned HTTP $($pvp.StatusCode)."
        }
        $pvpPayload = $pvp.Content | ConvertFrom-Json
        if ($pvpPayload.ready -ne $true) {
            throw 'Final Worker PvP/DO smoke response is not ready.'
        }
        $recoveryRequired = $false
    }
    catch {
        $failure = $_
        # Wrangler can activate a deployment and still exit nonzero after a
        # lost response. Always restore maintenance for any final-stage
        # failure, including that ambiguous-success window.
        if ($recoveryRequired) {
            & npx.cmd -y "wrangler@$wranglerVersion" deploy --keep-vars --var 'DEPLOYMENT_MAINTENANCE:1'
            if ($LASTEXITCODE -ne 0) {
                throw "Final verification failed and maintenance recovery also failed: $($failure.Exception.Message)"
            }
            Assert-MaintenanceActive
        }
        throw $failure
    }
    Write-Output 'Worker maintenance drain, migrations, invariants, deployment, and smoke check passed.'
}
finally {
    Pop-Location
}
