# LABLOG — Temporal / Durable-Execution Lab (DISCOVERY)

Concept: durable execution — a workflow survives its own process crash and resumes
exactly where it left off (no re-run of completed steps, no lost in-flight state).

## Phase 2a — break the naive version (diagnose-first)

### S1 — crash at a clean boundary (control) — ✓
Setup: `--crash-after=reserve-status` (status=RESERVED saved), then resume.
Observed: 1 charge, no invariant broke, order SHIPPED.
Diagnosis (correct): crash landed after the status write, so persisted status matched
the world; resume skipped the NEW block, reserve did not re-run, charge ran once.
Keep: a crash survives cleanly only when the persisted status already reflects the
side effect that happened — "status told the truth."

### S2 — crash between side effect and status write (double charge) — ✓
Setup: `--crash-after=charge-side` (world charged, status NOT yet CHARGED), then resume.
Observed: 2 charges, invariant "one charge per order" broken.
Diagnosis (correct): status said RESERVED but the world said charged; the two writes
(side effect vs status) are not atomic, so the crash left status lagging reality by one
step; resume trusted status and re-charged.
His fix instinct: an append-only log of state transitions (reserved-init/success,
charged-init/success). Parked — the init/success gap has its own subtlety (S3/pivot).
Keep: a naive status field can LAG the real side effect; a resume that trusts it
re-executes the already-done step. Non-atomic (side effect, record) = duplicate on crash.

### S3 — repeated crash at charge-side (compounding) — ✓
Setup: crash at charge-side 3x, then clean run.
Observed: 4 charges (predicted 4). duplicates = crashed retries (3).
Diagnosis (correct): every retry starts at status=RESERVED (status write never survives
the crash), so RESERVED re-charges unconditionally each time — no idempotency/memory.
Keep: without idempotency, retries don't converge — they ACCUMULATE. N failed retries
before the status write = N duplicate side effects (linear multiplier).

### S4 — lost in-flight state (price divergence) — ✓
Setup: crash at charge-side, resume, inspect the two charge AMOUNTS in ledger.json.
Observed: the two charge amounts differ.
Diagnosis (correct): computePrice() re-runs each entry; the price lived only in memory
and died with the process. status records POSITION (which step), not the computed values.
Keep: durable resume needs more than "which step" — it needs the RESULT of each step.
Even a perfectly idempotent retry recharges at a different price if step outputs aren't
recorded. Position ≠ computed state.

## PIVOT — concept introduction (durable execution)
Derived event-sourcing + replay himself. Correction applied: replay = RETURN recorded
result, not recompute (recompute IS the naive bug). Boundary flagged: engine gives
at-least-once, not exactly-once; idempotency key closes the last gap.

## Phase 2b — rerun against the durable engine (predict-first)

### S2' — money bug vs durable, crash at charge-recorded — ✓
Predicted: 1 charge; price/reserve/charge = [replay]; "finds the step already executed."
Observed: 1 charge; price/reserve/charge [replay] (price replayed 98), ship [exec].
Correct. Same crash that double-charged S2 now charges once. S4 fixed for free (price
replayed identical, not recomputed).

### S3' — retry multiplier vs durable, crash at charge-recorded x3 — ✓
Predicted: 1 charge; charge = [replay] on every resume.
Observed: 1 charge; [replay] charge each time.
Correct. A recorded step is replayed, never re-executed → the N-retries→N-duplicates
multiplier is dead.

### S5 — BOUNDARY: crash at charge-side (side effect done, NOT recorded) — ✓
Predicted: 2 charges; charge = [exec]; "engine finds no charge entry in history, so it
executes the step again."
Observed: 2 charges; [exec] charge; both at the same price (price was recorded/replayed).
Correct — and this is the deepest point. Durable execution guarantees AT-LEAST-ONCE step
execution + deterministic replay, NOT exactly-once side effects. A crash in the window
between "side effect done in the world" and "result appended to history" re-runs the step.
Keep: the engine cannot make an external side effect exactly-once by itself — the world
changed but history didn't, and history is the only thing replay trusts.

### S5-fix — same crash, --idempotent — ✓
Predicted: 1 charge; charge still [exec] but provider dedupes on the key.
Observed: 1 charge; [exec] charge, no second charge lands.
Correct. Exactly-once side effect = engine's at-least-once + idempotent activity
(idempotency key). Ties directly to warm-up dist-txn-A1 (idempotency keys per step).
