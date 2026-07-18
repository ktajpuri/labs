# WHY — Durable Execution (what Temporal is for)

**Observable claim (naive world):** a 3-step order workflow (`reserve → charge → ship`)
built with a persisted `status` field + a supervisor retry double-charges (or loses
in-flight state) when the process crashes between steps.

**The concept:** *durable execution* makes a workflow survive its own process death and
resume exactly where it left off, by recording an append-only **event history** of each
step's result and **replaying** that history on restart instead of trusting in-memory
state or a lagging status column.

---

## Failure matrix

| # | Scenario | Naive observed | Durable predicted | Durable observed | Verdict | Takeaway |
|---|----------|----------------|-------------------|------------------|---------|----------|
| 1 | Crash at a **clean boundary** (status/record already written), then resume | 1 charge, survives | — | — | ✓ (2a) | A crash survives only when the persisted record already reflects the side effect ("status told the truth"). |
| 2 | Crash **between side effect and record** (`charge-side` naive / `charge-recorded` durable), then resume | **2 charges** (status lagged reality) | 1 charge, price/reserve/charge `[replay]` | 1 charge, `[replay]` | ✓ | Naive: side-effect-then-record isn't atomic → status lags → re-charge. Durable: recorded step is skipped on replay. |
| 3 | **Repeated** crash (×3), then finish | **4 charges** (N retries → N dupes) | 1 charge, `[replay]` each time | 1 charge | ✓ | Naive has no idempotency → retries multiply linearly. Durable replays recorded steps → multiplier dead. |
| 4 | **In-flight computed value** (price) across a crash | two charges at **different** prices | (folded into #2: price `[replay]` = 98 both runs) | price replayed identical | ✓ | Naive `status` records position, not computed results → price recomputed differently. Durable records the result → replayed byte-identical. |
| 5 | **BOUNDARY:** crash at `charge-side` (side effect done, NOT yet in history), no idempotency | n/a | **2 charges**, `charge` `[exec]` (no history entry → re-run) | **2 charges**, `[exec]` | ✓ | Durable = **at-least-once** step execution, NOT exactly-once side effects. History didn't record the charge, so replay re-runs it. |
| 5-fix | Same crash + `--idempotent` | n/a | 1 charge (provider dedupes on key) | 1 charge, `[exec]` but no 2nd charge lands | ✓ | Exactly-once side effect = engine's at-least-once **+** idempotent activity (idempotency key). |

---

## What the experiments showed

The naive world persists **position** (`status = RESERVED/CHARGED/...`). Two things kill it:
1. **Position lags the world.** The side effect and the status write are two separate,
   non-atomic writes. A crash between them leaves `status` claiming less than the world
   actually contains → the resume re-runs the already-done step (double charge, S2/S3).
2. **Position isn't state.** Values computed in memory (the price) are gone on crash and
   recomputed differently on resume (S4).

Durable execution replaces "persist position" with "record every step's **result** to an
append-only history, and **replay** — return recorded results, never recompute." On restart
the workflow re-runs from the top; each already-recorded step returns its stored value with
no side effect; only the first unrecorded step actually executes. Completed steps never
re-run; computed values are never lost.

## Reproduce cold in an interview (the 2–3 sentences)

- **Durable execution = event-sourced replay.** The workflow's every step result is
  appended to a durable history; on process restart the workflow function re-runs from the
  top, but each step already in history is **replayed (recorded result returned, side effect
  not re-run)** rather than recomputed, so the workflow deterministically reaches the crash
  point and continues from the first unrecorded step.
- **The naive `status`-column approach fails because the side effect and the status write
  aren't atomic** — a crash between them makes status lag the world, and the retry re-runs
  the completed step; it also only records *which step*, not the *values computed along the
  way*, which are lost on resume.
- **The engine's guarantee is at-least-once, not exactly-once.** A crash in the window
  between "side effect done in the world" and "result written to history" re-runs the step
  on replay. Exactly-once external effects require an **idempotent activity** (idempotency
  key) on top of the engine's at-least-once.

## The boundary — what durable execution does NOT solve

1. **At-least-once side effects (demonstrated, S5).** History is the only thing replay
   trusts; if the world changed but history didn't record it before the crash, the step
   re-runs. The engine cannot reach into the payment provider and know it already charged.
   You must make the activity idempotent.
2. **Non-determinism in workflow (orchestration) code (parking lot — the `--nondeterministic`
   flag demonstrates it).** Replay re-executes the *workflow body*. If the body branches on
   `Math.random()`, `Date.now()`, wall-clock, or map-iteration order **outside** a recorded
   step, replay can take a different path than the original execution → the recorded history
   no longer matches the code's actions → non-determinism error / corruption. This is *the*
   signature Temporal footgun: side effects and non-deterministic reads must live inside
   activities/steps (whose results are recorded), never in orchestration code. The reason
   `price` in this lab is a **step** and not a raw `Math.random()` in the body is exactly this.

## Parking lot (seeds for future labs — do NOT chase now)

- **Non-determinism / replay-safety lab.** Turn the `--nondeterministic` flag into its own
  discovery lab: watch replay diverge, then meet the "all non-determinism goes in an activity"
  rule and versioning/patching as the fix.
- **Timers & long sleeps.** Real durable execution can sleep for days across restarts
  (durable timers). Not covered here.
- **Exactly-once semantics depth.** Idempotency-key design, dedup windows, and where the key
  should be generated (ties to short-id + dist-txn labs).
