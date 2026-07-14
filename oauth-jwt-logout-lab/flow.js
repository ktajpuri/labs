// Driver CLI — you drive the OAuth2 + JWT flow with this.
//   node flow.js login            full authorize -> token exchange (PKCE), saves tokens
//   node flow.js call             GET the protected resource with the saved access token
//   node flow.js logout           POST /logout with saved tokens (does NOT delete the local
//                                  token file — that's deliberate, see README)
//   node flow.js logout --partial POST /logout with access_token only (refresh family survives)
//   node flow.js refresh          exchange the saved refresh_token for a new access token
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const AUTHZ_URL = process.env.AUTHZ_URL || 'http://localhost:4000';
const RS_URL = process.env.RS_URL || 'http://localhost:5050';
const REDIRECT_URI = 'http://localhost:5050/callback';
const CLIENT_ID = 'lab-client';

const TOKENS_DIR = path.join(__dirname, '.tokens');
const TOKENS_FILE = path.join(TOKENS_DIR, 'current.json');

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) {
    console.error('No saved tokens. Run `node flow.js login` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
}

function saveTokens(data) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

function printDecoded(label, token) {
  const decoded = jwt.decode(token, { complete: true });
  console.log(`\n${label}`);
  console.log('  header: ', JSON.stringify(decoded.header));
  console.log('  payload:', JSON.stringify(decoded.payload));
}

async function login() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  console.log('--- Step 1: /authorize ---');
  const authUrl = new URL(`${AUTHZ_URL}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const authResp = await fetch(authUrl);
  const authBody = await authResp.json();
  if (!authResp.ok) {
    console.error('authorize failed:', authBody);
    process.exit(1);
  }
  if (authBody.state !== state) {
    console.error('state mismatch! possible CSRF — aborting');
    process.exit(1);
  }
  console.log(`  code=${authBody.code}`);
  console.log(`  state round-tripped correctly: ${authBody.state === state}`);

  console.log('\n--- Step 2: /token (authorization_code + PKCE) ---');
  const tokenResp = await fetch(`${AUTHZ_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: authBody.code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    }),
  });
  const tokenBody = await tokenResp.json();
  if (!tokenResp.ok) {
    console.error('token exchange failed:', tokenBody);
    process.exit(1);
  }

  saveTokens({ access_token: tokenBody.access_token, refresh_token: tokenBody.refresh_token });
  printDecoded('Issued access_token:', tokenBody.access_token);
  console.log(`\nrefresh_token saved: ${tokenBody.refresh_token.slice(0, 12)}...`);
  console.log('\nLogin complete. Try: node flow.js call');
}

async function call() {
  const { access_token } = loadTokens();
  const resp = await fetch(`${RS_URL}/api/data`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const body = await resp.json();
  console.log(`GET /api/data -> ${resp.status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function logout() {
  const partial = process.argv.includes('--partial');
  const { access_token, refresh_token } = loadTokens();

  const payload = partial ? { access_token } : { access_token, refresh_token };

  const resp = await fetch(`${AUTHZ_URL}/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await resp.json();
  console.log(`POST /logout${partial ? ' --partial (refresh_token withheld)' : ''} -> ${resp.status}`);
  console.log(JSON.stringify(body, null, 2));
  console.log(
    '\nNote: .tokens/current.json was NOT deleted — the local client "forgot" nothing.\n' +
      'Run `node flow.js call` again to see whether the token the server issued still works.'
  );
}

async function refresh() {
  const { refresh_token } = loadTokens();
  const resp = await fetch(`${AUTHZ_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
  });
  const body = await resp.json();
  console.log(`POST /token (refresh_token) -> ${resp.status}`);
  console.log(JSON.stringify(body, null, 2));

  if (resp.ok) {
    const existing = loadTokens();
    saveTokens({ access_token: body.access_token, refresh_token: existing.refresh_token });
    printDecoded('New access_token:', body.access_token);
  }
}

const cmd = process.argv[2];
const handlers = { login, call, logout, refresh };
if (!handlers[cmd]) {
  console.error('Usage: node flow.js <login|call|logout|refresh> [--partial]');
  process.exit(1);
}
handlers[cmd]().catch((err) => {
  console.error(err);
  process.exit(1);
});
