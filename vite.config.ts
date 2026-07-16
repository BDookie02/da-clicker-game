import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only devlog capture endpoint: the page POSTs PNG/WebM blobs to
// /__save?name=<file> and they land in devlog/ (screenshots + recordings
// of the game saved as development progresses).
function devlogSaver(): Plugin {
  return {
    name: 'devlog-saver',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x');
        const name = (url.searchParams.get('name') ?? 'capture.bin').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = join(process.cwd(), 'devlog');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), Buffer.concat(chunks));
          res.statusCode = 200;
          res.end('saved');
        });
      });
    },
  };
}

// base './' so the built app works inside a Capacitor webview or any static host
export default defineConfig({
  base: './',
  // Android 7 ships with a Chrome 51-era system WebView. Capacitor devices
  // normally update WebView through Google Play, but compiling to this floor
  // prevents a blank screen on fresh/offline API 24 devices too.
  build: { target: 'chrome51' },
  server: { host: true },
  plugins: [devlogSaver()],
});
