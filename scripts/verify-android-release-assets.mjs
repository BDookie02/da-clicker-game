import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const distRoot = path.join(root, 'dist');
const webRoot = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
const indexFile = path.join(webRoot, 'index.html');
const failures = [];
const GOOGLE_SAMPLE_ADMOB_PUBLISHER = '3940256099942544';

function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

function treeDigest(directory, ignoredPaths = new Set()) {
  const hash = crypto.createHash('sha256');
  const visit = (at, relative = '') => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(at, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else {
        if (ignoredPaths.has(childRelative)) continue;
        hash.update(childRelative);
        hash.update(fs.readFileSync(child));
      }
    }
  };
  visit(directory);
  return hash.digest('hex');
}

const capacitorBridgePlaceholders = new Set(['cordova.js', 'cordova_plugins.js']);

const env = {
  ...parseEnv(path.join(root, '.env.production')),
  ...parseEnv(path.join(root, '.env.production.local')),
  ...process.env,
};
const rewardedId = String(env.VITE_ADMOB_ANDROID_REWARDED_ID || '');
if (!/^ca-app-pub-\d+\/\d+$/.test(rewardedId))
  failures.push('Production rewarded-ad ID is missing or invalid');
if (rewardedId.startsWith(`ca-app-pub-${GOOGLE_SAMPLE_ADMOB_PUBLISHER}/`))
  failures.push('Production payload is configured with Google’s sample rewarded-ad ID');

if (!fs.existsSync(indexFile)) {
  failures.push('Capacitor Android web assets are missing; run cap sync android');
} else {
  const files = fs.readdirSync(path.join(webRoot, 'assets'))
    .filter((name) => name.endsWith('.js'));
  const source = files.map((name) =>
    fs.readFileSync(path.join(webRoot, 'assets', name), 'utf8')).join('\n');
  const index = fs.readFileSync(indexFile, 'utf8');

  for (const bridgeFile of capacitorBridgePlaceholders) {
    const bridgePath = path.join(webRoot, bridgeFile);
    if (fs.existsSync(bridgePath) && fs.statSync(bridgePath).size !== 0)
      failures.push(`Capacitor bridge placeholder must remain empty: ${bridgeFile}`);
  }
  if (!fs.existsSync(distRoot)
      || treeDigest(distRoot) !== treeDigest(webRoot, capacitorBridgePlaceholders))
    failures.push('Android packaged web assets are not byte-for-byte identical to the latest dist build');
  if (!rewardedId
      || !source.includes(rewardedId)
      || !source.includes('completed_ad'))
    failures.push('Android release payload does not contain the configured production rewarded-ad integration');
  if (!env.VITE_API_URL || !source.includes(env.VITE_API_URL.replace(/\/$/, '')))
    failures.push('Android release payload does not contain the configured production account API');
  if (!env.VITE_PLAY_GAMES_LEADERBOARD_ID || !source.includes(env.VITE_PLAY_GAMES_LEADERBOARD_ID))
    failures.push('Android release payload does not contain the configured Play Games leaderboard');
  if (!source.includes('/v1/auth/login') || !source.includes('/v1/save'))
    failures.push('Android release payload does not contain the production account client');
  if (!index.includes('DISCIPLINE.'))
    failures.push('Android release index is not the expected game entry point');
}

if (failures.length) {
  console.error(`Android release payload is unsafe:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Android release payload contains production account, ads, and leaderboard wiring.');
