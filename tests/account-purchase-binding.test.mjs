import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const account = fs.readFileSync('src/account.ts', 'utf8');
const main = fs.readFileSync('src/main.ts', 'utf8');
const purchases = fs.readFileSync('src/purchases.ts', 'utf8');
const ui = fs.readFileSync('src/ui.ts', 'utf8');
const worker = fs.readFileSync('server/worker.js', 'utf8');

test('cloud uploads stay paused until the exact account completes save selection', () => {
  assert.match(account, /private cloudReadyAccountId = ''/);
  assert.match(account, /this\.cloudReadyAccountId !== expectedAccountId/);
  assert.match(account, /const syncAccountId = this\.accountId/);
  assert.match(account, /this\.accountId !== syncAccountId \|\| this\.token !== syncToken/);
  assert.match(main, /account\?\.signedIn && account\.cloudReady/);
});

test('native checkout and recovery require a deterministic matching account token', () => {
  assert.match(ui, /this\.purchases\.platform === 'native'/);
  assert.match(ui, /Log in before opening Google Play checkout/);
  assert.match(purchases, /if \(!accountId\) throw new Error\('login_required'\)/);
  assert.match(purchases, /receipt\.appAccountToken !== appAccountToken/);
  assert.match(account, /receipt\.appAccountToken !== await accountUuid\(this\.accountId\)/);
  assert.match(worker, /purchase\.obfuscatedExternalAccountId !== expectedAccountToken/);
  assert.match(worker, /transaction\.appAccountToken !== await accountToken\(account\.id\)/);
  assert.doesNotMatch(worker, /purchase\.obfuscatedExternalAccountId\s*&&/);
});

test('unfinished purchases stay isolated on shared devices', () => {
  assert.match(purchases, /clearPendingPurchasesForAccount/);
  assert.match(purchases, /filter\(receipt => receipt\.appAccountToken !== token\)/);
  assert.match(account, /receipt\.appAccountToken !== expectedAccountToken\) continue/);
});

test('reward intent is durable before AdMob opens and is removed on definite failure', () => {
  const prequeue = ui.indexOf('queueAdReward(verification, fallbackSeconds, bonusRespect)');
  const show = ui.indexOf('await this.ads.show(fallbackSeconds, verification)');
  assert.ok(prequeue >= 0 && show > prequeue);
  assert.match(ui, /if \(!result\.rewarded\) \{\s*this\.account!\.clearPendingAdReward/);
});
