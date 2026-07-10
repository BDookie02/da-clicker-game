// Higgsfield art pass, batch 1 (free-plan budget: 5 characters).
// Generates the remaining flagship busts, polls to completion, downloads,
// chroma-keys the flat magenta backdrop to transparency, trims, downsizes,
// and installs into public/sprites/<slot>.png (the game auto-loads them).
// Run: node scripts/art-pass-batch.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';

const TOKEN = JSON.parse(readFileSync('.higgsfield-token.json', 'utf8')).access_token;
const STYLE = '1997 PlayStation-era low-poly 3D rendered character portrait, triangulated low-polygon head, flat-shaded polygons, affine texture warping, dithered 15-bit color, jagged silhouette edges, retro console render, head and shoulders bust, facing viewer, unbroken eye contact with camera, original character: ';
const BG = '. solid flat pure magenta background';

// Remaining roster — every prompt pushes meme-lineage recognizability to the
// max (silhouette, color signature, props) while staying an original design.
const BATCH = [
  ['char_easyface', 'cheerful perfectly-round yellow face like a difficulty-rating icon, big friendly oval eyes, small confident smile, blue collared shirt'],
  ['char_merc', 'burly team-shooter mercenary in a dark balaclava and rust-red team jacket, only intense eyes visible, gruff military bearing'],
  ['char_metro', 'tired metro commuter in a gray hoodie and dark beanie, heavy eyelids, thousand-yard stare'],
  ['char_cowboy', 'steel-gray weathered gunslinger cowboy, wide purple-banded hat, red bandana over nose, narrowed determined eyes'],
  ['char_sigma', 'slick businessman in a black suit and narrow black sunglasses, jet-black slicked hair, zero expression, gigachad jawline'],
  ['char_gymbro', 'swole gym enthusiast, red stringer tank, spiky black hair, stubble, veiny neck, competitive glare'],
  ['char_npc', 'eerily generic gray-toned man, symmetrical bland face, flat gray hair, polite empty smile, NPC energy'],
  ['char_doomer', 'gaunt young man in a black beanie and dark jacket, stubble, sunken tired eyes, resigned frown'],
  ['char_bloomer', 'bright-eyed optimist with golden hair, light tan, soft green shirt, warm genuine smile'],
  ['char_yapper', 'animated talker mid-sentence, long brown hair, pink shirt, mouth open, eyebrows raised'],
  ['char_cryptouncle', 'middle-aged hustler in gold-tinted aviators, gray mustache, mustard blazer, desperate grin'],
  ['char_aurafarmer', 'purple-lit teen with violet spiky hair, faint glowing aura outline, self-satisfied smirk'],
  ['char_granny', 'sweet elderly lady with a white afro perm, lavender cardigan, kind smile, unsettlingly steady stare'],
  ['char_mime', 'classic mime, white face paint, black beanie, striped shirt, one eyebrow raised, silent menace'],
  ['char_kingpin', 'construction boss in an orange hard hat and vest, full dark beard, satisfied grin'],
  ['char_valet', 'sharp valet in a black uniform and gold-trimmed cap, thin mustache, professional smile'],
  ['char_chef', 'portly chef in a tall white toque, big mustache, flushed cheeks, intense culinary stare'],
  ['char_detective', 'noir detective in a worn brown fedora and trench coat, stubble, one eyebrow cocked'],
  ['char_surgeon', 'calm surgeon in teal scrubs, surgical mask and cap, precise unblinking eyes'],
  ['char_lifeguard', 'tanned lifeguard, long sun-bleached hair, red tank, whistle on lanyard, mirrored sunglasses'],
  ['char_astronaut', 'astronaut in a white-gray helmet, gold reflective visor showing a faint traffic light reflection'],
  ['char_conductor', 'elderly orchestra conductor, wild white spiky hair, black formal coat, raised chin, fierce artistic gaze'],
  ['char_beekeeper', 'beekeeper in a cream mesh-veiled hat, yellow jacket, calm smile, one bee on shoulder'],
  ['char_librarian', 'stern librarian, brown bun hair, thin dark glasses, cardigan, lips pressed in a shush'],
  ['char_mailman', 'determined mail carrier in a blue cap and uniform, square jaw, resolute stare'],
  ['char_knight', 'medieval knight in a steel helm with raised visor, determined eyes, chainmail collar'],
  ['char_pharaoh', 'regal pharaoh with a gold-and-teal striped headdress, kohl-lined eyes, imperious calm'],
  ['char_viking', 'wild viking with a horned steel helmet, huge braided red-brown beard, battle grin'],
  ['char_samurai', 'disciplined samurai, black topknot, red headband, lacquered red shoulder armor, steely gaze'],
  ['char_pirate', 'grizzled pirate in a black tricorn hat, eyepatch, dark beard, gold tooth grin'],
  ['char_wizard', 'ancient wizard in a deep purple pointed hat, long white beard, twinkling knowing eyes'],
  ['char_alien', 'friendly teal-skinned alien, large glossy black eyes, small mouth, silver collar, faint glow'],
  ['char_robot', 'boxy retro robot head, brushed steel plates, single glowing cyan visor strip, antenna'],
  ['char_vampire', 'pale aristocratic vampire, slicked black widow-peak hair, high dark collar, faint fang smile'],
  ['char_timetraveler', 'windswept time traveler, white shock of spiky hair, amber goggles pushed up, bronze jacket, knowing smile'],
];
// already generated earlier:
const PREDONE = {};

