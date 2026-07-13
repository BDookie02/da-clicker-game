// FREE character art via Pollinations, post-processed to MATCH the Higgsfield
// heroes: chunky low-res, limited palette, hard black outline added in code.
//   node scripts/gen-pollinations.mjs              # all missing slots
//   node scripts/gen-pollinations.mjs char_merc    # only these
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const STYLE = 'flat pixel art bust, PS1 memory-card portrait, bold thick black outline, hard cel shading, limited 16-color palette, low resolution, blocky pixels, no anti-aliasing, head and shoulders, centered, facing viewer straight on, unbroken eye contact, original character: ';
const BG = '. solid flat pure magenta #ff00ff background, no gradient, no border';

const ROSTER = [
  ['char_easyface', 'cheerful perfectly-round bright-yellow smiley face like a difficulty-rating icon, simple dot eyes, small confident smile, blue collared shirt'],
  ['char_merc', 'burly team-shooter mercenary in a dark balaclava and rust-red team jacket, only intense eyes visible'],
  ['char_metro', 'tired metro commuter in a gray hoodie and dark beanie, heavy eyelids, thousand-yard stare'],
  ['char_cowboy', 'weathered gunslinger cowboy, wide purple-banded hat, red bandana over nose, narrowed eyes'],
  ['char_sigma', 'slick businessman in a black suit and narrow black sunglasses, jet-black slicked hair, zero expression'],
  ['char_gymbro', 'swole gym bro, red stringer tank, spiky black hair, stubble, veiny neck, competitive glare'],
  ['char_npc', 'eerily generic gray-toned man, bland symmetrical face, flat gray hair, polite empty smile'],
  ['char_doomer', 'gaunt young man in a black beanie and dark jacket, stubble, sunken tired eyes, resigned frown'],
  ['char_bloomer', 'bright-eyed optimist with golden hair, light tan, soft green shirt, warm genuine smile'],
  ['char_yapper', 'animated talker mid-sentence, long brown hair, pink shirt, mouth open, eyebrows raised'],
  ['char_cryptouncle', 'middle-aged hustler in gold-tinted aviators, gray mustache, mustard blazer, greasy grin'],
  ['char_aurafarmer', 'smug teen with violet spiky hair, faint glowing purple aura, self-satisfied smirk'],
  ['char_granny', 'sweet elderly lady with a white afro perm, lavender cardigan, kind but steady stare'],
  ['char_mime', 'classic mime, white face paint, black beanie, black-and-white striped shirt, one eyebrow raised'],
  ['char_kingpin', 'construction boss in an orange hard hat and vest, full dark beard, satisfied grin'],
  ['char_valet', 'sharp valet in a black uniform and gold-trimmed cap, thin mustache, professional smile'],
  ['char_chef', 'portly chef in a tall white toque, big black mustache, flushed cheeks, intense stare'],
  ['char_detective', 'noir detective in a worn brown fedora and trench coat, stubble, one eyebrow cocked'],
  ['char_surgeon', 'calm surgeon in teal scrubs, surgical mask and cap, precise unblinking eyes'],
  ['char_lifeguard', 'tanned lifeguard, long sun-bleached hair, red tank, whistle on lanyard, mirrored sunglasses'],
  ['char_astronaut', 'astronaut in a white-gray helmet with gold reflective visor'],
  ['char_conductor', 'elderly orchestra conductor, wild white spiky hair, black formal coat, fierce gaze'],
  ['char_beekeeper', 'beekeeper in a cream mesh-veiled hat, yellow jacket, calm smile'],
  ['char_librarian', 'stern librarian, brown bun hair, thin dark glasses, cardigan, lips pressed in a shush'],
  ['char_mailman', 'determined mail carrier in a blue cap and uniform, square jaw, resolute stare'],
  ['char_knight', 'medieval knight in a steel helm with raised visor, chainmail collar'],
  ['char_pharaoh', 'regal pharaoh with a gold-and-teal striped nemes headdress, kohl-lined eyes'],
  ['char_viking', 'wild viking with a horned steel helmet, huge braided red-brown beard, battle grin'],
  ['char_samurai', 'disciplined samurai, black topknot, red headband, lacquered red shoulder armor'],
  ['char_pirate', 'grizzled pirate in a black tricorn hat, eyepatch, dark beard, gold tooth grin'],
  ['char_wizard', 'ancient wizard in a deep purple pointed hat, long white beard'],
  ['char_alien', 'friendly teal-skinned alien, large glossy black eyes, small mouth, silver collar'],
  ['char_robot', 'boxy retro robot head, brushed steel plates, single glowing cyan visor strip, antenna'],
  ['char_vampire', 'pale aristocratic vampire, slicked black widow-peak hair, high dark collar, faint fangs'],
  ['char_timetraveler', 'windswept time traveler, white spiky hair, amber goggles pushed up, bronze jacket'],
];

