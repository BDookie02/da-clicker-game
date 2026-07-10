// PS1-ifies the generated character busts in place: hard downscale, limited
// palette with dithering — so they read as 1997 console art, not modern
// pixel-art. Run: node scripts/ps1ify-sprites.mjs
import sharp from 'sharp';

const SLOTS = ['char_og', 'char_mentality', 'char_blockhead', 'char_demon', 'char_discipline'];

for (const slot of SLOTS) {
  const p = `public/sprites/${slot}.png`;
  const crushed = await sharp(p)
    .resize(56, 56, { fit: 'inside', kernel: 'nearest' })
    .png({ palette: true, colours: 24, dither: 0.8 })
    .toBuffer();
  await sharp(crushed).toFile(p.replace('.png', '.tmp.png'));
  const { renameSync } = await import('node:fs');
  renameSync(p.replace('.png', '.tmp.png'), p);
  console.log(`${slot}: crushed to 56px / 24 colours`);
}
console.log('PS1-IFY DONE');
