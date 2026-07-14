# Failure Matrix — OAuth2 + JWT + Logout Lab

Observable claim under test: *a JWT access token issued during an OAuth2
authorization-code login keeps authorizing requests after logout, until it
expires or the resource server checks a server-side revocation store.*

Predictions are recorded verbatim, including the ones that were wrong or
revised mid-scenario — the gap between the raw prediction and what actually
happened is the point.

| # | Scenario | Prediction (verbatim) | Observed | Verdict | Takeaway |
|---|---|---|---|---|---|
| 1 | **Happy path** — login, decode JWT, call `/api/data` | *(none — steady-state orientation, run before the predict-first protocol started)* | `200`, decoded claims `sub/aud/iss/jti/iat/exp` all present, RS verified locally against a public key cached once at boot | — control | Establishes the mechanics: PKCE binds code exchange to the original request; the resource server never talks back to the authz server per-request. |
| 2 | **Logout, then replay the same token** (`RS_CHECK_DENYLIST=false`) | "we get 200, the resource server has no way to know that the token is invalid now" | `200` | ✓ | Logout updated the authz server's own records (`accessTokenRevoked: true`, `refreshFamilyRevoked: true`) but the resource server never consulted them. Nothing about the token changed, so nothing about its verifiability changed. **This is the core finding of the lab.** |
| 3 | **Denylist enforced** (`RS_CHECK_DENYLIST=true`) | "401, the token is in revoked list now" | `401` — `"detail": "jti d0baaab7... is on denylist"` | ✓ | The fix works, but it costs statelessness: the resource server now makes a network round-trip to the authz server on *every* request. |
| 4 | **Short-TTL boundary** (`ACCESS_TTL=60`, `RS_CHECK_DENYLIST=false`) | "the flip is exact, it flips exactly on 61st second after issue" | Per-second polling loop: `t+59s → 200`, `t+60s → 401`. Flip is a single-second, deterministic step — but at **t=60**, not t=61 | ◐ | Right shape (exact step, not fuzzy — confirmed the warm-up's step-function lesson), wrong by one second on the number. Mechanism: `jsonwebtoken` checks `clockTimestamp >= exp` with `clockTolerance=0`; `exp = iat + 60` trips the instant 60 whole seconds have elapsed, not after 61. |
| 5a | **`alg=none` forgery, unpinned** (`RS_PIN_ALG=false`) | "status code 200, access granted. The requester can generate their own JWT key using any algo they want and send with request" | `200`, `"sub": "attacker"`, zero-length signature segment | ✓ | Prediction's direction was right (attacker controls the check by controlling `alg`); refined in-session: for `alg=none` there's no key involved at all — the signature segment is empty and `jwt.verify` with `algorithms` including `'none'` skips cryptographic verification entirely. |
| 5b | **Same forged token, pinned** (`RS_PIN_ALG=true`) | *(none recorded — protocol slip, flagged live)* | `401` — `"detail": "jwt signature is required"` | — ungraded | Pinning to `['RS256']` means `'none'` is never in the allowed set, so the library rejects the empty signature before any algorithm comparison happens. |
| 6 | **HS/RS key confusion** (`RS_PIN_ALG=false`) | Initial: "we get 401, this time it actually verifies the token against the secret" (pushed back — no HMAC secret exists anywhere in this harness). Revised after mechanism walkthrough: "200" (attacker computes a matching HMAC using the RSA public key fetched from `/pubkey`, since the vulnerable code treats that public key as an HMAC secret when `alg=HS256`) | `401` — but **not** a signature mismatch: `"detail": "secretOrPublicKey must be a symmetric key when using HS256"` | ✗ | The revised prediction correctly describes the classic RS/HS confusion attack class — that mechanism is real and is exactly why it's a well-known CVE pattern. But the `jsonwebtoken` library has a **built-in guard**: it inspects the key material, detects it's PEM/DER-shaped (asymmetric), and refuses to use it for an HS-family algorithm at all, regardless of `RS_PIN_ALG`. Neither prediction anticipated this library-level defense-in-depth. |

**Scenario 7 (stretch — partial logout leaves the refresh family alive) was not run this session** — skipped by choice to move to deliverables; see parking lot in `why-doc.md`.

## Prediction scorecard

**3 ✓ / 1 ◐ / 1 ✗** across 5 graded predictions (Scenario 1 was ungraded orientation; Scenario 5b had no prediction on record, flagged live as a process slip, not silently absorbed into the score).

| Scenario | Verdict |
|---|---|
| 2 — logout doesn't invalidate | ✓ |
| 3 — denylist fixes it | ✓ |
| 4 — TTL boundary is a step function | ◐ (right shape, off-by-one on the exact second) |
| 5a — alg=none accepted unpinned | ✓ |
| 6 — HS/RS confusion | ✗ (right vulnerability class, wrong about this library's defenses) |

The one flat miss (Scenario 6) wasn't a reasoning failure — the revised prediction correctly derived the real-world attack. It was a gap in knowing that modern JWT libraries patch against it. That's a stronger thing to walk into an interview knowing than a clean confirmation would have been.
