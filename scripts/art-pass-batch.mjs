// Higgsfield art pass, batch 1 (free-plan budget: 5 characters).
// Generates the remaining flagship busts, polls to completion, downloads,
// chroma-keys the flat magenta backdrop to transparency, trims, downsizes,
// and installs into public/sprites/<slot>.png (the game auto-loads them).
// Run: node scripts/art-pass-batch.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';

const TOKEN = JSON.parse(readFileSync('.higgsfield-token.json', 'utf8')).access_token;
const STYLE = '1997 PlayStation-era low-poly 3D rendered character portrait, triangulated low-polygon head, flat-shaded polygons, affine texture warping, dithered 15-bit color, jagged silhouette edges, retro console render, head and shoulders bust, facing viewer, unbroken eye contact with camera, original character: ';
const BG = '. solid flat pure magenta background';

const BATCH = [
  ['char_mentality', 'pale man in a black baseball cap and plain white shirt, wide unblinking eyes, jaw set, aura of pure focus'],
  ['char_blockhead', 'man with a perfectly cubic olive-green head, flat pixel features, mossy green flat-top hair, stoic blank expression'],
  ['char_demon', 'dark crimson demon head with short black horns, glowing red pupils, gritted jaw, black muscle-shirt'],
  ['char_discipline', 'radiant pure-white glowing figure, thin golden halo, serene closed-mouth expression, white robe collar'],
];
// already generated earlier:
const PREDONE = { char_og: 'C:/Users/jojos/AppData/Local/Temp/char_og_raw.png' };

async function mcp(method, params) {
  const res = await fetch('https://mcp.higgsfield.ai/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  // responses arrive as SSE lines: `data: {...}`
  const line = text.split('\n').find(l => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

const callText = (r) => (r.result?.content ?? []).map(c => c.text ?? '').join('\n');

async function generate(slot, desc) {
  const r = await mcp('tools/call', {
    name: 'generate_image',
    arguments: { params: { model: 'nano_banana_pro', prompt: STYLE + desc + BG, aspect_ratio: '1:1' } },
  });
  const txt = callText(r);
  const id = (txt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0];
  console.log(`${slot}: submitted job ${id ?? 'UNKNOWN — ' + txt.slice(0, 200)}`);
  return id;
}

async function waitForUrl(slot, jobId) {
  for (let i = 0; i < 30; i++) {
    const r = await mcp('tools/call', { name: 'job_status', arguments: { jobId, sync: true } });
    const txt = callText(r);
    const url = (txt.match(/https:[^\s"'\\]+\.png/) ?? [])[0];
    if (url) return url;
    if (/failed|error|nsfw/i.test(txt)) throw new Error(`${slot} failed: ${txt.slice(0, 200)}`);
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error(`${slot}: timed out waiting for job ${jobId}`);
}

async function keyAndInstall(slot, srcPath) {
  const img = sharp(srcPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // key out magenta-ish: strong red+blue, weak green
    if (r > 130 && b > 110 && g < 110 && Math.abs(r - b) < 110) data[i + 3] = 0;
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim()
    .resize(192, 192, { fit: 'inside', kernel: 'nearest' })
    .png()
    .toFile(`public/sprites/${slot}.png`);
  console.log(`${slot}: installed public/sprites/${slot}.png`);
}

for (const [slot, path] of Object.entries(PREDONE)) {
  if (existsSync(path)) await keyAndInstall(slot, path);
}
for (const [slot, desc] of BATCH) {
  try {
    const jobId = await generate(slot, desc);
    if (!jobId) continue;
    const url = await waitForUrl(slot, jobId);
    const raw = Buffer.from(await (await fetch(url)).arrayBuffer());
    const tmp = `public/sprites/_raw_${slot}.png`;
    writeFileSync(tmp, raw);
    await keyAndInstall(slot, tmp);
  } catch (e) {
    console.error(String(e));
  }
}
console.log('BATCH DONE');
