import { readFileSync } from 'node:fs';
const TOKEN = JSON.parse(readFileSync('.higgsfield-token.json','utf8')).access_token;
async function bal() {
  const r = await fetch('https://mcp.higgsfield.ai/mcp', { method:'POST',
    headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'balance',arguments:{}}}) });
  const t = await r.text();
  const m = t.match(/Credits:\s*(\d+)/);
  return m ? parseInt(m[1]) : 0;
}
for (let i=0;i<80;i++){ // ~20 min
  const c = await bal();
  if (c > 0) { console.log('CREDITS_ARRIVED', c); process.exit(0); }
  await new Promise(r=>setTimeout(r,15000));
}
console.log('TIMEOUT no credits');
