// Composite all opponent tiles (devlog/gallery_*.png) into one labeled
// contact sheet so every character can be verified at a glance.
import { readdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';

const NAMES = { og:'The O.G.', mentality:'MENTALITY', blockhead:'Blockhead', easyface:'Easy Face',
  merc:'The Mercenary', metro:'Subway Stranger', cowboy:'Steel Cowboy', demon:'Demon Face',
  sigma:'The Sigma', discipline:'DISCIPLINE.', beachbum:'Beach Bum Barry', ribbit:'Sir Ribbit',
  coper:'The Coper', woodo:'Woodo Tuk-Tuk', gymbro:'Gym Bro', npc:'The NPC', doomer:'Doomer',
  bloomer:'Bloomer', yapper:'The Yapper', cryptouncle:'Crypto Uncle', aurafarmer:'Aura Farmer',
  granny:'Granny Torque', mime:'The Mime', kingpin:'Cone Kingpin', valet:'Valet Prime',
  chef:'Chef Redline', detective:'Det. Yellowlight', surgeon:'The Surgeon', lifeguard:'Off-Duty Lifeguard',
  astronaut:'Grounded Astronaut', conductor:'The Conductor', beekeeper:'Beekeeper', librarian:'The Librarian',
  mailman:'Final Delivery', knight:'Traffic Knight', pharaoh:'Lane Pharaoh', viking:'Roundabout Viking',
  samurai:'Signal Samurai', pirate:'Parking Pirate', wizard:'Gridlock Wizard', alien:'Visitor 51',
  robot:'Unit T-RAFFIC', vampire:'Count Idle', timetraveler:'The Chrononaut' };

const files = readdirSync('devlog').filter(f => f.startsWith('gallery_') && f.endsWith('.png')).sort();
const TILE = 200, LABEL = 22, COLS = 6;
const rows = Math.ceil(files.length / COLS);
const cellW = TILE, cellH = TILE + LABEL;
const W = COLS * cellW, H = rows * cellH;

const composites = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const id = f.replace(/^gallery_\d+_/, '').replace(/\.png$/, '');
  const name = NAMES[id] || id;
  const col = i % COLS, row = Math.floor(i / COLS);
  const x = col * cellW, y = row * cellH;
  const img = await sharp(`devlog/${f}`).resize(TILE, TILE, { kernel: 'nearest' }).toBuffer();
  composites.push({ input: img, left: x, top: y });
  const label = Buffer.from(
    `<svg width="${cellW}" height="${LABEL}"><rect width="100%" height="100%" fill="#0a0a12"/>` +
    `<text x="${cellW/2}" y="15" font-family="monospace" font-size="12" font-weight="bold" fill="#e8e8f0" text-anchor="middle">${(String(i).padStart(2,'0'))} ${name.replace(/&/g,'&amp;')}</text></svg>`);
  composites.push({ input: label, left: x, top: y + TILE });
}

await sharp({ create: { width: W, height: H, channels: 3, background: '#0a0a12' } })
  .composite(composites).png().toFile('devlog/CONTACT-SHEET.png');
console.log(`contact sheet: devlog/CONTACT-SHEET.png (${files.length} chars, ${W}x${H})`);
