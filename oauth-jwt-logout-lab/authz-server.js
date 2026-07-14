// OAuth2 authorization server (mock IdP). In-memory state only — restart to reset.
const crypto = require('crypto');
const express = require('express');

const PORT = process.env.AUTHZ_PORT || 4000;
const ISSUER = `http://localhost:${PORT}`;
const ALLOWED_REDIRECT_URI = 'http://localhost:5050/callback';
const ACCESS_TTL = Number(process.env.ACCESS_TTL || 900); // seconds

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const jwt = require('jsonwebtoken');

// codes: code -> { codeChallenge, redirectUri, clientId, used }
const codes = new Map();
// denylist: Set of revoked access-token jti
const denylist = new Set();
// refreshFamilies: refreshToken -> { sub, revoked }
const refreshFamilies = new Map();

const app = express();
app.use(express.json());

function log(line) {
  console.log(`[authz ${new Date().toISOString()}] ${line}`);
}

app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  if (response_type !== 'code') {
    log(`REJECT /authorize response_type=${response_type}`);
    return res.status(400).json({ error: 'unsupported_response_type' });
  }
  if (redirect_uri !== ALLOWED_REDIRECT_URI) {
    log(`REJECT /authorize redirect_uri="${redirect_uri}" not in allow-list`);
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }
  if (code_challenge_method !== 'S256' || !code_challenge) {
    log(`REJECT /authorize missing/unsupported PKCE method="${code_challenge_method}"`);
    return res.status(400).json({ error: 'invalid_request', detail: 'PKCE S256 required' });
  }

  const code = crypto.randomUUID();
  codes.set(code, { codeChallenge: code_challenge, redirectUri: redirect_uri, clientId: client_id, used: false });
  log(`ISSUE code=${code} client_id=${client_id} redirect_uri=${redirect_uri}`);
  res.json({ code, state });
});

app.post('/token', (req, res) => {
  const { grant_type } = req.body;

  if (grant_type === 'authorization_code') {
    const { code, code_verifier, redirect_uri } = req.body;
    const entry = codes.get(code);

    if (!entry) {
      log(`REJECT /token unknown or already-used code=${code}`);
      return res.status(400).json({ error: 'invalid_grant', detail: 'unknown code' });
    }
    if (entry.used) {
      log(`REJECT /token code=${code} already used`);
      return res.status(400).json({ error: 'invalid_grant', detail: 'code already used' });
    }
    if (entry.redirectUri !== redirect_uri) {
      log(`REJECT /token redirect_uri mismatch for code=${code}`);
      return res.status(400).json({ error: 'invalid_grant', detail: 'redirect_uri mismatch' });
    }
    const computedChallenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (computedChallenge !== entry.codeChallenge) {
      log(`REJECT /token PKCE verification failed for code=${code}`);
      return res.status(400).json({ error: 'invalid_grant', detail: 'PKCE verification failed' });
    }

    entry.used = true;
    codes.delete(code);

    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = jwt.sign(
      { sub: 'user-123', aud: 'api://resource', iss: ISSUER, jti, iat: now, exp: now + ACCESS_TTL },
      privateKey,
      { algorithm: 'RS256' }
    );

    const refreshToken = crypto.randomBytes(32).toString('base64url');
    refreshFamilies.set(refreshToken, { sub: 'user-123', revoked: false });

    log(`ISSUE tokens sub=user-123 jti=${jti} exp=${now + ACCESS_TTL} (ttl=${ACCESS_TTL}s) refresh=${refreshToken.slice(0, 8)}...`);
    return res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
    });
  }

  if (grant_type === 'refresh_token') {
    const { refresh_token } = req.body;
    const family = refreshFamilies.get(refresh_token);

    if (!family) {
      log(`REJECT /token refresh_token unknown`);
      return res.status(401).json({ error: 'invalid_grant', detail: 'unknown refresh token' });
    }
    if (family.revoked) {
      log(`REJECT /token refresh_token revoked (sub=${family.sub})`);
      return res.status(401).json({ error: 'invalid_grant', detail: 'refresh token revoked' });
    }

    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = jwt.sign(
      { sub: family.sub, aud: 'api://resource', iss: ISSUER, jti, iat: now, exp: now + ACCESS_TTL },
      privateKey,
      { algorithm: 'RS256' }
    );

    log(`REFRESH new access token sub=${family.sub} jti=${jti} exp=${now + ACCESS_TTL}`);
    return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL });
  }

  log(`REJECT /token unsupported grant_type=${grant_type}`);
  res.status(400).json({ error: 'unsupported_grant_type' });
});

app.post('/logout', (req, res) => {
  const { access_token, refresh_token } = req.body;
  const result = { accessTokenRevoked: false, refreshFamilyRevoked: false };

  if (access_token) {
    const decoded = jwt.decode(access_token);
    if (decoded && decoded.jti) {
      denylist.add(decoded.jti);
      result.accessTokenRevoked = true;
      log(`LOGOUT added jti=${decoded.jti} to denylist`);
    }
  }
  if (refresh_token) {
    const family = refreshFamilies.get(refresh_token);
    if (family) {
      family.revoked = true;
      result.refreshFamilyRevoked = true;
      log(`LOGOUT revoked refresh family sub=${family.sub}`);
    }
  } else {
    log(`LOGOUT called WITHOUT refresh_token — refresh family left alive`);
  }

  res.json(result);
});

app.get('/pubkey', (req, res) => {
  res.json({ publicKey });
});

app.get('/denylist', (req, res) => {
  res.json({ jti: Array.from(denylist) });
});

app.listen(PORT, () => {
  log(`authorization server listening on :${PORT} (issuer=${ISSUER}, ACCESS_TTL=${ACCESS_TTL}s)`);
});
