// FREE character art pass via Google Gemini "Nano Banana" (gemini-2.5-flash-image).
// Same model family as the Higgsfield heroes, but free (500 img/day, no card).
// Uses the exact proven exemplar prompt, chroma-keys the flat magenta backdrop
// to transparency, trims, crushes to a 56px PS1 sprite, installs to public/sprites.
//   node scripts/gen-gemini.mjs            # all missing characters
//   node scripts/gen-gemini.mjs char_merc char_sigma   # only these slots
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const KEYS = JSON.parse(readFileSync('.gemini-keys.json', 'utf8')).keys;
const MODEL = 'gemini-2.5-flash-image';
const STYLE = 'chunky 90s pixel-art bust, PS1 memory-card portrait style, hard black outline, limited palette, head and shoulders, facing viewer, unbroken eye contact with camera, original character: ';
const BG = '. solid flat pure magenta background';

// slot -> identity clause (original, meme-lineage-recognizable, legally distinct)
const ROSTER = [
  ['char_easyface', 'cheerful perfectly-round bright-yellow smiley face like a difficulty-rating icon, simple dot eyes, small confident smile, blue collared shirt'],
  ['char_merc', 'burly team-shooter mercenary in a dark balaclava and rust-red team jacket, only intense eyes visible, gruff military bearing'],
  ['char_metro', 'tired metro commuter in a gray hoodie and dark beanie, heavy eyelids, thousand-yard stare'],
  ['char_cowboy', 'steel-gray weathered gunslinger cowboy, wide purple-banded hat, red bandana over nose, narrowed determined eyes'],
  ['char_sigma', 'slick businessman in a black suit and narrow black sunglasses, jet-black slicked hair, zero expression, chiseled jawline'],
  ['char_gymbro', 'swole gym enthusiast, red stringer tank, spiky black hair, stubble, veiny neck, competitive glare'],
  ['char_npc', 'eerily generic gray-toned man, symmetrical bland face, flat gray hair, polite empty smile, NPC energy'],
  ['char_doomer', 'gaunt young man in a black beanie and dark jacket, stubble, sunken tired eyes, resigned frown'],
  ['char_bloomer', 'bright-eyed optimist with golden hair, light tan, soft green shirt, warm genuine smile'],
  ['char_yapper', 'animated talker mid-sentence, long brown hair, pink shirt, mouth open, eyebrows raised'],
  ['char_cryptouncle', 'middle-aged hustler in gold-tinted aviators, gray mustache, mustard blazer, desperate grin'],
  ['char_aurafarmer', 'purple-lit teen with violet spiky hair, faint glowing aura outline, self-satisfied smirk'],
  ['char_granny', 'sweet elderly lady with a white afro perm, lavender cardigan, kind smile, unsettlingly steady stare'],
  ['char_mime', 'classic mime, white face paint, black beanie, black-and-white striped shirt, one eyebrow raised, silent menace'],
  ['char_kingpin', 'construction boss in an orange hard hat and vest, full dark beard, satisfied grin'],
  ['char_valet', 'sharp valet in a black uniform and gold-trimmed cap, thin mustache, professional smile'],
  ['char_chef', 'portly chef in a tall white toque, big black mustache, flushed cheeks, intense culinary stare'],
  ['char_detective', 'noir detective in a worn brown fedora and trench coat, stubble, one eyebrow cocked'],
  ['char_surgeon', 'calm surgeon in teal scrubs, surgical mask and cap, precise unblinking eyes'],
  ['char_lifeguard', 'tanned lifeguard, long sun-bleached hair, red tank, whistle on lanyard, mirrored sunglasses'],
  ['char_astronaut', 'astronaut in a white-gray helmet, gold reflective visor showing a faint traffic light reflection'],
  ['char_conductor', 'elderly orchestra conductor, wild white spiky hair, black formal coat, raised chin, fierce artistic gaze'],
  ['char_beekeeper', 'beekeeper in a cream mesh-veiled hat, yellow jacket, calm smile, one bee on shoulder'],
  ['char_librarian', 'stern librarian, brown bun hair, thin dark glasses, cardigan, lips pressed in a shush'],
  ['char_mailman', 'determined mail carrier in a blue cap and uniform, square jaw, resolute stare'],
  ['char_knight', 'medieval knight in a steel helm with raised visor, determined eyes, chainmail collar'],
  ['char_pharaoh', 'regal pharaoh with a gold-and-teal striped nemes headdress, kohl-lined eyes, imperious calm'],
  ['char_viking', 'wild viking with a horned steel helmet, huge braided red-brown beard, battle grin'],
  ['char_samurai', 'disciplined samurai, black topknot, red headband, lacquered red shoulder armor, steely gaze'],
  ['char_pirate', 'grizzled pirate in a black tricorn hat, eyepatch, dark beard, gold tooth grin'],
  ['char_wizard', 'ancient wizard in a deep purple pointed hat, long white beard, twinkling knowing eyes'],
  ['char_alien', 'friendly teal-skinned alien, large glossy black eyes, small mouth, silver collar, faint glow'],
  ['char_robot', 'boxy retro robot head, brushed steel plates, single glowing cyan visor strip, antenna'],
  ['char_vampire', 'pale aristocratic vampire, slicked black widow-peak hair, high dark collar, faint fang smile'],
  ['char_timetraveler', 'windswept time traveler, white shock of spiky hair, amber goggles pushed up, bronze jacket, knowing smile'],
];

