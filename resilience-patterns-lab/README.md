# Resilience Patterns Lab

Four client-side resilience patterns, one shared harness: **timeouts → retries
(backoff+jitter) → circuit breaker → load shedding**. Each pattern is its own
mini-lab with its own observable claim and failure matrix. No frameworks, no
resilience libraries — the client's retry/backoff/breaker logic is hand-written
in `client.js` so it can be read and interrogated directly.

## Components

- `upstream.js` — plain Node HTTP server. Behavior (latency, latency spikes,
  hangs, error rate, concurrency cap, shed-vs-queue) is set live via an admin
  endpoint, no restart needed.
- `client.js` — load driver. Fires requests at a configurable open-loop rate
  and prints per-second counters: `sent success fail timedOut retried shed
  breakerRejected breaker p50 p99`.

No dependencies, no build step. Requires Node 18+ (built-in `http` module
only).

## Start

Terminal 1 — upstream:

```
node upstream.js
```

Terminal 2 — reset it to a known clean config any time:

```
curl -s -X POST localhost:4000/admin/config -d '{
  "latencyMs": 20, "spikeProbability": 0, "spikeLatencyMs": 500,
  "hangProbability": 0, "errorRate": 0, "concurrencyCap": 1000, "shedMode": "queue"
}' -H 'Content-Type: application/json'

curl -s -X POST localhost:4000/admin/reset
```

Check current config/counters at any time:

```
curl -s localhost:4000/admin/status | python3 -m json.tool
```

## Steady-state verification (run this before any experiment)

With the upstream at the clean config above (20ms latency, no faults, cap
effectively unlimited), run a light client load with every resilience
feature off:

```
node client.js --rate 20 --duration 10 --concurrency 50
```

**Expected steady state:** `sent` ≈ 20/sec, `success` ≈ `sent`, `fail` = 0,
`timedOut` = 0, `retried` = 0, `shed` = 0, `breaker=CLOSED`, p50/p99 both close
to 20ms. If you don't see this, fix the harness before starting any mini-lab —
don't draw conclusions from an unverified baseline.

## Mini-labs

Each mini-lab's scenarios, predictions, and results live in `failure-matrix.md`
(one section per mini-lab, appended as each is run). The final `why-doc.md`
synthesizes all four after mini-lab 4 is complete.

1. **Timeouts** — does a client timeout recover throughput when upstream hangs?
2. **Retries** — do naive immediate retries deepen an outage; does backoff+jitter fix it?
3. **Circuit breaker** — does tripping flatline upstream traffic; does half-open, not the timer, decide recovery?
4. **Load shedding** — does early rejection bound p99 for accepted work vs. queuing degrading everything?

Reset to the clean config (above) between every scenario, in every mini-lab,
unless a scenario explicitly says otherwise.

## client.js flags

```
--url                        default http://localhost:4000/work
--rate                       logical requests/sec (open-loop)     default 20
--duration                   seconds                              default 15
--concurrency                client connection budget (agent maxSockets)  default 50
--timeout                    client-side request timeout ms, 0=off default 0
--retries                    max retry attempts per request       default 0
--backoff                    none | fixed | exponential           default none
--backoff-base               ms                                   default 100
--backoff-factor             exponential multiplier                default 2
--jitter                     off | full                            default off
--breaker                    off | on                              default off
--breaker-threshold          error rate (0..1) to trip             default 0.5
--breaker-window             rolling requests considered            default 20
--breaker-open-ms            time OPEN before a half-open probe     default 5000
--breaker-half-open-probes   concurrent probes allowed in HALF_OPEN default 1
```

## upstream.js admin config fields

```
latencyMs           baseline processing delay
spikeProbability     0..1 chance a request takes spikeLatencyMs instead
spikeLatencyMs
hangProbability      0..1 chance a request is accepted then never answered
errorRate            0..1 chance of a 500
concurrencyCap       max requests processed at once
shedMode             "queue" (serialize behind cap) | "shed" (503 immediately over cap)
```
