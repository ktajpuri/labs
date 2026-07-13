# Why-doc: Client-Side Resilience Patterns

Four patterns at the same client→server boundary, tested as sequenced
mini-labs against one shared, hand-written harness (`upstream.js` /
`client.js`, no resilience libraries): **timeouts → retries (backoff+jitter)
→ circuit breaker → load shedding**. Full scenario-by-scenario detail,
predictions, and observed data live in `failure-matrix.md`; this doc
synthesizes what fell out across all four.

## Scorecard

**7 ✓ / 5 ◐ / 2 ✗ across 14 valid scenarios** (◐ = right mechanism/direction,
wrong magnitude or partially wrong; one mini-lab-2 scenario was run against a
broken harness and retracted, not counted here).

| Mini-lab | Scenarios | Record |
|---|---|---|
| 1. Timeouts | 4 | 2 ✓ / 2 ◐ |
| 2. Retries + backoff/jitter | 4 | 2 ✓ / 1 ◐ / 1 ✗ |
| 3. Circuit breaker | 4 | 3 ✓ / 1 ✗ |
| 4. Load shedding | 2 | 2 ◐ |

Mechanism reasoning was right far more often than wrong (only mini-lab 2
scenario 2's "jitter prevents collapse" claim and mini-lab 3 scenario 4's
`halfOpenProbes` prediction were flat-out wrong). The recurring gap was
**magnitude**, not direction — see below.

## Per-mini-lab synthesis

**1. Timeouts** — a hung request with no client timeout is a *permanent*
capacity loss, not a slow leak: since a hang probability is a repeated
per-draw Bernoulli trial over reused sockets, the entire connection budget
collapses within a couple of socket lifetimes, not gradually over the run
(predicted collapse at t=18s; actual t=3s). A client timeout converts a hung
request from a permanent loss into a fixed-cost retry-the-socket event,
restoring throughput to a stable `~(1-hangProb)×rate` indefinitely. With a
*bounded* (two-value, not continuously-distributed) latency profile, timeout
tuning is a step function, not a dial — a constant fraction times out below
the ceiling, and it's exactly zero the instant the timeout clears it.

