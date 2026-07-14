# OAuth2 + JWT + Logout Failure Lab

**Concept:** a JWT access token issued during an OAuth2 authorization-code login keeps
authorizing requests *after logout* until it expires or the resource server checks a
server-side revocation store — stateless session termination. See `PLAN.md` for the full
scope contract; scenarios and predictions live in `failure-matrix.md`.

## Components

- `authz-server.js` — port 4000. Mock OAuth2 authorization server / IdP. Generates an
  RS256 keypair at boot (in-memory only). Implements `/authorize` (PKCE), `/token`
  (authorization_code + refresh_token grants), `/logout`, `/pubkey`, `/denylist`.
- `resource-server.js` — port 5050 (not 5000 — macOS AirPlay Receiver squats on 5000).
  The API that trusts the JWT. Behavior is set via env
  vars (no restart-editing code needed):
  - `RS_PIN_ALG` (default `true`) — verify strictly as RS256. Set `false` to trust the
    token's own `alg` header instead (the vulnerable path).
  - `RS_CHECK_DENYLIST` (default `false`) — query authz `/denylist` per request and reject
    a revoked `jti`. Set `true` to make logout actually mean something.
  - `RS_LEEWAY` (default `0`) — clock-skew tolerance in seconds on `exp`.
  - `ACCESS_TTL` is set on the **authz server**, not here (it's baked into the token at
    issuance).
- `flow.js` — the CLI you use to drive the flow: `login`, `call`, `logout` (add
  `--partial` to withhold the refresh token), `refresh`.
- `forge.js` — mints malicious tokens (`none`, `hsconfusion`) into the same token file
  `flow.js` reads, so `node flow.js call` immediately tests them.

Tokens are cached in `.tokens/current.json`. `logout` deliberately does **not** delete
this file — that's the point: the local client "forgetting" a token is not what makes a
JWT stop working server-side.

## Start

```
npm install
node authz-server.js     # terminal 1
node resource-server.js  # terminal 2 — reads RS_* env vars, see table below
```

Resource server fetches the public key from the authz server at boot, so start authz first
(or just restart resource-server.js if it fails — it retries for ~3s then gives up).

## Steady state (run this first, before any scenario)

```
node flow.js login
node flow.js call
```

Expect: decoded JWT printed after `login`, then `GET /api/data -> 200` after `call`. Don't
proceed to failure scenarios until this works.

## Reset to clean

`Ctrl-C` both servers and restart them. All state (issued codes, denylist, refresh
families) is in-memory only — a fresh boot is a fresh IdP. Then `node flow.js login` again
to get a fresh token before the next scenario (old tokens reference a keypair /
denylist that no longer exists after an authz-server restart).

## Env cheatsheet per scenario

| Scenario | authz-server env | resource-server env |
|---|---|---|
| 1. Happy path | defaults | defaults |
| 2. Logout, replay token | defaults | `RS_CHECK_DENYLIST=false` (default) |
| 3. Denylist enforced | defaults | `RS_CHECK_DENYLIST=true` |
| 4. Short-TTL boundary | `ACCESS_TTL=60` | `RS_CHECK_DENYLIST=false` |
| 5. alg=none forgery | defaults | `RS_PIN_ALG=false`, then `RS_PIN_ALG=true` |
| 6. HS/RS key confusion | defaults | `RS_PIN_ALG=false`, then `RS_PIN_ALG=true` |
| 7. (stretch) Refresh after logout | defaults | `RS_CHECK_DENYLIST=true` |

Example: `ACCESS_TTL=60 node authz-server.js`
