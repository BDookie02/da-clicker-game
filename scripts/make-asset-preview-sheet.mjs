import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'docs', 'asset-previews', 'raw');
const output = join(root, 'docs', 'asset-previews', 'latest');
mkdirSync(output, { recursive: true });

const ids = [
  'dangle_beads', 'dangle_censored', 'dangle_dice', 'dangle_fire', 'dangle_goop',
  'dangle_testing_coals', 'dangle_yinyang', 'decal_aura', 'decal_bottom', 'decal_disc',
  'decal_engage', 'decal_ment', 'goop_blue', 'goop_gold', 'goop_oil', 'goop_pink',
  'goop_slime', 'horn_air', 'horn_sad', 'orn_cone', 'orn_cowboy', 'orn_monk',
  'orn_napkin', 'roof_taxi', 'sky_mint', 'sky_noir', 'sky_storm', 'sky_sunset',
  'sky_toxic', 'sky_vapor',
];

const tileW = 240;
const imageH = 184;
const labelH = 32;
const tileH = imageH + labelH;
const cols = 5;
const rows = Math.ceil(ids.length / cols);

const tiles = [];
for (const [assetIndex, id] of ids.entries()) {
  const sourcePath = join(source, `${id}.png`);
  const targetPath = join(output, `${id}.png`);
  copyFileSync(sourcePath, targetPath);
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="#12131b"/><text x="10" y="21" fill="#f7f0db" font-family="monospace" font-size="14">${id}</text></svg>`;
  const image = await sharp(sourcePath).resize(tileW, imageH, { fit: 'cover' }).png().toBuffer();
  const labelBuffer = await sharp(Buffer.from(label)).png().toBuffer();
  const left = (assetIndex % cols) * tileW;
  const top = Math.floor(assetIndex / cols) * tileH;
  tiles.push({ input: image, left, top });
  tiles.push({ input: labelBuffer, left, top: top + imageH });
}

await sharp({ create: { width: cols * tileW, height: rows * tileH, channels: 4, background: '#0b0c10' } })
  .composite(tiles)
  .png()
  .toFile(join(output, 'asset-contact-sheet.png'));

writeFileSync(join(output, 'asset-preview-index.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), source: 'docs/asset-previews/raw', total: ids.length,
  assets: ids.map((id) => ({ id, screenshot: `${id}.png` })),
}, null, 2) + '\n');

console.log(`Wrote ${ids.length} labeled asset previews to ${output}`);
