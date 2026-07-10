// OAuth broker for the Higgsfield art pass. Zero dependencies.
// Registers nothing (client pre-registered), does PKCE auth-code flow:
// opens the user's browser at the approval page, catches the redirect on
// 127.0.0.1:8976, exchanges the code, saves tokens to .higgsfield-token.json.
// The only human step is clicking Allow (and logging in if needed).
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CLIENT_ID = 'lxi3tUZQs7h0urUC';
const REDIRECT = 'http://127.0.0.1:8976/callback';
const AUTHZ = 'https://mcp.higgsfield.ai/oauth2/authorize';
const TOKEN = 'https://mcp.higgsfield.ai/oauth2/token';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const authUrl = `${AUTHZ}?response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&scope=${encodeURIComponent('openid email offline_access')}` +
  `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8976');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const fail = (msg) => {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2 style="font-family:monospace">${msg}</h2>`);
  };
  if (!code || gotState !== state) { fail('Auth failed - state mismatch. Re-run the script.'); return; }
  try {
    const r = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.access_token) { fail('Token exchange failed: ' + JSON.stringify(tok)); return; }
    tok.obtained_at = new Date().toISOString();
    writeFileSync('.higgsfield-token.json', JSON.stringify(tok, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1 style="font-family:monospace">✅ DISCIPLINE. art pass unlocked.</h1>' +
      '<p style="font-family:monospace">You can close this tab. Claude takes it from here.</p>');
    console.log('TOKEN SAVED');
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    fail('Exchange error: ' + e.message);
  }
});

server.listen(8976, '127.0.0.1', () => {
  console.log('listening on 8976');
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', authUrl], { detached: true, stdio: 'ignore' });
  }
  console.log('AUTH URL: ' + authUrl);
});

setTimeout(() => { console.error('timed out after 15 minutes'); process.exit(1); }, 15 * 60 * 1000);
