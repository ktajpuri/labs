// Resource server (the API that trusts the JWT). Config via env — this is where scenarios flip:
//   RS_PIN_ALG=true|false        (default true)  — pin verification to RS256, or trust the token's own alg header
//   RS_CHECK_DENYLIST=true|false (default false) — query authz /denylist and reject revoked jti
//   RS_LEEWAY=<seconds>          (default 0)     — clock-skew tolerance on exp/iat
const express = require('express');
const jwt = require('jsonwebtoken');

const PORT = process.env.RS_PORT || 5050;
const AUTHZ_URL = process.env.AUTHZ_URL || 'http://localhost:4000';
const ISSUER = process.env.EXPECTED_ISSUER || 'http://localhost:4000';
const AUDIENCE = 'api://resource';

const RS_PIN_ALG = process.env.RS_PIN_ALG !== 'false'; // default true
const RS_CHECK_DENYLIST = process.env.RS_CHECK_DENYLIST === 'true'; // default false
const RS_LEEWAY = Number(process.env.RS_LEEWAY || 0);

let publicKey = null;
const counters = { accepted: 0, denied: 0 };

function log(line) {
  console.log(`[resource ${new Date().toISOString()}] ${line}`);
}

async function fetchPublicKey() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const resp = await fetch(`${AUTHZ_URL}/pubkey`);
      if (resp.ok) {
        const body = await resp.json();
        return body.publicKey;
      }
    } catch (err) {
      // authz server may not be up yet — retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`could not fetch public key from ${AUTHZ_URL}/pubkey after 10 attempts`);
}

async function isDenylisted(jti) {
  const resp = await fetch(`${AUTHZ_URL}/denylist`);
  const body = await resp.json();
  return body.jti.includes(jti);
}

const app = express();

app.get('/api/data', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    counters.denied++;
    log(`REJECT no bearer token | accepted=${counters.accepted} denied=${counters.denied}`);
    return res.status(401).json({ error: 'missing_token' });
  }

  let decodedHeader;
  try {
    decodedHeader = jwt.decode(token, { complete: true })?.header;
  } catch {
    decodedHeader = null;
  }
  if (!decodedHeader) {
    counters.denied++;
    log(`REJECT unparseable token | accepted=${counters.accepted} denied=${counters.denied}`);
    return res.status(401).json({ error: 'malformed_token' });
  }

  const verifyOptions = { audience: AUDIENCE, issuer: ISSUER, clockTolerance: RS_LEEWAY };
  let keyOrSecret;
  let algorithmsAllowed;

  if (RS_PIN_ALG) {
    // Pinned: always verify as RS256 against our known public key, ignore what the token's header claims.
    algorithmsAllowed = ['RS256'];
    keyOrSecret = publicKey;
  } else {
    // Unpinned (vulnerable): trust the token's own alg header to decide how to verify.
    algorithmsAllowed = [decodedHeader.alg];
    if (decodedHeader.alg === 'HS256') {
      keyOrSecret = publicKey; // classic RS->HS key-confusion: server's own public key used as the HMAC secret
    } else if (decodedHeader.alg === 'none') {
      keyOrSecret = ''; // jsonwebtoken requires 'none' in algorithms and accepts empty signature
    } else {
      keyOrSecret = publicKey;
    }
  }

  let payload;
  let rejectReason = null;
  try {
    payload = jwt.verify(token, keyOrSecret, { ...verifyOptions, algorithms: algorithmsAllowed });
  } catch (err) {
    rejectReason = err.message;
  }

  if (!rejectReason && RS_CHECK_DENYLIST && payload) {
    const revoked = await isDenylisted(payload.jti);
    if (revoked) rejectReason = `jti ${payload.jti} is on denylist`;
  }

  log(`token header=${JSON.stringify(decodedHeader)} payload=${JSON.stringify(payload || jwt.decode(token))}`);
  log(`checks: RS_PIN_ALG=${RS_PIN_ALG} RS_CHECK_DENYLIST=${RS_CHECK_DENYLIST} RS_LEEWAY=${RS_LEEWAY}`);

  if (rejectReason) {
    counters.denied++;
    log(`REJECT (${rejectReason}) | accepted=${counters.accepted} denied=${counters.denied}`);
    return res.status(401).json({ error: 'invalid_token', detail: rejectReason });
  }

  counters.accepted++;
  log(`ACCEPT sub=${payload.sub} jti=${payload.jti} | accepted=${counters.accepted} denied=${counters.denied}`);
  res.json({ data: 'secret payload', sub: payload.sub });
});

app.listen(PORT, async () => {
  publicKey = await fetchPublicKey();
  log(
    `resource server listening on :${PORT} (RS_PIN_ALG=${RS_PIN_ALG}, RS_CHECK_DENYLIST=${RS_CHECK_DENYLIST}, RS_LEEWAY=${RS_LEEWAY}s)`
  );
});
