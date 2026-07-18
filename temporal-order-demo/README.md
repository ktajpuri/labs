# Temporal Order Demo — durable execution in the real tool

The follow-up to `temporal-durable-execution-lab/` (where you hand-rolled the engine).
Here the same `reserve → charge → ship` order flow runs on a **real Temporal server**, with
**3 microservices + a payment gateway** as separate processes, and you watch the workflows
(event history, retries, replay) in the **Temporal Web UI**.

```
Order workflow (Temporal)                       ┌─ order-svc   :3001  (reserve inventory)
   reserveInventory ─ activity ─ HTTP ─────────►┤
   chargePayment    ─ activity ─ HTTP ─► payment-svc :3002 ─► gateway :3004 (idempotent)
   shipOrder        ─ activity ─ HTTP ─────────►└─ shipment-svc :3003 (ship)
        ▲
   worker.ts  ── the process you KILL & RESTART to see durable execution
```

- **Workflow** (`src/workflows.ts`): deterministic orchestration only — no side effects, no
  `Date.now()`/random in the body. This is what Temporal replays.
- **Activities** (`src/activities.ts`): the only place side effects (HTTP calls) happen.
  Temporal records each result in history; retries them on failure (at-least-once).
- **Gateway** (`src/services/gateway.ts`): the boundary — dedupes on an idempotency key so a
  retried/re-run charge lands once.

## One-time setup
```
docker compose up -d        # Temporal server + UI + Postgres. UI: http://localhost:8080
npm install
```

## Run it — you need 3 terminals

**Terminal 1 — the 4 services:**
```
npm run services            # order:3001 payment:3002 shipment:3003 gateway:3004
```
**Terminal 2 — the Temporal worker:**
```
npm run worker              # polls the "orders" task queue
```
**Terminal 3 — start orders:**
```
npm run order -- <id> [amount] [holdSeconds]
```

Open the **UI at http://localhost:8080** and click a workflow to see its event history.

---

## Scenario 1 — happy path
```
npm run order -- order-1 79 0
```
In the UI, open `order-1`: you'll see the event history — `WorkflowExecutionStarted`, three
`ActivityTaskScheduled/Started/Completed` pairs (reserve, charge, ship), `...Completed`.
Gateway captured 1 charge (`curl -s http://localhost:3004/state`).

## Scenario 2 — CRASH-RESUME (the payoff)
```
npm run order -- order-2 79 30      # 30-second durable-timer hold before ship
```
While it's holding (Terminal 2 logs "holding 30s... safe to kill the worker now"):
1. **Kill the worker** in Terminal 2 with Ctrl-C. Reserve + charge already happened.
2. Watch the UI — `order-2` is still **Running**, parked on a `TimerStarted` event. Nothing lost.
3. **Restart the worker:** `npm run worker`.
4. The worker replays `order-2`'s history (reserve + charge from history — NOT re-executed),
   resumes the timer, and ships when it fires. Workflow completes.
5. `curl -s http://localhost:3004/state` — `order-2` charged **exactly once**. No double charge.

This is durable execution: the workflow survived the process crash and resumed from history.

## Scenario 3 — at-least-once retry + idempotency (the S5 boundary, for real)
Restart the services with the gateway made flaky (fails the first attempt per order):
```
# Terminal 1: Ctrl-C, then:
GATEWAY_FLAKY=1 npm run services
# Terminal 3:
npm run order -- order-3 79 0
```
- Gateway 503s the first charge attempt → the `chargePayment` **activity fails** → Temporal
  **retries it** (per the workflow's retry policy) → second attempt succeeds.
- In the UI, `order-3`'s charge activity shows **2 attempts** (Attempt 1 failed, Attempt 2 OK).
- Gateway captured **1 charge** — the idempotency key made the retry safe. Temporal gives
  at-least-once activity execution; the idempotent gateway makes the *effect* exactly-once.

## Reset
```
docker compose down -v      # wipes Temporal history (full reset)
docker compose up -d        # fresh
```
Service state is in-memory — restart `npm run services` to reset inventory/charges.

## How this maps to the hand-rolled lab
| Hand-rolled lab | Here (real Temporal) |
|---|---|
| `durable/engine.js` history + replay | the Temporal server + worker |
| `ctx.step(name, fn)` | `proxyActivities` / an activity |
| `[replay]` vs `[exec]` log lines | replay is internal; see attempts + event history in the UI |
| `--crash-after` process.exit | Ctrl-C the worker during the durable timer |
| `--idempotent` charge | the gateway's `idempotency-key` dedup |
| S5 at-least-once boundary | Scenario 3: activity retried, one charge lands |
