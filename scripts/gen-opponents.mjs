// Generate 4 original meme-inspired opponent faces via Higgsfield, chroma-key
// the magenta backdrop, PS1-crush, and install into public/sprites/.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const TOKEN = JSON.parse(readFileSync('.higgsfield-token.json', 'utf8')).access_token;
const STYLE = '1997 PlayStation-era low-poly rendered character head-and-shoulders bust portrait, flat-shaded polygons, dithered retro console look, facing viewer, unbroken eye contact with camera, ORIGINAL character (not a copyrighted character): ';
const BG = '. solid flat pure magenta background, no text';

// original designs that EVOKE the memes without copying them
const CHARS = [
  ['char_sunsal', 'a sunburned bright-red shirtless beach bum man, gold chain, sunglasses pushed up on greasy hair, wild manic grin, Florida energy'],
  ['char_frog', 'a smug cartoon green frog-man with big half-lidded droopy eyes and a wide flat calm smile, plain gray hoodie, self-satisfied expression'],
  ['char_coper', 'a bald pale sad man, single glistening tear on one cheek, downturned trembling mouth, pink-rimmed watery eyes, plain blue shirt'],
  ['char_woodo', 'a living wooden baseball-bat log creature with a simple carved angry face, two tiny stick arms, brown carved wood texture, wide eyes'],
];

async function mcp(method, params) {
  const res = await fetch('https://mcp.higgsfield.ai/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() + Math.floor(performance.now()), method, params }),
  });
  const txt = await res.text();
  const line = txt.split('\n').find(l => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : txt);
}
const text = (r) => (r.result?.content ?? []).map(c => c.text ?? '').join('\n');
const uuid = (s) => (s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0];

for (const [slot, desc] of CHARS) {
  try {
    const g = await mcp('tools/call', { name: 'generate_image', arguments: { params: { model: 'nano_banana_pro', prompt: STYLE + desc + BG, aspect_ratio: '1:1' } } });
    const id = uuid(text(g));
    if (!id) { console.log(slot, 'no job:', text(g).slice(0, 120)); continue; }
    let url = null;
    for (let i = 0; i < 30 && !url; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const s = await mcp('tools/call', { name: 'job_status', arguments: { jobId: id, sync: true } });
      url = (text(s).match(/https:[^\s"'\\]+\.png/) ?? [])[0];
    }
    if (!url) { console.log(slot, 'timeout'); continue; }
    const raw = Buffer.from(await (await fetch(url)).arrayBuffer());
    const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      if (r > 130 && b > 110 && gg < 110 && Math.abs(r - b) < 110) data[i + 3] = 0;
    }
    const keyed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .trim().resize(56, 56, { fit: 'inside', kernel: 'nearest' })
      .png({ palette: true, colours: 24, dither: 0.8 }).toBuffer();
    await sharp(keyed).toFile(`public/sprites/${slot}.png`);
    console.log(slot, 'DONE');
  } catch (e) { console.log(slot, 'ERR', String(e).slice(0, 120)); }
}
console.log('BATCH COMPLETE');
