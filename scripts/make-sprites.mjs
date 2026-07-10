// Final character art compiler — renders every named opponent as a shaded
// 64px pixel-art bust, five anger stages each, into public/sprites/
// (<slot>_a0..4.png). The game auto-loads these over the procedural sprites;
// procedural stays for the endless char_gen_* pool. Zero dependencies.
// Run: node scripts/make-sprites.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ---- tiny PNG writer (RGBA with alpha) -------------------------------------
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
function pngFromRGBA(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 64px canvas on a 32-grid (2x pixels) ----------------------------------
const S = 64;
let buf;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const put = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const o = (y * S + x) * 4;
  buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
};
// rect on the 32-grid (doubled to 64)
const R = (x, y, w, h, color) => {
  const c = hex(color);
  for (let yy = y * 2; yy < (y + h) * 2; yy++)
    for (let xx = x * 2; xx < (x + w) * 2; xx++) put(xx, yy, c);
};
// shade a 32-grid region by factor (only where alpha > 0)
const shade = (x, y, w, h, f) => {
  for (let yy = y * 2; yy < (y + h) * 2; yy++)
    for (let xx = x * 2; xx < (x + w) * 2; xx++) {
      const o = (yy * S + xx) * 4;
      if (buf[o + 3] > 0) { buf[o] = Math.min(255, buf[o] * f); buf[o + 1] = Math.min(255, buf[o + 1] * f); buf[o + 2] = Math.min(255, buf[o + 2] * f); }
    }
};
const lerpHex = (a, b, t) => {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
};

// ---- the 40 named looks (mirror of src/scene.ts DRIVER_LOOKS) ---------------
const LOOKS = {
  char_og:         { skin: '#e8b48a', shirt: '#7a8a99', hair: '#4a2e1a', stubble: 1 },
  char_mentality:  { skin: '#f0d0b0', shirt: '#d8d8d8', hat: 'cap', hatColor: '#2e2e36' },
  char_blockhead:  { skin: '#7fae4e', shirt: '#5f8a3a', hair: '#3c5c22' },
  char_easyface:   { skin: '#f2d24a', shirt: '#4aa8e0' },
  char_merc:       { skin: '#c68a5a', shirt: '#8e3a2e', mask: 1, hatColor: '#2a2a2e' },
  char_metro:      { skin: '#c9a184', shirt: '#5a5a66', hat: 'beanie', hatColor: '#3d4148' },
  char_cowboy:     { skin: '#d8a878', shirt: '#6a4a9e', hat: 'cowboy', hatColor: '#4d2d66', bandana: 1 },
  char_demon:      { skin: '#8e2222', shirt: '#1c1c22', hat: 'horns', hatColor: '#3a0e0e' },
  char_sigma:      { skin: '#e0b890', shirt: '#16161c', hair: '#1a1a1a', shades: 1 },
  char_discipline: { skin: '#f4f4f0', shirt: '#e8e8e4', hat: 'halo', hatColor: '#ffe98a', glow: 1 },
  char_gymbro:     { skin: '#e0a878', shirt: '#d84a4a', hair: '#2a2018', hairStyle: 'spiky', stubble: 1 },
  char_npc:        { skin: '#c8c8c8', shirt: '#9a9a9a', hair: '#7a7a7a' },
  char_doomer:     { skin: '#c9b49a', shirt: '#2e3440', hat: 'beanie', hatColor: '#1a1e26', stubble: 1 },
  char_bloomer:    { skin: '#e8c098', shirt: '#7ac47a', hair: '#c9a227' },
  char_yapper:     { skin: '#e8b48a', shirt: '#e08ab0', hair: '#4a2e1a', hairStyle: 'long' },
  char_cryptouncle:{ skin: '#d8a878', shirt: '#c9a227', hair: '#666666', mustache: 1, shades: 1 },
  char_aurafarmer: { skin: '#b89ae0', shirt: '#8a3ab0', hair: '#5a2472', hairStyle: 'spiky', glow: 1 },
  char_granny:     { skin: '#e8c8b0', shirt: '#b8a8d8', hair: '#e0e0e0', hairStyle: 'afro' },
  char_mime:       { skin: '#f0f0f0', shirt: '#2a2a2e', hat: 'beanie', hatColor: '#1a1a1e' },
  char_kingpin:    { skin: '#c68a5a', shirt: '#e8862a', hat: 'helmet', hatColor: '#e8862a', beard: 1 },
  char_valet:      { skin: '#e0b890', shirt: '#2a2a2e', hat: 'cap', hatColor: '#c9a227', mustache: 1 },
  char_chef:       { skin: '#e8b48a', shirt: '#e8e0d0', hat: 'chef', hatColor: '#f0f0ec', mustache: 1 },
  char_detective:  { skin: '#c9a184', shirt: '#8a7a5c', hat: 'cowboy', hatColor: '#4a4234', stubble: 1 },
  char_surgeon:    { skin: '#d8b898', shirt: '#7ab8c8', mask: 1, hatColor: '#5a98a8' },
  char_lifeguard:  { skin: '#e0a068', shirt: '#e8482a', hair: '#e8d84a', hairStyle: 'long', shades: 1 },
  char_astronaut:  { skin: '#e8c8a8', shirt: '#d8d8e0', hat: 'helmet', hatColor: '#b8b8c8', visor: 1 },
  char_conductor:  { skin: '#d8b090', shirt: '#1c1c22', hair: '#e0e0e0', hairStyle: 'spiky' },
  char_beekeeper:  { skin: '#e0b890', shirt: '#e8c84a', hat: 'helmet', hatColor: '#f0e8c0', visor: 1 },
  char_librarian:  { skin: '#c9a184', shirt: '#6a4a2e', hair: '#4a3a2a', shades: 1 },
  char_mailman:    { skin: '#c68a5a', shirt: '#4a6ab0', hat: 'cap', hatColor: '#2e4472' },
  char_knight:     { skin: '#d8b898', shirt: '#8a8a9a', hat: 'helmet', hatColor: '#6a6a7a', visor: 1 },
  char_pharaoh:    { skin: '#c68a5a', shirt: '#2a6a8a', hat: 'crown', hatColor: '#c9a227' },
  char_viking:     { skin: '#e0b088', shirt: '#5a4a3a', hat: 'horns', hatColor: '#d8d0c0', beard: 1 },
  char_samurai:    { skin: '#d8b090', shirt: '#b03a3a', hair: '#1a1a1a', hairStyle: 'long', bandana: 1 },
  char_pirate:     { skin: '#c9a184', shirt: '#2a2a2e', hat: 'cowboy', hatColor: '#1a1a1e', eyepatch: 1, beard: 1 },
  char_wizard:     { skin: '#e0c8b0', shirt: '#4a2a8a', hat: 'wizard', hatColor: '#4a2a8a', beard: 1 },
  char_alien:      { skin: '#8ae0c0', shirt: '#4ae0c0', glow: 1 },
  char_robot:      { skin: '#9aa8b4', shirt: '#6a7a8a', visor: 1 },
  char_vampire:    { skin: '#e8e0e8', shirt: '#1c1016', hair: '#0a0a0a' },
  char_timetraveler:{ skin: '#d8b898', shirt: '#b87a2a', hair: '#e0e0e0', hairStyle: 'spiky', shades: 1 },
};

