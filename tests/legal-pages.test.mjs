import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deletionPage, privacyPage, termsPage } from '../server/legal-pages.js';

const completeLegalEnv = {
  LEGAL_PUBLISHER_NAME: 'Example Publisher LLC',
  LEGAL_CONTACT_EMAIL: 'privacy@example.test',
  LEGAL_EFFECTIVE_DATE: '2026-07-23',
  LEGAL_RETENTION_NOTICE: 'Infrastructure security logs are retained for the publisher-approved period.',
  LEGAL_TARGET_AUDIENCE_NOTICE: 'Use is subject to the final age eligibility stated by the publisher.',
};

test('unconfigured legal pages fail visibly instead of inventing release facts', () => {
  for (const page of [privacyPage(), termsPage('2026-07-23'), deletionPage()]) {
    assert.match(page, /Not launch-ready/);
    assert.match(page, /LEGAL_PUBLISHER_NAME/);
    assert.match(page, /LEGAL_CONTACT_EMAIL/);
    assert.match(page, /LEGAL_EFFECTIVE_DATE/);
    assert.doesNotMatch(page, /github\.com\/BDookie02\/da-clicker-game\/issues/);
    assert.doesNotMatch(page, /not directed to children under 13/i);
    assert.doesNotMatch(page, /Effective July 22, 2026/);
  }
});

test('configured legal pages show explicit publisher-provided facts', () => {
  const privacy = privacyPage(completeLegalEnv);
  const terms = termsPage('v1', completeLegalEnv);
  const deletion = deletionPage(completeLegalEnv);

  for (const page of [privacy, terms, deletion]) {
    assert.doesNotMatch(page, /Not launch-ready/);
    assert.match(page, /Published by Example Publisher LLC/);
    assert.match(page, /Effective 2026-07-23/);
    assert.match(page, /mailto:privacy@example\.test/);
  }
  assert.match(privacy, /Infrastructure security logs are retained/);
  assert.match(privacy, /Use is subject to the final age eligibility/);
});

