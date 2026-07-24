import { defineConfig, type Plugin } from 'vite';
import legacy from '@vitejs/plugin-legacy';
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
  server: { host: true },
  plugins: [
    devlogSaver(),
    // Android 7's factory WebView is Chrome 51, predating ES modules. Vite's
    // target setting transpiles syntax but does not remove <script type=module>;
    // the official legacy plugin emits the required SystemJS/nomodule bundle.
    legacy({ targets: ['Chrome >= 51'] }),
  ],
});
