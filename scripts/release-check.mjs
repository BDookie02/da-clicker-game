import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

const root = process.cwd();
const localOnly = process.argv.includes('--local');
// Match Vite's production precedence so the check validates the exact values
// that will be compiled into a release bundle, while keeping machine-specific
// production identifiers out of git via *.local.
const values = {
  ...parseEnv(path.join(root, '.env')),
  ...parseEnv(path.join(root, '.env.local')),
  ...parseEnv(path.join(root, '.env.production')),
  ...parseEnv(path.join(root, '.env.production.local')),
  ...process.env,
};
const gradle = parseEnv(path.join(root, 'android', 'private-release.properties'));
const keystore = parseEnv(path.join(root, 'android', 'keystore.properties'));
const localFailures = [];
const productionFailures = [];

async function requirePng(relativePath, width, height, label, maxBytes = Infinity) {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) {
    localFailures.push(`${relativePath}: missing ${label}`);
    return;
  }
  try {
    const metadata = await sharp(file).metadata();
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height)
      localFailures.push(`${relativePath}: ${label} must be PNG ${width}x${height}; found ${metadata.format || 'unknown'} ${metadata.width || '?'}x${metadata.height || '?'}`);
    if (fs.statSync(file).size > maxBytes)
      localFailures.push(`${relativePath}: ${label} exceeds ${Math.floor(maxBytes / 1024)} KiB`);
  } catch (error) {
    localFailures.push(`${relativePath}: unreadable ${label} (${error.message})`);
  }
}

await requirePng('public/icon-512.png', 512, 512, 'Play Store icon', 1024 * 1024);
await requirePng('store-assets/feature-graphic.png', 1024, 500, 'Play feature graphic');
if (!fs.existsSync(path.join(root, 'store-assets', 'feature-graphic.png'))
    && fs.existsSync(path.join(root, 'store-assets', 'feature-graphic-source.png'))) {
  localFailures.push('store-assets/feature-graphic-source.png is rejected outdated car art and must not be submitted');
}

const screenshotDir = path.join(root, 'store-assets', 'screenshots');
const screenshots = fs.existsSync(screenshotDir)
  ? fs.readdirSync(screenshotDir).filter((name) => name.toLowerCase().endsWith('.png')).sort()
  : [];
if (screenshots.length < 4) {
  localFailures.push(`store-assets/screenshots: need the planned 4 production screenshots; found ${screenshots.length}`);
} else {
  for (const name of screenshots) {
    const file = path.join(screenshotDir, name);
    try {
      const metadata = await sharp(file).metadata();
      if (metadata.width !== 1080 || metadata.height !== 1920)
        localFailures.push(`store-assets/screenshots/${name}: expected 1080x1920; found ${metadata.width || '?'}x${metadata.height || '?'}`);
    } catch (error) {
      localFailures.push(`store-assets/screenshots/${name}: unreadable screenshot (${error.message})`);
    }
  }
}

const workerSource = fs.readFileSync(path.join(root, 'server', 'worker.js'), 'utf8');
const legalSource = fs.readFileSync(path.join(root, 'server', 'legal-pages.js'), 'utf8');
if (!workerSource.includes("url.pathname === '/privacy'") || !legalSource.includes('privacyPage'))
  localFailures.push('public privacy-policy route is missing');
if (!workerSource.includes("url.pathname === '/account-deletion'") || !legalSource.includes('deletionPage'))
  localFailures.push('public account-deletion route is missing');
if (!workerSource.includes("req.method === 'DELETE' && url.pathname === '/v1/account'"))
  localFailures.push('authenticated account-deletion API is missing');
if (!workerSource.includes("url.pathname === '/v1/admob/reward'") || !workerSource.includes('crypto.subtle.verify'))
  localFailures.push('signed AdMob server-side verification endpoint is missing');

const androidConfig = `${fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8')}\n${fs.readFileSync(path.join(root, 'android', 'variables.gradle'), 'utf8')}`;
if (!/minSdkVersion\s*=\s*24\b/.test(androidConfig)) localFailures.push('Android minSdkVersion must remain 24 (Android 7)');
if (!/targetSdkVersion\s*=\s*36\b/.test(androidConfig)) localFailures.push('Android targetSdkVersion must be 36');

if (!localOnly) {
  const required = [
    ['VITE_API_URL', /^https:\/\//, 'deployed account API URL'],
    ['VITE_ADMOB_ANDROID_REWARDED_ID', /^ca-app-pub-\d+\/\d+$/, 'production rewarded-ad unit ID'],
    ['VITE_PLAY_GAMES_LEADERBOARD_ID', /^CgkI/, 'published Play Games leaderboard ID'],
  ];
  for (const [key, pattern, label] of required) {
    if (!pattern.test(values[key] || '')) productionFailures.push(`${key}: missing/invalid ${label}`);
  }
  if (String(values.VITE_ADMOB_TESTING).toLowerCase() !== 'false')
    productionFailures.push('VITE_ADMOB_TESTING must be false');
  if (!/^ca-app-pub-\d+~\d+$/.test(gradle.ADMOB_ANDROID_APP_ID || ''))
    productionFailures.push('android/private-release.properties: missing production ADMOB_ANDROID_APP_ID');
  if (!/^\d{6,}$/.test(gradle.PLAY_GAMES_APP_ID || '') || /^0+$/.test(gradle.PLAY_GAMES_APP_ID || ''))
    productionFailures.push('android/private-release.properties: missing numeric PLAY_GAMES_APP_ID');
  const signingFields = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'];
  if (signingFields.some((key) => !keystore[key] || /REPLACE/i.test(keystore[key]))) {
    productionFailures.push('android/keystore.properties: missing production upload-key configuration');
  } else if (!fs.existsSync(path.resolve(root, 'android', keystore.storeFile))) {
    productionFailures.push('android/keystore.properties: configured upload keystore file does not exist');
  }
  const wrangler = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  if (wrangler.includes('PASTE_ID_FROM_')) productionFailures.push('wrangler.toml: D1 database_id is still a placeholder');
}

const failures = [...localFailures, ...productionFailures];
if (failures.length) {
  console.error(`${localOnly ? 'Local launch assets/code are' : 'Release configuration is'} NOT ready:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(localOnly ? 'Local launch assets/code preflight passed.' : 'Release configuration preflight passed.');
