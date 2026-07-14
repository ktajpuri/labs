# Tiered Model Routing — Escalation Signal Reliability

Failure lab. Concept under test: what escalation signal should a tiered router
(code path → local model → Sonnet → Opus) use to decide when a cheaper tier's
answer can be trusted, and where does each signal fail. Core claim: a local
model's self-reported confidence is unreliable — it can be confidently wrong —
so a confidence-threshold router silently ships wrong answers. A structural
verifier catches more of that, at added cost.

## Setup

```sh
cd model-routing-lab
npm install          # already done if you're reading this after the build
ollama serve &        # if not already running
ollama list           # confirm llama3.2:3b is present
```

Requires `ANTHROPIC_API_KEY` in `../.env` (i.e. `/Users/ktajpuri/Desktop/sandbox/labs/.env`).
Every command below loads it via Node's built-in `--env-file` flag — nothing
reads or prints the key itself.

## Reset to clean

There's no persistent state — every run reads `golden-set.json` and
`orders.json` fresh and prints to stdout. To reset: nothing to do. (If you
want a clean Ollama model cache: `ollama rm llama3.2:3b && ollama pull llama3.2:3b`.)

## Steady-state check (run this first, free — no API calls)

```sh
node --env-file=../.env run.mjs steady-state
```

This runs the intent matcher alone (same as S2) over all 30 golden queries.
Confirms: golden set loads, orders fixture loads, intent matcher logic runs,
report formatting works — before spending anything on the LLM tiers.

## Scenarios

```sh
node --env-file=../.env run.mjs s1                    # baseline: all 30 -> Sonnet
node --env-file=../.env run.mjs s2                    # code-path coverage (free)
node --env-file=../.env run.mjs s3 --threshold=0.7    # confidence cascade
node --env-file=../.env run.mjs s4                    # CORE: confidence calibration probe
node --env-file=../.env run.mjs s5                    # verifier-based escalation
node --env-file=../.env run.mjs s6                    # control: local vs Opus
node --env-file=../.env run.mjs s7                    # threshold sweep 0.5/0.7/0.9
node --env-file=../.env run.mjs s8                    # control: 1B vs 3B local model
node --env-file=../.env run.mjs s9                    # CORE: confidence calibration, 1B model
node --env-file=../.env run.mjs s10 --threshold=0.7   # confidence cascade, 1B model
node --env-file=../.env run.mjs s11-dry               # free: router classification only, no LLM calls
node --env-file=../.env run.mjs s11                   # CORE: full end-to-end router, all 30 queries mixed
node --env-file=../.env run.mjs s12-dry               # free: router v2 (fixes S05's zip-code false trigger)
node --env-file=../.env run.mjs s12                   # CORE: not yet run — outcome inferable from S11, skipped by request
```

Every run prints one row per query (tier, route, tokens, cost, latency,
correct/wrong) and a totals line. S3/S5/S7 also print an escalation rate.

## Cost

Pricing baked into `src/pricing.mjs` (cached 2026-06-24): Sonnet $3/$15 per
MTok, Opus $5/$25 per MTok, Haiku $1/$5 per MTok, local model $0. The local
model calls are free and unlimited (that's rather the point). Rough per-scenario
ceiling estimates for the paid tiers, worst case:

| Scenario | Paid calls | Rough cost |
|---|---|---|
| S1 | 30 Sonnet calls + 14 judge calls (medium/hard) | ~$0.05–0.15 |
| S2 | 0 (code path only) | $0 |
| S3 | up to 8 Sonnet escalations | ~$0.01–0.03 |
| S4 | 0 (local model only) | $0 |
| S5 | up to 8 Haiku checks + up to 8 Sonnet escalations | ~$0.01–0.03 |
| S6 | 8 Opus calls | ~$0.02–0.05 |
| S7 | 3x S3 (up to 24 Sonnet escalations total) | ~$0.03–0.08 |

Full 7-scenario run, worst case: well under $1. I'll flag explicitly before
anything that could approach $2 (it shouldn't, at this golden-set size).

## Files

- `golden-set.json` — 30 hand-labeled queries across 4 difficulty tiers
- `orders.json` — fake backing order data (order IDs 10004–10788, plus
  nonexistent 10999 used to test false-claim/hallucination behavior)
- `policy.md` — fake refund policy used by the medium/hard tier prompts
- `src/intentMatcher.mjs` — trivial-tier code path (regex, no LLM)
- `src/localModel.mjs` — Ollama client (llama3.2:3b), simple-tier extraction
- `src/claude.mjs` — Sonnet/Opus/Haiku client + shared extraction wrapper
- `src/prompts.mjs` — all system prompts, including the frozen judge rubric
- `src/grader.mjs` — structural grading (trivial/simple) + Sonnet-judge grading (medium/hard)
- `src/verifier.mjs` — structural + Haiku plausibility check (S5's alternative signal)
- `src/report.mjs` — shared row/totals printing
- `run.mjs` — CLI entry point, all 7 scenarios
