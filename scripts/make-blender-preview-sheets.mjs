import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const previewDir = join(root, 'tools', 'blender', 'output', 'previews');
const reviewDir = join(root, 'tools', 'blender', 'output', 'review');
mkdirSync(reviewDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, 'public', 'assets', 'cosmetics-assembly.json'), 'utf8'));
const byId = new Map(manifest.items.map((item) => [item.id, item]));

const groups = {
  physical: ['orn_napkin','horn_sad','orn_cowboy','orn_cone','orn_monk','horn_air','roof_taxi'],
  danglers: ['dangle_dice','dangle_beads','dangle_yinyang','dangle_fire','dangle_censored','dangle_testing_coals','dangle_goop'],
  decals: ['decal_ment','decal_disc','decal_bottom','decal_aura','decal_engage'],
  goop_finishes: ['goop_gold','goop_slime','goop_pink','goop_blue','goop_oil'],
  environments: ['sky_sunset','sky_vapor','sky_storm','sky_noir','sky_toxic','sky_mint'],
};

async function makeSheet(name, ids, columns = 3) {
  const imageSize = 320;
  const labelHeight = 52;
  const tileHeight = imageSize + labelHeight;
  const rows = Math.ceil(ids.length / columns);
  const layers = [];
  for (const [index, id] of ids.entries()) {
    const item = byId.get(id);
    const x = (index % columns) * imageSize;
    const y = Math.floor(index / columns) * tileHeight;
    const preview = await sharp(join(previewDir, `${id}.png`)).resize(imageSize, imageSize, { fit: 'cover' }).png().toBuffer();
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageSize}" height="${labelHeight}"><rect width="100%" height="100%" fill="#11131b"/><text x="12" y="22" fill="#fff2cf" font-family="monospace" font-size="15">${item.name.replaceAll('&','&amp;').replaceAll('<','&lt;')}</text><text x="12" y="42" fill="#8f9ab5" font-family="monospace" font-size="12">${id}</text></svg>`;
    layers.push({ input: preview, left: x, top: y });
    layers.push({ input: Buffer.from(label), left: x, top: y + imageSize });
  }
  const target = join(reviewDir, `${name}.png`);
  await sharp({ create: { width: columns * imageSize, height: rows * tileHeight, channels: 4, background: '#090a0f' } })
    .composite(layers).png().toFile(target);
  return target;
}

const outputs = [];
for (const [name, ids] of Object.entries(groups)) outputs.push(await makeSheet(name, ids));
outputs.push(await makeSheet('all-30', manifest.items.map((item) => item.id), 5));
writeFileSync(join(reviewDir, 'review-index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), groups, outputs }, null, 2) + '\n');
console.log(outputs.join('\n'));