// ---- Gemini image call (tries each key; AIza -> query param, other -> Bearer) ----
async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  });
  let lastErr = '';
  for (const key of KEYS) {
    const headers = { 'Content-Type': 'application/json' };
    let full = url;
    if (key.startsWith('AIza')) full = `${url}?key=${key}`;
    else headers['Authorization'] = `Bearer ${key}`;
    let res;
    try { res = await fetch(full, { method: 'POST', headers, body }); }
    catch (e) { lastErr = String(e); continue; }
    const txt = await res.text();
    if (!res.ok) { lastErr = `HTTP ${res.status}: ${txt.slice(0, 200)}`; continue; }
    let j; try { j = JSON.parse(txt); } catch { lastErr = 'bad json'; continue; }
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData?.data);
    if (img) return Buffer.from(img.inlineData.data, 'base64');
    lastErr = 'no image in response: ' + txt.slice(0, 200);
  }
  throw new Error(lastErr);
}

const isMagenta = (r, g, b) => r > 120 && b > 90 && g < 120 && (r - g) > 50 && (b - g) > 20;

async function keyAndInstall(slot, rawBuf) {
  const { data, info } = await sharp(rawBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  let minX = W, minY = H, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (isMagenta(data[o], data[o + 1], data[o + 2])) { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (!found) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const crop = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const so = ((minY + y) * W + (minX + x)) * 4, doo = (y * cw + x) * 4;
    const r = data[so], g = data[so + 1], b = data[so + 2];
    crop[doo] = r; crop[doo + 1] = g; crop[doo + 2] = b;
    crop[doo + 3] = isMagenta(r, g, b) ? 0 : data[so + 3];
  }
  const out = await sharp(crop, { raw: { width: cw, height: ch, channels: 4 } })
    .trim({ threshold: 20 })
    .resize(56, 56, { fit: 'inside', kernel: 'nearest' })
    .png({ palette: true, colours: 28, dither: 0.7 })
    .toBuffer();
  await sharp(out).toFile(`public/sprites/${slot}.png`);
}

const only = process.argv.slice(2);
const jobs = only.length ? ROSTER.filter(([s]) => only.includes(s)) : ROSTER;
let ok = 0, fail = 0;
for (const [slot, desc] of jobs) {
  try {
    const raw = await callGemini(STYLE + desc + BG);
    writeFileSync(`.facegen/_raw_${slot}.png`, raw);
    await keyAndInstall(slot, raw);
    ok++; console.log(`OK ${slot} -> public/sprites/${slot}.png`);
  } catch (e) {
    fail++; console.log(`FAIL ${slot}: ${String(e).slice(0, 220)}`);
  }
}
console.log(`DONE: ${ok} ok, ${fail} failed`);