**2. Retries + backoff/jitter** — naive retries against a real capacity
ceiling create a genuine positive feedback loop (queueing delay → timeout →
retry → more load → more delay) that tips into a fast (~1s), *permanent*
collapse to zero success, no self-recovery. The counterintuitive finding:
**exponential backoff and jitter do not prevent this.** Backoff only
reschedules *when* a retry fires, not the long-run average attempt volume —
if average offered load (including retries) still exceeds capacity, the
queue still grows unboundedly. Jitter can't fix the structural deficit
either, but it does buy real time by delaying onset (~3s later in this
harness). Both are timing/synchronization fixes, not capacity fixes; a
structural over-capacity problem needs fewer retries, more capacity, or
shedding. (Separately: with headroom to absorb extra attempts, retries are
powerful — 0.3 per-attempt failure compounds to 0.3³≈2.7% failure with 3
attempts, ≈97% theoretical success — confirming the same multiplicative math
that deepens a storm under a ceiling is what helps when there isn't one.)

**3. Circuit breaker** — confirmed the brief's claim precisely, with a sharper
distinction than expected: a breaker facing a *partial* sustained failure
rate doesn't settle into a fixed state, it settles into a **metastable
oscillation** — the fixed timer only re-arms a probe *opportunity*, and the
probe's real outcome (a coin flip at ≈1−errorRate) decides CLOSED vs. OPEN
each cycle. At `errorRate=1.0` (no chance of a successful probe) the
oscillation collapses to a permanent re-tripping OPEN state; at
`errorRate=0.6` it cycles between brief CLOSED windows and 5s OPEN windows;
once the upstream genuinely recovers (`errorRate→0` mid-run) it becomes a
true stable CLOSED fixed point. The flatline claim held from both vantage
points — client `sent` and upstream's own `received` metric agreed to the
second. One genuine miss: raising `halfOpenProbes` had no effect in this
harness, because `recordBreakerResult` decides on the *first* result to
arrive, and at this request cadence (50ms) vs. upstream latency (20ms), probes
never actually overlap in flight — a concurrency knob is inert if nothing is
concurrent.

**4. Load shedding** — both `shedMode=queue` and `shedMode=shed` hit the
*same* throughput ceiling (`concurrencyCap ÷ latencyMs`, independent of shed
policy); the difference is entirely in what happens to the excess offered
load. Queuing makes every accepted request wait behind an ever-growing line —
unbounded, linear p99 growth, no data loss but rapidly unusable latency.
Shedding rejects the excess in single-digit milliseconds, before it ever
touches the slow path, leaving accepted-work latency pinned at the base
processing time indefinitely. Layering retries on top of shedding doesn't
produce a storm the way it does against a queueing upstream (shed responses
resolve too fast for queueing delay to build momentum) — but it's still a
real regression: total attempt volume roughly doubled and shed volume roughly
quadrupled for **zero** improvement in success throughput (which is
capacity-bound, not attempt-count-bound), and it happened immediately, not
progressively.

## Cross-cutting themes

**Mechanism right, magnitude off — in both directions.** The single most
consistent pattern this whole session: reasoning about *what* happens and
*why* was correct far more often than not, but *how much* or *how fast* was
frequently off, and not in a consistent direction — sometimes a big
undershoot (hang collapse predicted at t=18s, actual t=3s — 6x low; retry
control scenario predicted ~70% success, actual ~95%), sometimes a big
overshoot (load-shedding queue-mode p99 predicted to cross 1 minute within
20s, actual only reached ~7.4s — needs ~165s at the observed slope). Worth
internalizing: get comfortable computing the actual rate/ratio math
(draws-to-hang, excess-rate × elapsed-time, compounding failure probabilities)
rather than eyeballing magnitude, since intuition here missed by both too
little and too much across the four mini-labs.

**Three qualitatively different long-run steady states, same overload
premise.** No protection → permanent collapse to zero. Retries (with or
without backoff/jitter) against a real capacity ceiling → also permanent
collapse, just with different onset timing. Circuit breaker against a
*partial* failure rate → metastable oscillation, not a fixed state. Load
shedding → immediate, genuinely stable bounded state. The pattern you reach
for changes which of these four outcomes you get, and "stable" only happens
in the last two.

**Aggregate percentiles can completely hide a regression.** A generously
sized timeout absorbs a latency spike into invisibility in the success rate —
it only shows up in p99, never throughput (mini-lab 1). Conversely, adding
retries to a shedding upstream roughly doubled wasted traffic and quadrupled
shed volume while p99 stayed statistically *identical* to the no-retry
baseline — a dashboard watching only p99 (like this lab's own Grafana panel
2) would show nothing changed. p50 collapsing from ~200ms to ~1ms was the
actual tell, because it's dominated by the volume of fast-failing garbage
requests once they outnumber real successes. No single percentile is a safe
proxy for system health; watch volume/rate metrics alongside latency ones.

**A config knob's real effect can be silently gated by an unrelated
variable.** `breakerHalfOpenProbes=5` behaved identically to `=1` in this
harness purely because request cadence (50ms) was slower than upstream
latency (~20ms), so probes never actually overlapped — the setting exists
and is wired correctly, but its observable effect depends on a completely
different, non-obvious factor (relative timing) that its name gives no hint
of.

**Recovery detection latency is bounded by the timer already in flight, not
by how fast the real world heals.** When upstream genuinely recovered
mid-run, the breaker didn't notice until the *next* scheduled probe — however
much of the current `breakerOpenMs` window happened to be left when the fix
landed. In the worst case (fix lands the instant a fresh OPEN window starts),
a genuine recovery can sit undetected for a full `breakerOpenMs` — the timer
bounds probe *opportunity* symmetrically, for lucky probes and real fixes
alike.

## Process notes

A real harness bug surfaced mid-lab-2: `upstream.js`'s concurrency semaphore
double-released when a client-aborted request had already had its slot
released by the `close` handler, then released again by an orphaned
`setTimeout` that fired regardless. This silently defeated `concurrencyCap`
for a stretch of scenarios (`activeCount` observed at -142); the first
retry-storm attempt was retracted and logged as invalidated rather than
deleted once found, and re-run clean after the one-line fix
(`if (responded) return;` guarding the timeout release path).

Mid-session (between mini-labs 3 and 4, at request), both `upstream.js` and
`client.js` were instrumented with `prom-client`, and a 3-panel Grafana
dashboard (`grafana/dashboards/resilience.json`) was added with request-outcome
rate, p50/p75/p99 latency with SLA threshold lines, and error-rate % — this
was infrastructure, not an experiment, but panel 2's p99-only blind spot
turned out to directly demonstrate the "aggregate percentiles can hide a
regression" theme found in mini-lab 4 scenario 2.
