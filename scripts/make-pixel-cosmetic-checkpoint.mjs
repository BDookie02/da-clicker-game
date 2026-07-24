import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const id = process.argv[2] ?? 'dangle_dice';
const preview = join(root, 'tools', 'blender', 'output', 'previews', `${id}.png`);
const isolated = join(root, 'tools', 'blender', 'output', 'isolated', `${id}.png`);
const outDir = join(root, 'tools', 'blender', 'output', 'checkpoints');
const pixelated = join(outDir, `${id}-pixelated.png`);
const comparison = join(outDir, `${id}-comparison.png`);
await mkdir(outDir, { recursive: true });

// Half the live portrait renderer's approximate native width produces the
// approved 2x cosmetic pixels without modifying the background.
const nativeSize = 72;
const low = await sharp(isolated)
  .resize(nativeSize, nativeSize, { kernel: 'nearest' })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const bayer = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
];
const data = low.data;
for (let y = 0; y < low.info.height; y++) {
  for (let x = 0; x < low.info.width; x++) {
    const o = (y * low.info.width + x) * 4;
    if (data[o + 3] === 0) continue;
    const d = (bayer[y & 3][x & 3] / 16 - 0.5) / 32;
    for (let c = 0; c < 3; c++) {
      const srgb = Math.pow(data[o + c] / 255, 0.4545);
      data[o + c] = Math.max(0, Math.min(255, Math.round(Math.round((srgb + d) * 31) / 31 * 255)));
    }
  }
}

const asset = await sharp(data, { raw: low.info })
  .resize(640, 640, { kernel: 'nearest' })
  .png()
  .toBuffer();
await sharp(preview).composite([{ input: asset }]).png().toFile(pixelated);

const label = (text) => Buffer.from(`<svg width="640" height="54"><rect width="640" height="54" fill="#101018"/><text x="20" y="37" fill="#f6ead0" font-size="25" font-family="monospace">${text}</text></svg>`);
const before = await sharp(preview).extend({ top: 54, background: '#101018' }).composite([{ input: label('BEFORE — SMOOTH BLENDER'), top: 0, left: 0 }]).png().toBuffer();
const after = await sharp(pixelated).extend({ top: 54, background: '#101018' }).composite([{ input: label('AFTER — GAME PIXEL FILTER'), top: 0, left: 0 }]).png().toBuffer();
await sharp({ create: { width: 1280, height: 694, channels: 4, background: '#08080d' } })
  .composite([{ input: before, left: 0, top: 0 }, { input: after, left: 640, top: 0 }])
  .png()
  .toFile(comparison);

console.log(comparison);
