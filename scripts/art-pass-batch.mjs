// Higgsfield art pass, batch 1 (free-plan budget: 5 characters).
// Generates the remaining flagship busts, polls to completion, downloads,
// chroma-keys the flat magenta backdrop to transparency, trims, downsizes,
// and installs into public/sprites/<slot>.png (the game auto-loads them).
// Run: node scripts/art-pass-batch.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';

let TOKEN = JSON.parse(readFileSync('.higgsfield-token.json', 'utf8')).access_token;

// Silent refresh via the stored refresh_token (access tokens are short-lived).
async function refreshToken() {
  const tok = JSON.parse(readFileSync('.higgsfield-token.json', 'utf8'));
  const r = await fetch('https://mcp.higgsfield.ai/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: 'lxi3tUZQs7h0urUC' }),
  });
  const j = await r.json();
  if (r.ok && j.access_token) {
    if (!j.refresh_token) j.refresh_token = tok.refresh_token;
    j.obtained_at = new Date().toISOString();
    writeFileSync('.higgsfield-token.json', JSON.stringify(j, null, 2));
    TOKEN = j.access_token;
    return true;
  }
  console.error('token refresh failed:', JSON.stringify(j).slice(0, 200));
  return false;
}
// Exact proven exemplar prompt — the one that generated the O.G. hero the user
// approved. Keeps every new character consistent with the existing pixel-art busts.
const STYLE = 'chunky 90s pixel-art bust, PS1 memory-card portrait style, hard black outline, limited palette, head and shoulders, facing viewer, unbroken eye contact with camera, original character: ';
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

const isMagenta = (r, g, b) => r > 120 && b > 90 && g < 120 && (r - g) > 50 && (b - g) > 20;

async function keyAndInstall(slot, srcPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  // 1) find the magenta backdrop's bounding box, crop to it — drops any
  // console/CRT frame or letterbox the model draws outside the magenta card.
  let minX = W, minY = H, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (isMagenta(data[o], data[o + 1], data[o + 2])) {
      found = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!found) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const crop = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const so = ((minY + y) * W + (minX + x)) * 4, doo = (y * cw + x) * 4;
    const r = data[so], g = data[so + 1], b = data[so + 2];
    crop[doo] = r; crop[doo + 1] = g; crop[doo + 2] = b;
    crop[doo + 3] = isMagenta(r, g, b) ? 0 : data[so + 3]; // 2) key magenta -> transparent
  }
  // 3) trim remaining transparent margin -> crush to PS1 fidelity (56px)
  const keyed = await sharp(crop, { raw: { width: cw, height: ch, channels: 4 } })
    .trim({ threshold: 20 })
    .resize(56, 56, { fit: 'inside', kernel: 'nearest' })
    .png({ palette: true, colours: 28, dither: 0.7 })
    .toBuffer();
  await sharp(keyed).toFile(`public/sprites/${slot}.png`);
  console.log(`${slot}: installed public/sprites/${slot}.png (PS1-crushed)`);
}

for (const [slot, path] of Object.entries(PREDONE)) {
  if (existsSync(path)) await keyAndInstall(slot, path);
}
await refreshToken();
let done = 0;
for (const [slot, desc] of BATCH) {
  if (done > 0 && done % 8 === 0) await refreshToken(); // keep token warm across the batch
  done++;
  try {
    let jobId = await generate(slot, desc);
    if (!jobId) { await refreshToken(); jobId = await generate(slot, desc); } // retry once on expiry
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
