const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
if (!pages[0]?.webSocketDebuggerUrl) throw new Error('No debuggable game WebView');
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('DevTools timeout')), 10000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: `localStorage.getItem('discipline-clicker-save-v1')`, returnByValue: true },
  })));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer); socket.close();
    if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message)));
    else resolve(message.result?.result?.value ?? '');
  });
  socket.addEventListener('error', reject);
});
const save = JSON.parse(String(result || '{}'));
console.log(JSON.stringify({
  dashboardSlots: save.dashboardSlots,
  equippedCosmetics: save.equippedCosmetics,
  ownedCosmetics: save.ownedCosmetics,
}, null, 2));
