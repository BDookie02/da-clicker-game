import test from 'node:test';
import assert from 'node:assert/strict';
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
