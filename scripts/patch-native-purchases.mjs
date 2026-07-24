import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageRoot = path.join(root, 'node_modules', '@capgo', 'native-purchases');
const manifestPath = path.join(packageRoot, 'package.json');
const supportedVersion = '8.6.4';

if (!fs.existsSync(manifestPath)) {
  throw new Error('@capgo/native-purchases is not installed; run npm ci first');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== supportedVersion) {
  throw new Error(`Refusing an unreviewed native-purchases patch: expected ${supportedVersion}, found ${manifest.version}`);
}

function replaceOnce(file, original, replacement, marker) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) return false;
  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one patch target in ${file}; found ${occurrences}`);
  }
  fs.writeFileSync(file, source.replace(original, replacement));
  return true;
}

const androidFile = path.join(packageRoot, 'android', 'src', 'main', 'java', 'ee', 'forgr',
  'nativepurchases', 'NativePurchasesPlugin.java');
const androidOriginal = `                        Log.i(NativePurchasesPlugin.TAG, "onProductDetailsResponse2" + billingResult2);
`;
const androidReplacement = `                        Log.i(NativePurchasesPlugin.TAG, "onProductDetailsResponse2 code=" + billingResult2.getResponseCode());
                        // DISCIPLINE_PATCH_8_6_4: the upstream implementation
                        // otherwise leaves the JavaScript purchase Promise
                        // pending forever when Play rejects launchBillingFlow.
                        if (billingResult2.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                            call.reject(
                                "Unable to launch billing flow: " + billingResult2.getResponseCode()
                                    + " - " + billingResult2.getDebugMessage()
                            );
                        }
`;

const iosFile = path.join(packageRoot, 'ios', 'Sources', 'NativePurchasesPlugin',
  'NativePurchasesPlugin.swift');
const iosHelpersFile = path.join(packageRoot, 'ios', 'Sources', 'NativePurchasesPlugin',
  'TransactionHelpers.swift');
const iosOriginal = `                    await transaction.finish()
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    await MainActor.run {
                        self?.notifyListeners("transactionUpdated", data: payload)
                    }
`;
const iosReplacement = `                    // DISCIPLINE_PATCH_8_6_4: persist and verify the update
                    // in JavaScript before explicitly finishing it. Upstream
                    // finishes first, which can destroy a consumable receipt
                    // if the process exits before the listener receives it.
                    await MainActor.run {
                        self?.notifyListeners("transactionUpdated", data: payload)
                    }
`;

const redactions = [
  [
    `        Log.d(TAG, "Purchase details: " + purchase.toString());
`,
    `        Log.d(TAG, "Purchase details received [REDACTED]");
`,
    'Purchase details received [REDACTED]',
  ],
  [
    `        Log.i(NativePurchasesPlugin.TAG, "handlePurchase" + purchase);
`,
    `        Log.i(NativePurchasesPlugin.TAG, "handlePurchase received");
`,
    '"handlePurchase received"',
  ],
  [
    `        Log.d(TAG, "Purchase token: " + purchase.getPurchaseToken());
`,
    `        Log.d(TAG, "Purchase token present: " + (purchase.getPurchaseToken() != null));
`,
    '"Purchase token present: "',
  ],
];

let changed = false;
changed = replaceOnce(androidFile, androidOriginal, androidReplacement, 'DISCIPLINE_PATCH_8_6_4') || changed;
changed = replaceOnce(iosFile, iosOriginal, iosReplacement, 'DISCIPLINE_PATCH_8_6_4') || changed;
changed = replaceOnce(
  iosHelpersFile,
  `            try await collectPurchases(from: Transaction.all, filter: appAccountTokenFilter, into: &allPurchases)
`,
  `            // DISCIPLINE_UNFINISHED_PATCH_8_6_4: consumable recovery must
            // return only transactions still awaiting verified app delivery,
            // never every historical transaction for the Apple ID.
            try await collectPurchases(from: Transaction.unfinished, filter: appAccountTokenFilter, into: &allPurchases)
`,
  'DISCIPLINE_UNFINISHED_PATCH_8_6_4',
) || changed;
for (const [original, replacement, marker] of redactions) {
  changed = replaceOnce(androidFile, original, replacement, marker) || changed;
}

console.log(changed
  ? `Applied reviewed native-purchases ${supportedVersion} safety patch.`
  : `Native-purchases ${supportedVersion} safety patch already applied.`);