// ---- bust renderer (32-grid layout, same design language as runtime) --------
function drawBust(L, anger) {
  buf = Buffer.alloc(S * S * 4); // transparent
  const a = anger;
  const skin = lerpHex(L.skin, '#d82818', (a / 4) * 0.8);
  if (L.glow) { R(4, 0, 24, 18, lerpHex('#fff4b4', L.skin, 0.5)); shade(4, 0, 24, 18, 1); R(3, 15, 26, 17, lerpHex('#fff4b4', L.skin, 0.5)); }
  // outline
  R(5, 1, 22, 20, '#000000');
  R(2, 20, 28, 12, '#000000');
  // torso + collar
  R(3, 21, 26, 11, L.shirt);
  shade(3, 28, 26, 4, 0.8);
  R(3, 21, 26, 1, lerpHex(L.shirt, '#000000', 0.35));
  // neck + face
  R(12, 18, 8, 4, skin);
  R(6, 2, 20, 17, skin);
  shade(21, 2, 5, 17, 0.86);         // right-side face shading
  shade(6, 2, 3, 17, 1.07);          // left highlight
  shade(6, 17, 20, 2, 0.88);         // chin shadow
  // hair / hats
  if (L.hair && !L.hat) {
    const hs = L.hairStyle || 'flat';
    if (hs === 'flat')  { R(5, 1, 22, 4, L.hair); R(5, 1, 3, 9, L.hair); shade(5, 1, 22, 1, 1.25); }
    if (hs === 'spiky') { R(5, 2, 22, 3, L.hair); for (let x = 6; x < 26; x += 4) R(x, 0, 2, 3, L.hair); }
    if (hs === 'long')  { R(5, 1, 22, 4, L.hair); R(4, 1, 4, 17, L.hair); R(24, 1, 4, 17, L.hair); shade(5, 1, 22, 1, 1.25); }
    if (hs === 'afro')  { R(3, 0, 26, 6, L.hair); R(2, 2, 4, 7, L.hair); R(26, 2, 4, 7, L.hair); }
  }
  if (L.hat === 'cap')    { R(5, 0, 22, 5, L.hatColor); R(22, 4, 8, 2, L.hatColor); shade(5, 0, 22, 1, 1.2); }
  if (L.hat === 'beanie') { R(5, 0, 22, 6, L.hatColor); shade(5, 5, 22, 1, 0.8); }
  if (L.hat === 'cowboy') { R(9, 0, 14, 4, L.hatColor); R(3, 3, 26, 2, L.hatColor); shade(9, 0, 14, 1, 1.2); }
  if (L.hat === 'horns')  { R(4, 0, 3, 6, L.hatColor); R(25, 0, 3, 6, L.hatColor); }
  if (L.hat === 'halo')   { R(8, 0, 16, 1, L.hatColor); }
  if (L.hat === 'crown')  { R(6, 1, 20, 3, L.hatColor); for (let x = 7; x < 25, x < 25; x += 5) R(x, 0, 2, 2, L.hatColor); }
  if (L.hat === 'helmet') { R(4, 0, 24, 7, L.hatColor); R(4, 0, 2, 14, L.hatColor); R(26, 0, 2, 14, L.hatColor); shade(4, 0, 24, 1, 1.2); }
  if (L.hat === 'chef')   { R(7, 0, 18, 5, L.hatColor); R(5, 3, 22, 2, L.hatColor); }
  if (L.hat === 'wizard') { R(13, 0, 6, 2, L.hatColor); R(10, 2, 12, 2, L.hatColor); R(4, 4, 24, 2, L.hatColor); }
  // eyes
  if (L.visor) {
    R(6, 7, 20, 5, a >= 3 ? '#e04a2a' : '#4ae0c0');
    shade(6, 7, 20, 1, 1.3);
  } else if (L.shades) {
    R(6, 8, 20, 4, '#0a0a0a');
    if (a >= 3) { R(9, 9, 2, 2, '#c01010'); R(21, 9, 2, 2, '#c01010'); }
  } else {
    const eyeH = a >= 3 ? 2 : a >= 2 ? 3 : 4;
    if (L.eyepatch) {
      R(8, 7, 6, 5, '#111111'); R(6, 6, 20, 1, '#111111');
      R(18, 8, 5, eyeH, '#ffffff'); R(20, 9, 2, 2, a >= 3 ? '#c01010' : '#111111');
    } else {
      R(8, 8, 5, eyeH, '#ffffff'); R(19, 8, 5, eyeH, '#ffffff');
      R(10, 9, 2, Math.min(2, eyeH), a >= 3 ? '#c01010' : '#111111');
      R(21, 9, 2, Math.min(2, eyeH), a >= 3 ? '#c01010' : '#111111');
      put(21, 18, hex('#ffffff')); put(43, 18, hex('#ffffff')); // catchlights (64px coords)
    }
  }
  // brows: V with anger
  for (let i = 0; i < 6; i++) {
    const drop = Math.floor((i * a) / 4);
    R(7 + i, 5 + drop, 1, 2, '#111111');
    R(24 - i, 5 + drop, 1, 2, '#111111');
  }
  // facial hair under, mouth over
  if (L.beard)    { R(6, 13, 20, 6, L.hair || '#2a2018'); R(9, 18, 14, 3, L.hair || '#2a2018'); }
  if (L.mustache) { R(9, 12, 14, 2, L.hair || '#2a2018'); }
  if (L.mask || L.bandana) {
    R(6, 12, 20, 7, L.bandana ? '#8e3a2e' : (L.hatColor || '#22222a'));
    if (L.bandana) for (let x = 8; x < 24; x += 4) R(x, 14, 2, 1, '#6e2a20');
  } else if (a < 3) {
    R(13 - a, 15, 6 + a * 2, 1, '#111111');
  } else {
    R(8, 13, 16, 4, '#111111');
    R(9, 14, 14, 2, '#ffffff');
    for (let x = 11; x < 23; x += 3) R(x, 14, 1, 2, '#111111');
  }
  if (L.stubble) shade(6, 13, 20, 6, 0.82);
  if (a === 4) { R(7, 2, 3, 1, '#8e1010'); R(8, 3, 1, 1, '#8e1010'); R(6, 3, 1, 1, '#8e1010'); }
  return buf;
}

mkdirSync('public/sprites', { recursive: true });
let count = 0;
for (const [slot, look] of Object.entries(LOOKS)) {
  for (let a = 0; a <= 4; a++) {
    writeFileSync(`public/sprites/${slot}_a${a}.png`, pngFromRGBA(S, drawBust(look, a)));
    count++;
  }
}
console.log(`wrote ${count} sprites (${Object.keys(LOOKS).length} characters x 5 anger stages) to public/sprites/`);
