# Why-doc — OAuth2 + JWT + Logout Failure Lab

## The observable claim

A JWT access token issued during an OAuth2 authorization-code login keeps
authorizing requests *after logout* until it expires or the resource server
consults a server-side revocation store. Logout is not, by itself, a security
control on a stateless bearer token — it's a client-side action against a
server that may or may not be listening for it.

## What the experiments showed

**Scenario 2 is the whole lab in one result.** `logout` updated the authz
server's own bookkeeping (`accessTokenRevoked: true`,
`refreshFamilyRevoked: true`) — but the resource server's verification path
never reads that bookkeeping. It re-checks a signature and three claims
(`aud`, `iss`, `exp`) using a public key it cached once, at boot, and never
refreshes. Nothing about the token itself changed when the user "logged out,"
so nothing about whether it verifies changed either. **Logout ≠ token
invalidation** for a purely stateless JWT — it's two systems that happen to
share a UI action, not one operation.

**Scenario 3 is the fix, and it names its own cost.** Adding
`RS_CHECK_DENYLIST=true` made logout real — but it required the resource
server to make a network round-trip to the authz server on *every request*,
forever. That's not a free win; it's a trade of the exact property (statelessness)
that made JWTs attractive in the first place, purchased back in exchange for
immediacy.

**Scenario 4 confirmed the warm-up's lesson under real load.** A single-
second polling loop showed `exp` behaves as a hard step function — `200` at
t+59s, `401` at t+60s, nothing gradual in between. The predicted *shape* was
exactly right; the predicted *number* (61 vs. 60) was off by one, because
`jsonwebtoken` evaluates `clockTimestamp >= exp` — a `>=`, not a `>` — so the
boundary trips the instant the 60th second elapses, not after it. Worth
knowing cold: TTL isn't a probabilistic decay, it's one integer compared with
one operator.

**Scenarios 5 and 6 are two different bugs that look like the same bug.**
Both start from the same root cause — a resource server that lets the
token's own `alg` header decide how to verify itself, instead of pinning one
algorithm server-side. But they resolve differently:
- `alg=none` (5a) succeeds completely: there is no signature to check at all,
  so once the algorithm choice is attacker-controlled, so is whether any
  cryptographic proof is required. Pinning (5b) closes it outright, because
  `'none'` is simply never in the allowed set.
- HS/RS confusion (6) is subtler and was the one place a prediction went
  wrong even after the mechanism was correctly derived: the *attack* is real
  (an RSA public key is, definitionally, public — using it as if it were a
  private HMAC secret is a category error the server made, not the
  attacker), but `jsonwebtoken` has a **library-level guard** that inspects
  key material and refuses to treat PEM/DER-shaped (asymmetric) keys as HMAC
  secrets, independent of any server-side pinning. The takeaway isn't "the
  attack doesn't work" — it's that defending against algorithm confusion is
  two independent layers: pin the algorithm server-side (your code), *and*
  use a library new enough to refuse the confusion outright (your
  dependency). Neither one alone is the whole story.

## The three sentences to reproduce cold

*"A JWT is a bearer credential the resource server verifies on its own math
— signature plus claims — without consulting the issuer at request time. So
logout doesn't invalidate it; only `exp` passing, or the resource server
explicitly checking a revocation store (a `jti` denylist, or revoking the
refresh-token family so no new access tokens get minted), actually ends the
session — and each of those buys immediacy at the cost of the statelessness
that made JWTs worth using. Algorithm confusion (`alg=none`, HS/RS
downgrade) is a related but separate failure: it's not about session
lifetime at all, it's about a resource server that lets attacker-supplied
input decide its own verification policy instead of pinning one."*

## Conceptual context surfaced during the session (not tested by the harness)

Two distinctions came up while relating this lab to a real production app
(a NextAuth/Auth.js "Sign in with Google" flow) — genuinely useful for
interview framing, but discussed, not run as scenarios:

- **OAuth2-for-login vs. OAuth2-for-API-access.** Most "Sign in with X" apps
  consume the IdP's token exactly once, server-side, to answer "who is
  this," then mint and own a completely separate session credential of
  their own — the IdP's token never becomes the browser's ongoing bearer
  credential. Our lab tested the other shape, where the OAuth-issued JWT
  *is* the ongoing credential, because that's the shape where the logout
  question is sharpest. If that app's own session cookie happens to be
  JWT-strategy under the hood, it inherits the exact same problem — it just
  moves from a header to a cookie.
- **Authn vs. authz.** OAuth2 is natively an authorization protocol
  (delegated, scoped access); OIDC is the layer that adds a standardized
  authentication assertion. Our mock authz server never implements real
  authentication — it hands back a hardcoded `sub` unconditionally — so
  everything this lab exercised (logout, denylist, expiry, forgery) lives
  entirely on the authorization side of that line. Revoking a token revokes
  *permission*; it says nothing about identity.

## Parking lot (seeds for future labs, not chased here)

1. **OAuth2 flow-security failures** — redirect_uri tampering, missing/
   mismatched `state` (CSRF), authorization-code interception/replay, PKCE
   downgrade. This lab exercised the happy-path flow correctly but never
   attacked it; that's a full second lab on its own scope.
2. **A true, unguarded HS/RS confusion demonstration** — hand-rolling the
   HMAC with raw `crypto` on both forge and verify sides to bypass
   `jsonwebtoken`'s built-in PEM guard, to see the "if this defense didn't
   exist" case directly rather than by inference.
3. **Scenario 7** — does a logout that revokes the access token's `jti` but
   *not* the refresh-token family actually end the session? (It doesn't —
   `refresh` would still mint a valid new access token.) Not run this
   session.
4. **Auth.js/NextAuth session-strategy check** — is the real production
   app's `session-token` cookie JWT-strategy or database-strategy? That
   answer determines whether the exact vulnerability tested here is live in
   that app right now.