async function mcp(method, params) {
  const res = await fetch('https://mcp.higgsfield.ai/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  // responses arrive as SSE lines: `data: {...}`
  const line = text.split('\n').find(l => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

const callText = (r) => (r.result?.content ?? []).map(c => c.text ?? '').join('\n');

async function generate(slot, desc) {
  const r = await mcp('tools/call', {
    name: 'generate_image',
    arguments: { params: { model: 'nano_banana_pro', prompt: STYLE + desc + BG, aspect_ratio: '1:1' } },
  });
  const txt = callText(r);
  const id = (txt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0];
  console.log(`${slot}: submitted job ${id ?? 'UNKNOWN — ' + txt.slice(0, 200)}`);
  return id;
}

async function waitForUrl(slot, jobId) {
  for (let i = 0; i < 30; i++) {
    const r = await mcp('tools/call', { name: 'job_status', arguments: { jobId, sync: true } });
    const txt = callText(r);
    const url = (txt.match(/https:[^\s"'\\]+\.png/) ?? [])[0];
    if (url) return url;
    if (/failed|error|nsfw/i.test(txt)) throw new Error(`${slot} failed: ${txt.slice(0, 200)}`);
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error(`${slot}: timed out waiting for job ${jobId}`);
}

async function keyAndInstall(slot, srcPath) {
  const img = sharp(srcPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // key out magenta-ish: strong red+blue, weak green
    if (r > 130 && b > 110 && g < 110 && Math.abs(r - b) < 110) data[i + 3] = 0;
  }
  // key -> trim -> crush to PS1 fidelity (56px, 24-colour dithered palette)
  const keyed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim()
    .resize(56, 56, { fit: 'inside', kernel: 'nearest' })
    .png({ palette: true, colours: 24, dither: 0.8 })
    .toBuffer();
  await sharp(keyed).toFile(`public/sprites/${slot}.png`);
  console.log(`${slot}: installed public/sprites/${slot}.png (PS1-crushed)`);
}

for (const [slot, path] of Object.entries(PREDONE)) {
  if (existsSync(path)) await keyAndInstall(slot, path);
}
for (const [slot, desc] of BATCH) {
  try {
    const jobId = await generate(slot, desc);
    if (!jobId) continue;
    const url = await waitForUrl(slot, jobId);
    const raw = Buffer.from(await (await fetch(url)).arrayBuffer());
    const tmp = `public/sprites/_raw_${slot}.png`;
    writeFileSync(tmp, raw);
    await keyAndInstall(slot, tmp);
  } catch (e) {
    console.error(String(e));
  }
}
console.log('BATCH DONE');
