// Generates the app icons (public/icon-512.png, icon-192.png,
// apple-touch-icon.png) with zero dependencies: raw RGBA -> zlib -> PNG.
// Art: chunky pixel traffic light on the night-street background, red lamp
// lit, one white goop drip. Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the art, in unit coords, quantized to a 16px grid for chunky pixels ---
const inBox = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
function art(u, v) {
  const q = 16;
  const x = Math.floor(u * q) / q, y = Math.floor(v * q) / q;
  // night sky gradient + scanline flavor
  let base = v < 0.5 ? [18, 26, 58] : [30, 20, 54];
  if (Math.floor(v * 64) % 4 === 0) base = base.map(c => Math.max(0, c - 6));
  // road at the bottom
  if (y >= 12 / 16) base = [46, 46, 52];
  if (inBox(x, y, 0, 13 / 16, 1, 14 / 16) && Math.floor(u * 8) % 2 === 0) base = [216, 216, 200]; // stop line
  // pole
  if (inBox(x, y, 7 / 16, 5 / 16, 9 / 16, 13 / 16)) base = [42, 42, 52];
  // housing
  if (inBox(x, y, 5 / 16, 1 / 16, 11 / 16, 10 / 16)) base = [16, 16, 22];
  // lamps: red LIT, amber/green dim
  const lamp = (cy, on, rgb, dim) => {
    if (inBox(x, y, 6 / 16, cy, 10 / 16, cy + 2 / 16)) return on ? rgb : dim;
    return null;
  };
  base = lamp(2 / 16, true, [255, 48, 48], null) ?? base;
  base = lamp(5 / 16, false, null, [70, 54, 16]) ?? base;
  base = lamp(8 / 16, false, null, [18, 66, 26]) ?? base;
  // goop drip on the housing corner
  if (inBox(x, y, 9 / 16, 0 / 16, 12 / 16, 2 / 16)) base = [242, 240, 232];
  if (inBox(x, y, 10 / 16, 2 / 16, 11 / 16, 4 / 16)) base = [242, 240, 232];
  return base;
}

// splash: dark street backdrop with the traffic light centered small
function splashArt(u, v) {
  const inner = 0.30; // art occupies the middle band
  if (u > 0.5 - inner / 2 && u < 0.5 + inner / 2 && v > 0.5 - inner / 2 && v < 0.5 + inner / 2) {
    return art((u - (0.5 - inner / 2)) / inner, (v - (0.5 - inner / 2)) / inner);
  }
  let c = [10, 10, 18];
  if (Math.floor(v * 512) % 4 === 0) c = [8, 8, 15];
  return c;
}

mkdirSync('public', { recursive: true });
for (const [file, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  writeFileSync(`public/${file}`, png(size, art));
  console.log(`public/${file} (${size}x${size})`);
}

// sources for `npx @capacitor/assets generate` (native launcher icons + splash)
mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon-only.png', png(1024, art));
writeFileSync('assets/icon-foreground.png', png(1024, art));
writeFileSync('assets/icon-background.png', png(1024, () => [10, 10, 18]));
writeFileSync('assets/splash.png', png(2732, splashArt));
writeFileSync('assets/splash-dark.png', png(2732, splashArt));
console.log('assets/: icon-only, icon-foreground, icon-background (1024), splash, splash-dark (2732)');
