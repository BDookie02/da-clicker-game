import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const distRoot = path.join(root, 'dist');
const androidWebRoot = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
const failures = [];
const rewardedId = 'ca-app-pub-3940256099942544/5224354917';
const interstitialId = 'ca-app-pub-3940256099942544/1033173712';
const allowedGoogleDemoIds = new Set([
  rewardedId,
  interstitialId,
  'ca-app-pub-3940256099942544/1712485313',
  'ca-app-pub-3940256099942544/4411468910',
]);
const capacitorBridgePlaceholders = new Set(['cordova.js', 'cordova_plugins.js']);

function treeDigest(directory, ignoredPaths = new Set()) {
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  const visit = (at, relative = '') => {
    const entries = fs.readdirSync(at, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(at, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`symbolic links are not permitted in packaged web assets: ${childRelative}`);
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

if (String(process.env.VITE_ADMOB_TESTING).toLowerCase() !== 'true')
  failures.push('VITE_ADMOB_TESTING must be true for the closed-Alpha payload');
if (String(process.env.VITE_VISUAL_AUDIT).toLowerCase() !== 'false')
  failures.push('VITE_VISUAL_AUDIT must be false for the closed-Alpha payload');
if (!/^https:\/\//.test(process.env.VITE_API_URL || ''))
  failures.push('the real HTTPS VITE_API_URL is required for the closed-Alpha payload');
if (!/^CgkI/.test(process.env.VITE_PLAY_GAMES_LEADERBOARD_ID || ''))
  failures.push('the real Play Games leaderboard ID is required for the closed-Alpha payload');

let androidDigest;
try {
  if (!fs.existsSync(distRoot))
    throw new Error('dist is missing; run the closed-Alpha web build first');
  if (!fs.existsSync(androidWebRoot))
    throw new Error('Android web assets are missing; run npx cap sync android');
  const distDigest = treeDigest(distRoot);
  androidDigest = treeDigest(androidWebRoot);
  const packagedDistDigest = treeDigest(androidWebRoot, capacitorBridgePlaceholders);
  for (const bridgeFile of capacitorBridgePlaceholders) {
    const bridgePath = path.join(androidWebRoot, bridgeFile);
    if (fs.existsSync(bridgePath) && fs.statSync(bridgePath).size !== 0)
      failures.push(`Capacitor bridge placeholder must remain empty: ${bridgeFile}`);
  }
  if (distDigest.sha256 !== packagedDistDigest.sha256
      || distDigest.fileCount !== packagedDistDigest.fileCount)
    failures.push('Android packaged web tree is not byte-for-byte identical to the latest closed-Alpha dist tree');
} catch (error) {
  failures.push(error.message);
}

if (fs.existsSync(androidWebRoot)) {
  const assetsDir = path.join(androidWebRoot, 'assets');
  const scripts = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js')).sort()
    : [];
  const source = scripts.map((name) => fs.readFileSync(path.join(assetsDir, name), 'utf8')).join('\n');
  if (!source.includes(rewardedId))
    failures.push('closed-Alpha payload does not contain Google’s official Android rewarded demo unit');
  if (!source.includes(interstitialId))
    failures.push('closed-Alpha payload does not contain Google’s official Android interstitial demo unit');
  const embeddedAdMobIds = new Set(source.match(/ca-app-pub-\d+[~/]\d+/g) || []);
  for (const embeddedId of embeddedAdMobIds) {
    if (!allowedGoogleDemoIds.has(embeddedId))
      failures.push(`closed-Alpha payload contains a non-demo AdMob ID: ${embeddedId}`);
  }
  for (const handle of ['__game', '__scene', '__ui', '__tutorial', '__interstitial']) {
    if (source.includes(handle))
      failures.push(`closed-Alpha payload exposes forbidden visual/dev handle ${handle}`);
  }

  const apiUrl = process.env.VITE_API_URL.replace(/\/$/, '');
  if (!source.includes(apiUrl))
    failures.push('closed-Alpha payload does not contain the configured real account API');
  if (!source.includes(process.env.VITE_PLAY_GAMES_LEADERBOARD_ID))
    failures.push('closed-Alpha payload does not contain the configured real Play Games leaderboard');
  if (!source.includes('/v1/auth/') || !source.includes('/v1/save'))
    failures.push('closed-Alpha payload does not contain the production account client');
  if (!source.includes('/v1/admob/reward/status'))
    failures.push('closed-Alpha payload does not contain rewarded-ad server verification');

  const index = path.join(androidWebRoot, 'index.html');
  if (!fs.existsSync(index) || !fs.readFileSync(index, 'utf8').includes('DISCIPLINE.'))
    failures.push('closed-Alpha payload index is not the expected game entry point');
}

if (failures.length) {
  console.error(`Android closed-Alpha payload is unsafe:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

const report = {
  mode: 'closed-alpha',
  visualAudit: false,
  admobTesting: true,
  rewardedAdUnitId: rewardedId,
  interstitialAdUnitId: interstitialId,
  apiUrl: process.env.VITE_API_URL.replace(/\/$/, ''),
  playGamesLeaderboardId: process.env.VITE_PLAY_GAMES_LEADERBOARD_ID,
  treeSha256: androidDigest.sha256,
  fileCount: androidDigest.fileCount,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(report));
else {
  console.log(
    `Android closed-Alpha payload verified: ${report.fileCount} files, SHA-256 ${report.treeSha256}`,
  );
}
