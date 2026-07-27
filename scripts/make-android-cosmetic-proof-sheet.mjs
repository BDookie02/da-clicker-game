import { resolve, join } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'devlog', 'market-proof', 'complete-2x');
const groups = [
  ['napkin', 'hula', 'cone', 'buddha'],
  ['dice', 'beads', 'yinyang', 'fire', 'censored', 'testing_coals', 'goop'],
  ['airhorn', 'violin', 'taxi'],
];
const titles = ['DASHBOARD — 2×, SURFACE ANCHORED', 'MIRROR — 2×, TOP ANCHORED', 'VEHICLE — 2×, MOUNTED'];
const tileW = 270;
const imageH = 450;
const labelH = 34;
const gap = 8;
const sectionH = imageH + labelH + 54;
const cols = 4;
const width = cols * tileW + (cols + 1) * gap;
const height = groups.reduce((sum, group) => sum + Math.ceil(group.length / cols) * (imageH + labelH + gap) + 54, 0) + gap;
const composites = [];
let top = gap;

for (let section = 0; section < groups.length; section++) {
  const title = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="46"><text x="12" y="31" fill="#ff9340" font-family="monospace" font-weight="bold" font-size="22">${titles[section]}</text></svg>`;
  composites.push({ input: Buffer.from(title), left: 0, top });
  top += 46;
  for (const [index, id] of groups[section].entries()) {
    const left = gap + (index % cols) * (tileW + gap);
    const rowTop = top + Math.floor(index / cols) * (imageH + labelH + gap);
    const image = await sharp(join(dir, `${id}.png`)).resize(tileW, imageH, { fit: 'cover' }).png().toBuffer();
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><rect width="100%" height="100%" fill="#181923"/><text x="10" y="23" fill="#f7f0db" font-family="monospace" font-size="16">${id.replaceAll('_', ' ').toUpperCase()}</text></svg>`;
    composites.push({ input: image, left, top: rowTop });
    composites.push({ input: Buffer.from(label), left, top: rowTop + imageH });
  }
  top += Math.ceil(groups[section].length / cols) * (imageH + labelH + gap) + gap;
}

await sharp({ create: { width, height, channels: 4, background: '#090a10' } })
  .composite(composites).png().toFile(join(dir, 'complete-android-proof.png'));
console.log(join(dir, 'complete-android-proof.png'));
