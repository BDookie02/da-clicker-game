const expression = process.argv.slice(2).join(' ');
if (!expression) throw new Error('Usage: node scripts/android-cdp-eval.mjs <expression>');
const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
const page = pages.find((candidate) => candidate.type === 'page');
if (!page) throw new Error('No Android WebView page found on forwarded port 9222');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const id = 1;
ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
  expression, awaitPromise: true, returnByValue: true,
} }));
const response = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('CDP evaluation timed out')), 10000);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== id) return;
    clearTimeout(timeout); resolve(message);
  });
});
ws.close();
if (response.error || response.result?.exceptionDetails) {
  console.error(JSON.stringify(response, null, 2)); process.exit(1);
}
console.log(JSON.stringify(response.result?.result?.value ?? null));
