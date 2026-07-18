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

## Scenario 4 — payment fails → SAGA compensation (reverse the previous steps)
No env change, no restart. Charge an amount **≥ $1000** and the gateway hard-declines it
(`402` — "over limit"). Reserve already happened, so the workflow **unwinds it** and cancels
the order.
```
npm run order -- order-4 5000 0
```
What happens (watch Terminal 2 / the UI):
1. `reserveInventory` succeeds → workflow pushes `releaseInventory` onto its compensation stack.
2. `chargePayment` → gateway returns **402**. This is a *business* decline: retrying can't fix
   it, so the activity throws a **non-retryable** `ApplicationFailure` — Temporal fails it on
   **attempt 1** (no wasted retries), unlike the 503 in Scenario 3.
3. The workflow catches it and **compensates in reverse (LIFO)**: `releaseInventory(order-4)`
   → inventory goes back up.
4. Then `cancelOrder(order-4)` marks the order **CANCELLED**.
5. Result: `order order-4 cancelled (payment declined ... over limit)`. The workflow ends
   **Completed** — the saga left the system consistent; cancellation is a clean outcome, not a
   crash. (Re-throw in `workflows.ts` if you'd rather it show as **Failed** in the UI.)

Verify the rollback:
```
curl -s http://localhost:3001/state   # inventory back to 100, status order-4 = CANCELLED
curl -s http://localhost:3004/state   # count 0 — no charge was ever captured
```

In the UI, `order-4`'s history shows `reserveInventory` Completed, `chargePayment` **Failed**,
then `releaseInventory` + `cancelOrder` Completed — the rollback is recorded in history too, so
**the compensation is itself durable** (kill the worker mid-rollback and it resumes).

**503 vs 402 — retry vs compensate:** a *transient* failure (Scenario 3, 503) is retried
because retrying helps; a *permanent business* failure (402 here) is compensated because it
won't. Choosing which is which is the real design decision the saga pattern forces.

> Because compensations run at-least-once too, each one is **idempotent** on the service side
> (`/release` only frees a live reservation, `/refund` only reverses a live charge). If a later
> step failed *after* a successful charge (e.g. shipping), the stack would also hold
> `refundPayment`, and it would run first — reverse order of how the steps were applied.

## Scenario 5 — failure AFTER a successful charge → multi-step rollback
Same saga, but now the failure lands *later*, so there's **more to unwind**. Charge succeeds,
then **shipping fails permanently** (`422` — "address undeliverable"), so the workflow must undo
**both** the charge and the reservation — in reverse.
```
# Terminal 1: Ctrl-C, then restart the services with shipping made to fail:
SHIPMENT_FAIL=1 npm run services
# Terminal 3:
npm run order -- order-5 79 0        # amount < 1000, so the charge is captured first
```
What happens:
1. `reserveInventory` ✓ → push `releaseInventory`.
2. `chargePayment` ✓ (captured at the gateway) → push `refundPayment`.
3. `shipOrder` → **422**, non-retryable → the workflow catches it.
4. It unwinds the stack **in reverse (LIFO)** — the mirror of how the steps were applied:
   `refundPayment(order-5)` **first**, then `releaseInventory(order-5)`.
5. Then `cancelOrder(order-5)`.

The worker log makes the ordering explicit:
```
order order-5 FAILED: shipment failed ... — compensating in reverse (2 step(s))
  compensating: refundPayment(order-5)
  compensating: releaseInventory(order-5)
order order-5 rolled back + CANCELLED
```
Verify:
```
curl -s http://localhost:3001/state   # inventory back to 100, order-5 = CANCELLED
curl -s http://localhost:3004/state   # the charge shows refunded:true, count 0 (net zero)
```
This is the whole point of the compensation stack: the set of steps to undo depends on **how
far the workflow got** before it failed. Fail at charge (Scenario 4) → 1 compensation; fail at
ship (here) → 2, run newest-first.

> Reset shipping afterwards: Ctrl-C Terminal 1 and `npm run services` (without `SHIPMENT_FAIL`).

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
| _(new)_ compensation / rollback | Scenario 4: saga — `try/catch` unwinds a compensation stack in reverse |
