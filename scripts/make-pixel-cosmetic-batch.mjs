import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'public', 'assets', 'cosmetics-assembly.json'), 'utf8'));
const items = manifest.items;
const previewDir = join(root, 'tools', 'blender', 'output', 'previews');
const isolatedDir = join(root, 'tools', 'blender', 'output', 'isolated');
const outDir = join(root, 'tools', 'blender', 'output', 'pixelated');
const reviewDir = join(root, 'tools', 'blender', 'output', 'review');
await mkdir(outDir, { recursive: true });
await mkdir(reviewDir, { recursive: true });

const bayer = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
const processed = [];
for (const item of items) {
  const low = await sharp(join(isolatedDir, `${item.id}.png`))
    .resize(72, 72, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < low.info.height; y++) for (let x = 0; x < low.info.width; x++) {
    const o = (y * low.info.width + x) * 4;
    if (low.data[o + 3] === 0) continue;
    const d = (bayer[y & 3][x & 3] / 16 - 0.5) / 32;
    for (let c = 0; c < 3; c++) {
      const srgb = Math.pow(low.data[o + c] / 255, 0.4545);
      low.data[o + c] = Math.max(0, Math.min(255, Math.round(Math.round((srgb + d) * 31) / 31 * 255)));
    }
  }
  const filtered = await sharp(low.data, { raw: low.info }).resize(640, 640, { kernel: 'nearest' }).png().toBuffer();
  const output = join(outDir, `${item.id}.png`);
  await sharp(join(previewDir, `${item.id}.png`)).composite([{ input: filtered }]).png().toFile(output);
  processed.push({ item, output });
}

const cols = 5, tileW = 256, imageH = 256, labelH = 42, tileH = imageH + labelH;
const rows = Math.ceil(processed.length / cols);
const composites = [];
for (let i = 0; i < processed.length; i++) {
  const { item, output } = processed[i];
  const left = (i % cols) * tileW, top = Math.floor(i / cols) * tileH;
  const image = await sharp(output).resize(tileW, imageH, { kernel: 'nearest' }).png().toBuffer();
  const safe = item.name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const label = Buffer.from(`<svg width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="#101018"/><text x="8" y="18" fill="#f6ead0" font-size="13" font-family="monospace">${safe}</text><text x="8" y="34" fill="#77778b" font-size="11" font-family="monospace">${item.id}</text></svg>`);
  composites.push({ input: image, left, top }, { input: label, left, top: top + imageH });
}
const sheet = join(reviewDir, 'all-30-pixelated.png');
await sharp({ create: { width: cols * tileW, height: rows * tileH, channels: 4, background: '#08080d' } })
  .composite(composites).png().toFile(sheet);

const focusIds = ['orn_monk', 'horn_air', 'dangle_beads', 'dangle_fire'];
const focus = [];
for (let i = 0; i < focusIds.length; i++) {
  const entry = processed.find(({ item }) => item.id === focusIds[i]);
  const left = (i % 2) * 512, top = Math.floor(i / 2) * 554;
  const image = await sharp(entry.output).resize(512, 512, { kernel: 'nearest' }).png().toBuffer();
  const safe = entry.item.name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const label = Buffer.from(`<svg width="512" height="42"><rect width="100%" height="100%" fill="#101018"/><text x="12" y="27" fill="#f6ead0" font-size="20" font-family="monospace">${safe}</text></svg>`);
  focus.push({ input: image, left, top }, { input: label, left, top: top + 512 });
}
const focusSheet = join(reviewDir, 'corrected-four-pixelated.png');
await sharp({ create: { width: 1024, height: 1108, channels: 4, background: '#08080d' } })
  .composite(focus).png().toFile(focusSheet);
console.log(`PIXELATED ${processed.length}/${items.length}`);
console.log(sheet);
console.log(focusSheet);
