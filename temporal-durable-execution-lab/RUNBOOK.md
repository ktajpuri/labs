# RUNBOOK — Temporal / Durable-Execution Lab (self-contained retrieval drill)

Run these cold, later, without chat history. Write your prediction/diagnosis at each
**STOP** line before revealing.

## Prerequisites
- Node.js (v18+). No dependencies, no Docker.
- `cd` into this folder.

## Reset to clean (run before every scenario)
```
node reset.js
```
Fresh world (inventory 100, 0 charges), no orders, empty history.

Watch the number: **charges for one order should end at exactly 1.** `report.js` flags
`DOUBLE CHARGED`.

---

## PART A — the naive world (status column + retry). Diagnose what breaks.

### S1 — crash at a clean boundary (control)
```
node reset.js
node naive/run.js order-1 --crash-after=reserve-status
node naive/run.js order-1
node report.js
```
**STOP — write your diagnosis before scrolling.** (How many charges? Did anything break? Why?)
<details><summary>Reveal</summary>

1 charge, nothing breaks. The crash landed *after* `status=RESERVED` was saved, so the
persisted status matched the world. On resume, `if (status==='NEW')` is skipped → reserve
does not re-run → charge runs once. A crash survives cleanly only when the persisted status
already reflects the side effect that happened.
</details>

### S2 — crash between side effect and status write (double charge)
```
node reset.js
node naive/run.js order-1 --crash-after=charge-side
node naive/run.js order-1
node report.js
```
**STOP — write your diagnosis before scrolling.**
<details><summary>Reveal</summary>

**2 charges.** The charge hit the world, but the process died before `status=CHARGED` was
saved — the two writes aren't atomic. On resume, status still says `RESERVED`, so the
`RESERVED` block re-charges. Status *lagged* reality by one step; the resume trusted it.
</details>

### S3 — repeated crash (the multiplier)
```
node reset.js
node naive/run.js order-1 --crash-after=charge-side
node naive/run.js order-1 --crash-after=charge-side
node naive/run.js order-1 --crash-after=charge-side
node naive/run.js order-1
node report.js
```
**STOP — write the exact charge count and the formula before scrolling.**
<details><summary>Reveal</summary>

**4 charges** (3 crashed retries + 1 clean run). Every retry starts at `status=RESERVED`
because the status write never survives a `charge-side` crash, so `RESERVED` re-charges
unconditionally. No idempotency → **N failed retries = N duplicate charges** (linear
multiplier). A flaky provider becomes a money multiplier.
</details>

### S4 — lost in-flight state (price divergence)
```
node reset.js
node naive/run.js order-1 --crash-after=charge-side
node naive/run.js order-1
node report.js
cat state/ledger.json
```
**STOP — are the two charge amounts the same or different? What was lost?**
<details><summary>Reveal</summary>

**Different amounts.** `computePrice()` re-runs on every entry (a varying promo); the price
lived only in process memory and died with the crash. `status` records *position* (which
step), never the *values computed along the way*. Even a non-double-charging retry would
charge a different price.
</details>

---

## PART B — the durable engine (append-only history + replay). Predict.

Engine rule: workflow calls `ctx.step(name, fn)`; each step's result is appended to history
after it runs; on restart the workflow re-runs from the top and every already-recorded step
is **replayed** (recorded result returned, side effect NOT re-run) until the first unrecorded
step, which executes. Durable crash points: `<step>-side` (side effect done, result NOT yet
in history) and `<step>-recorded` (result durably written).

### S2' — the money bug, fixed
```
node reset.js
node durable/run.js order-1 --crash-after=charge-recorded
node durable/run.js order-1
node report.js
```
**STOP — write your prediction before scrolling.** (Charges? Which steps `[replay]` vs `[exec]`?)
<details><summary>Reveal</summary>

**1 charge.** Resume: `price`, `reserve`, `charge` all `[replay]` (found in history → returned,
not re-run); only `ship` `[exec]`. The charge result was recorded before the crash, so replay
skips it. Price replays identical (S4 fixed for free — recorded, not recomputed).
</details>

### S3' — the multiplier, dead
```
node reset.js
node durable/run.js order-1 --crash-after=charge-recorded
node durable/run.js order-1 --crash-after=charge-recorded
node durable/run.js order-1 --crash-after=charge-recorded
node durable/run.js order-1
node report.js
```
**STOP — write your prediction before scrolling.**
<details><summary>Reveal</summary>

**1 charge**, `charge` says `[replay]` on every resume. A recorded step is replayed, never
re-executed → the N-retries→N-duplicates multiplier is gone.
</details>

### S5 — THE BOUNDARY: crash before the record (no idempotency)
```
node reset.js
node durable/run.js order-1 --crash-after=charge-side
node durable/run.js order-1
node report.js
```
**STOP — write your prediction before scrolling.** (This is the one that matters.)
<details><summary>Reveal</summary>

**2 charges**, `charge` says `[exec]` on resume. The crash landed in the window between "side
effect done in the world" and "result appended to history," so replay finds **no charge event**
and re-executes it. Durable execution guarantees **at-least-once** step execution + deterministic
replay, **NOT exactly-once side effects.** (Both charges are the same price — price *was* recorded.)
</details>

### S5-fix — idempotent activity closes the gap
```
node reset.js
node durable/run.js order-1 --crash-after=charge-side --idempotent
node durable/run.js order-1 --idempotent
node report.js
```
**STOP — write your prediction before scrolling.**
<details><summary>Reveal</summary>

**1 charge.** The `charge` step *still* `[exec]`s on resume (at-least-once — the engine can't
know the provider already charged), but the payment provider dedupes on the idempotency key and
no-ops the second call. Exactly-once side effect = engine's at-least-once **+** idempotent activity.
</details>

### Boundary 2 (bonus) — non-determinism in orchestration code
```
node reset.js
node durable/run.js order-1 --crash-after=charge-recorded --nondeterministic
node durable/run.js order-1 --nondeterministic
```
**STOP — what risk does a raw `Math.random()` branch in the workflow BODY create on replay?**
<details><summary>Reveal</summary>

Replay re-executes the workflow body. A branch on `Math.random()`/`Date.now()`/wall-clock
**outside** a recorded step can take a different path on replay than originally ran → recorded
history no longer matches the code's actions → non-determinism error / corruption. Rule: all
non-determinism and side effects live inside steps/activities (whose results are recorded),
never in orchestration code. (This lab keeps `price` as a *step* for exactly this reason.)
</details>
