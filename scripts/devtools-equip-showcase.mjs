const port = Number(process.argv[2] || 9222);
const dangler = process.argv[3] || 'dangle_dice';
const horn = process.argv[4] || 'horn_air';
const dashboard = process.argv[5];
const dashboardSlots = dashboard
  ? [dashboard, null, null, null, null, null]
  : ['orn_napkin','orn_cowboy','orn_cone','orn_monk',null,null];
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
if (!pages[0]?.webSocketDebuggerUrl) throw new Error('No debuggable game WebView');

const expression = `(() => {
  const key = 'discipline-clicker-save-v1';
  const save = window.__game?.s || JSON.parse(localStorage.getItem(key) || '{}');
  save.ownedCosmetics = Array.from(new Set([...(save.ownedCosmetics || []),
    'orn_napkin','orn_cowboy','orn_cone','orn_monk','horn_sad','horn_air',
    'dangle_dice','dangle_beads','dangle_yinyang','dangle_fire',
    'dangle_censored','dangle_testing_coals','dangle_goop','roof_taxi']));
  save.dashboardSlots = ${JSON.stringify(dashboardSlots)};
  save.equippedCosmetics = {...(save.equippedCosmetics || {}),
    dangler: ${JSON.stringify(dangler)}, horn: ${JSON.stringify(horn)}, roof: 'roof_taxi'};
  save.lastSeen = Date.now();
  if (window.__game) window.__game.save();
  else localStorage.setItem(key, JSON.stringify(save));
  location.reload();
})()`;

const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('DevTools timeout')), 10000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true },
  })));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer); socket.close();
    if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
    else resolve();
  });
  socket.addEventListener('error', reject);
});