const isMagenta = (r, g, b) => r > 110 && b > 80 && g < 135 && (r - g) > 35 && (b - g) > 5;

async function postProcess(slot, rawBuf) {
  // 1) chroma-key magenta bbox -> transparent
  const { data, info } = await sharp(rawBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  let minX = W, minY = H, maxX = 0, maxY = 0, f = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; if (isMagenta(data[o], data[o + 1], data[o + 2])) { f = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
  if (!f) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }
  const cw = maxX - minX + 1, ch = maxY - minY + 1, crop = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const so = ((minY + y) * W + (minX + x)) * 4, doo = (y * cw + x) * 4; const r = data[so], g = data[so + 1], b = data[so + 2]; crop[doo] = r; crop[doo + 1] = g; crop[doo + 2] = b; crop[doo + 3] = isMagenta(r, g, b) ? 0 : 255; }

  // 2) crush to chunky low-res + limited palette (flatten shading)
  const N = 46;
  const small = await sharp(crop, { raw: { width: cw, height: ch, channels: 4 } })
    .trim({ threshold: 24 })
    .resize(N, N, { fit: 'inside', kernel: 'lanczos3' })
    .png({ palette: true, colours: 16, dither: 0 })
    .toBuffer();

  // 3) add a HARD black outline around the silhouette (the Higgsfield signature)
  const { data: p, info: pi } = await sharp(small).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = pi.width, h = pi.height, out = Buffer.from(p);
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : p[(y * w + x) * 4 + 3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (p[o + 3] < 128) { // transparent pixel touching the body -> black outline
      if (A(x - 1, y) > 128 || A(x + 1, y) > 128 || A(x, y - 1) > 128 || A(x, y + 1) > 128 ||
          A(x - 1, y - 1) > 128 || A(x + 1, y - 1) > 128 || A(x - 1, y + 1) > 128 || A(x + 1, y + 1) > 128) {
        out[o] = 8; out[o + 1] = 8; out[o + 2] = 12; out[o + 3] = 255;
      }
    }
  }
  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).resize(56, 56, { fit: 'inside', kernel: 'nearest' }).png().toFile(`public/sprites/${slot}.png`);
}

const only = process.argv.slice(2);
const jobs = only.length ? ROSTER.filter(([s]) => only.includes(s)) : ROSTER;
let ok = 0, fail = 0;
for (const [slot, desc] of jobs) {
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(STYLE + desc + BG)}?width=512&height=512&nologo=true&seed=7`;
    let raw = null;
    for (let attempt = 1; attempt <= 3 && !raw; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        raw = Buffer.from(await res.arrayBuffer());
      } catch (e) { if (attempt === 3) throw e; }
    }
    writeFileSync(`.facegen/_pl_${slot}.png`, raw);
    await postProcess(slot, raw);
    ok++; console.log(`OK ${slot}`);
  } catch (e) { fail++; console.log(`FAIL ${slot}: ${String(e).slice(0, 120)}`); }
}
console.log(`DONE ${ok} ok ${fail} fail`);