test('legal configuration is validated and escaped before rendering', () => {
  const page = privacyPage({
    ...completeLegalEnv,
    LEGAL_PUBLISHER_NAME: '<script>alert(1)</script>',
    LEGAL_CONTACT_EMAIL: 'not-an-email',
    LEGAL_EFFECTIVE_DATE: 'July 23, 2026',
    LEGAL_RETENTION_NOTICE: '<b>forever</b>',
    LEGAL_TARGET_AUDIENCE_NOTICE: '<img src=x onerror=alert(1)>',
  });

  assert.match(page, /Not launch-ready/);
  assert.match(page, /LEGAL_CONTACT_EMAIL \(valid email required\)/);
  assert.match(page, /LEGAL_EFFECTIVE_DATE \(YYYY-MM-DD required\)/);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(page, /<b>forever<\/b>/);
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /&lt;b&gt;forever&lt;\/b&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('Terms version is escaped', () => {
  const page = termsPage('<img src=x>', completeLegalEnv);
  assert.doesNotMatch(page, /<img src=x>/);
  assert.match(page, /Version &lt;img src=x&gt;/);
});

test('impossible calendar dates remain a visible launch blocker', () => {
  const page = privacyPage({
    ...completeLegalEnv,
    LEGAL_EFFECTIVE_DATE: '2026-02-31',
  });
  assert.match(page, /Not launch-ready/);
  assert.match(page, /LEGAL_EFFECTIVE_DATE \(YYYY-MM-DD required\)/);
});

test('served privacy copy discloses the authoritative purchase financial ledger', () => {
  const page = privacyPage(completeLegalEnv);
  assert.match(page, /purchase-token hashes/);
  assert.match(page, /quantity/);
  assert.match(page, /billing region/);
  assert.match(page, /exact paid amount and currency/);
  assert.match(page, /standard\/test\/promo\/rewarded purchase classification/);
  assert.match(page, /financial\/order status/);
  assert.match(page, /refund\/void evidence/);
});

test('privacy and web deletion disclose local saves that cannot be erased remotely', () => {
  assert.match(privacyPage(completeLegalEnv), /cannot remotely erase a local save/i);
  assert.match(deletionPage(completeLegalEnv), /cannot remotely erase a local save/i);
});

test('privacy copy discloses rewarded and interstitial Google Mobile Ads', () => {
  const privacy = privacyPage(completeLegalEnv);
  assert.match(privacy, /provide rewarded and interstitial ads/);
  assert.match(privacy, /Rewarded and interstitial advertising uses Google Mobile Ads/);
});

test('leaderboard copy describes client-submitted plausibility-limited scores accurately', () => {
  const privacy = privacyPage(completeLegalEnv);
  assert.match(privacy, /client-submitted cumulative tap total/);
  assert.match(privacy, /plausibility ceiling of 25 taps per second plus a small synchronization allowance/);
  assert.match(privacy, /does not independently verify each physical tap/);
  assert.match(privacy, /not an independently verified count of physical touches/);
  assert.doesNotMatch(privacy, /raw physical leaderboard tap totals|total physical taps used for leaderboards/);
});

test('store-facing Markdown uses the same truthful leaderboard score model', () => {
  const listing = readFileSync(new URL('../docs/play-store-listing.md', import.meta.url), 'utf8');
  const dataSafety = readFileSync(new URL('../docs/play-data-safety.md', import.meta.url), 'utf8');
  const policy = readFileSync(new URL('../docs/privacy-policy.md', import.meta.url), 'utf8');
  for (const copy of [listing, dataSafety, policy]) {
    assert.match(copy, /client-submitted cumulative tap total/i);
    assert.doesNotMatch(copy,
      /raw physical (?:leaderboard )?tap totals?|physical tap total|submits? physical tap totals?/i);
  }
  for (const copy of [dataSafety, policy]) {
    assert.match(copy, /25 taps per second plus a small synchronization\s+allowance/);
    assert.match(copy, /does not independently verify each physical tap/);
  }
});

test('web deletion follows bounded, advancing server pages instead of claiming 202 is complete', () => {
  const deletion = deletionPage(completeLegalEnv);
  assert.match(deletion, /data\.deleted===true/);
  assert.match(deletion, /removed\.status!==202\|\|data\.deletionPending!==true/);
  assert.match(deletion, /progress===prior/);
  assert.match(deletion, /setTimeout\(resolve,delay\)/);
  assert.match(deletion, /page<128/);
});

test('privacy and deletion copy disclose Play referral attribution and shop rewards', () => {
  const privacy = privacyPage(completeLegalEnv);
  const deletion = deletionPage(completeLegalEnv);
  assert.match(privacy, /app reads the referral code, referral-click time, install time, and installed app version supplied through Google Play Install Referrer/);
  assert.match(privacy, /Google Play Integrity token cryptographically bound to that exact referral claim/);
  assert.match(privacy, /grant the referrer one random unowned shop item/);
  assert.match(privacy, /platform-neutral/);
  assert.match(privacy, /iOS claim remains disabled/);
  assert.match(privacy, /keyed HMAC fingerprint of one-use install evidence remains/);
  assert.match(privacy, /does not retain the referral code or install timestamps/);
  assert.match(privacy, /lifetime reward ledger/);
  assert.match(deletion, /referral reward already earned by another player remains/);
  assert.match(deletion, /deleted referred account identifier (?:is|are) erased/);
  assert.match(deletion, /install-referral records/);
});

test('privacy and deletion precisely disclose pseudonymous anti-abuse throttles', () => {
  const privacy = privacyPage(completeLegalEnv);
  const deletion = deletionPage(completeLegalEnv);
  assert.match(privacy, /network source IP supplied by Cloudflare/);
  assert.match(privacy, /separate keyed HMAC fingerprints/);
  assert.match(privacy, /does not store the raw IP or raw referral code/);
  assert.match(privacy, /without globally limiting a public invite code/);
  assert.match(privacy, /more than 24 hours old/);
  assert.match(privacy, /less than 25 hours/);
  assert.match(deletion, /anti-abuse rate-limit fingerprints/);
  assert.match(deletion, /normally in less than 25 hours/);
});

test('privacy and deletion copy disclose friends, multiplayer timing, and rewards', () => {
  const privacy = privacyPage(completeLegalEnv);
  const deletion = deletionPage(completeLegalEnv);
  assert.match(privacy, /random public friend code/);
  assert.match(privacy, /server-controlled round timing/);
  assert.match(privacy, /client-submitted and server-recorded plausibility-limited tap totals/);
  assert.match(privacy, /not verified physical taps/);
  assert.match(privacy, /Quick Draw raw server-receipt reaction times/);
  assert.match(privacy, /bounded RTT telemetry and submission transport/);
  assert.match(privacy, /eligible five-Mentality winner rewards/);
  assert.match(privacy, /ten wins per winner and one result per unordered player pair/);
  assert.match(privacy, /completed win may award zero/);
  assert.match(privacy, /friendship can work across supported platforms/);
  assert.match(deletion, /friend code, friendships, PvP matches and round submissions/);
});

test('PvP terms disclose forfeits, no wager, participation, and reward gates', () => {
  const terms = termsPage('v1', completeLegalEnv);
  assert.match(terms, /There is no Mentality wager/);
  assert.match(terms, /eligible win grants five Mentality/);
  assert.match(terms, /ten rewarded wins per winner/);
  assert.match(terms, /one rewarded result per unordered player pair/);
  assert.match(terms, /Both players must have participated/);
  assert.match(terms, /one participant and one no-show produces a forfeit win/);
  assert.match(terms, /Removing a friend, blocking an opponent, or deleting an account/);
  assert.match(terms, /invitation that has not begun is cancelled/);
});
