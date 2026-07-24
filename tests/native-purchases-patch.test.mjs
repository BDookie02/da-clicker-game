import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const android = fs.readFileSync(
  'node_modules/@capgo/native-purchases/android/src/main/java/ee/forgr/nativepurchases/NativePurchasesPlugin.java',
  'utf8',
);
const ios = fs.readFileSync(
  'node_modules/@capgo/native-purchases/ios/Sources/NativePurchasesPlugin/NativePurchasesPlugin.swift',
  'utf8',
);
const iosHelpers = fs.readFileSync(
  'node_modules/@capgo/native-purchases/ios/Sources/NativePurchasesPlugin/TransactionHelpers.swift',
  'utf8',
);

test('reviewed native purchase dependency is exact and patched deterministically', () => {
  assert.equal(manifest.dependencies['@capgo/native-purchases'], '8.6.4');
  assert.match(manifest.scripts.postinstall, /patch-native-purchases/);
  assert.match(manifest.scripts.prebuild, /patch-native-purchases/);
  assert.match(manifest.scripts['prebuild:test'], /patch-native-purchases/);
});

test('Android billing launch rejects instead of leaving checkout pending forever', () => {
  assert.match(android, /DISCIPLINE_PATCH_8_6_4/);
  assert.match(android, /billingResult2\.getResponseCode\(\) != BillingClient\.BillingResponseCode\.OK/);
  assert.match(android, /call\.reject\(/);
  assert.doesNotMatch(android, /Purchase details: " \+ purchase\.toString/);
  assert.doesNotMatch(android, /Purchase token: " \+ purchase\.getPurchaseToken/);
});

test('iOS updates remain unfinished until the verified app ledger is durable', () => {
  assert.match(ios, /DISCIPLINE_PATCH_8_6_4/);
  const updateCase = ios.slice(ios.indexOf('case .verified(let transaction):'),
    ios.indexOf('case .unverified(let transaction, let error):'));
  assert.doesNotMatch(updateCase, /transaction\.finish\(\)/);
  assert.match(iosHelpers, /DISCIPLINE_UNFINISHED_PATCH_8_6_4/);
  assert.match(iosHelpers, /Transaction\.unfinished/);
});
