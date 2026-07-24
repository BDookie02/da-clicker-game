import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distRoot = path.join(root, 'dist');
const androidWebRoot = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
const failures = [];

function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function treeDigest(directory, ignoredPaths = new Set()) {
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  const visit = (at, relative = '') => {
    const entries = fs.readdirSync(at, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(at, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not permitted in packaged web assets: ${childRelative}`);
      }
      if (entry.isDirectory()) {
        visit(child, childRelative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`unsupported asset entry: ${childRelative}`);
      if (ignoredPaths.has(childRelative)) continue;
      const content = fs.readFileSync(child);
      const relativeBytes = Buffer.from(childRelative, 'utf8');
      const header = Buffer.alloc(12);
      header.writeUInt32BE(relativeBytes.length, 0);
      header.writeBigUInt64BE(BigInt(content.length), 4);
      hash.update(header);
      hash.update(relativeBytes);
      hash.update(content);
      fileCount += 1;
    }
  };
  visit(directory);
  return { sha256: hash.digest('hex'), fileCount };
}

const capacitorBridgePlaceholders = new Set(['cordova.js', 'cordova_plugins.js']);

const testEnv = {
  ...parseEnv(path.join(root, '.env')),
  ...parseEnv(path.join(root, '.env.local')),
  ...parseEnv(path.join(root, '.env.test')),
  ...parseEnv(path.join(root, '.env.test.local')),
  ...process.env,
};
if (String(testEnv.VITE_VISUAL_AUDIT).toLowerCase() !== 'true')
  failures.push('VITE_VISUAL_AUDIT must be true for the Android test payload');
if (String(testEnv.VITE_ADMOB_TESTING).toLowerCase() !== 'true')
  failures.push('VITE_ADMOB_TESTING must be true for the Android test payload');

let distDigest;
let androidDigest;
try {
  if (!fs.existsSync(distRoot)) throw new Error('dist is missing; run npm run build:test');
  if (!fs.existsSync(androidWebRoot)) throw new Error('Android web assets are missing; run npx cap sync android');
  distDigest = treeDigest(distRoot);
  androidDigest = treeDigest(androidWebRoot);
  const androidDistDigest = treeDigest(androidWebRoot, capacitorBridgePlaceholders);
  for (const bridgeFile of capacitorBridgePlaceholders) {
    const bridgePath = path.join(androidWebRoot, bridgeFile);
    if (fs.existsSync(bridgePath) && fs.statSync(bridgePath).size !== 0)
      failures.push(`Capacitor bridge placeholder must remain empty: ${bridgeFile}`);
  }
  if (distDigest.sha256 !== androidDistDigest.sha256
      || distDigest.fileCount !== androidDistDigest.fileCount)
    failures.push('Android packaged web tree is not byte-for-byte identical to the latest test dist tree');
} catch (error) {
  failures.push(error.message);
}

if (fs.existsSync(androidWebRoot)) {
  const assetsDir = path.join(androidWebRoot, 'assets');
  const scripts = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js')).sort()
    : [];
  const source = scripts.map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8')).join('\n');
  const expectedTestRewardedId = 'ca-app-pub-3940256099942544/5224354917';
  const allowedTestIds = new Set([
    expectedTestRewardedId,
    'ca-app-pub-3940256099942544/1712485313',
  ]);
  if (!source.includes(expectedTestRewardedId))
    failures.push('Android test payload does not contain Google’s official Android rewarded-ad test unit');
  const embeddedAdMobIds = new Set(source.match(/ca-app-pub-\d+[~/]\d+/g) || []);
  for (const embeddedId of embeddedAdMobIds) {
    if (!allowedTestIds.has(embeddedId))
      failures.push(`Android test payload contains a non-test AdMob ID: ${embeddedId}`);
  }
  for (const handle of ['__game', '__scene', '__ui']) {
    if (!source.includes(handle))
      failures.push(`Android test payload is missing visual-audit handle ${handle}`);
  }

  const productionEnv = {
    ...parseEnv(path.join(root, '.env.production')),
    ...parseEnv(path.join(root, '.env.production.local')),
  };
  const productionRewardedId = productionEnv.VITE_ADMOB_ANDROID_REWARDED_ID || '';
  if (productionRewardedId && productionRewardedId !== expectedTestRewardedId && source.includes(productionRewardedId))
    failures.push('Android test payload unexpectedly contains the production rewarded-ad unit ID');

  const index = path.join(androidWebRoot, 'index.html');
  if (!fs.existsSync(index) || !fs.readFileSync(index, 'utf8').includes('DISCIPLINE.'))
    failures.push('Android test payload index is not the expected game entry point');
}

if (failures.length) {
  console.error(`Android test payload is unsafe:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

const report = {
  mode: 'test',
  visualAudit: true,
  admobTesting: true,
  rewardedAdUnitId: 'ca-app-pub-3940256099942544/5224354917',
  treeSha256: androidDigest.sha256,
  fileCount: androidDigest.fileCount,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(report));
else console.log(`Android test payload verified: ${report.fileCount} files, SHA-256 ${report.treeSha256}`);
