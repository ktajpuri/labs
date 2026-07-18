# Temporal / Durable-Execution Lab

**Concept:** durable execution — a multi-step workflow survives the crash of its
own process and resumes *exactly where it left off*, without re-running completed
steps or losing in-flight state.

**Mode:** DISCOVERY. We first build and break the NAIVE version (a `status` field +
a supervisor retry). Then durable execution arrives as the fix (an append-only
event history + deterministic replay).

**The claim to watch:** a 3-step order workflow (`reserve → charge → ship`) built
with application-level state + retries leaves the world **inconsistent or
duplicated** when the process crashes between steps — the payment `charge` counter
goes to 2.

## Files
- `lib/world.js` — the external world (inventory, charges, shipments). Durable JSON. Side effects append here, so duplicates are visible.
- `naive/run.js` — the naive workflow + crash injection.
- `report.js` — prints the world's numbers (charges per order; flags double charges).
- `reset.js` — reset to clean state.
- `durable/` — the fixed version (built in Phase 2b, not yet).

## Reset to clean
```
node reset.js
```

## Observe steady state (do this first, before any crash)
```
node reset.js
node naive/run.js order-1
node report.js
```
Expected: order-1 runs reserve → charge → ship once. Report shows
`charges: 1`, `1 charge, total $<70-100>`, inventory 99. No double charge.

## Inject a crash
```
node naive/run.js order-2 --crash-after=charge-side   # dies mid-flight
node naive/run.js order-2                              # supervisor re-runs it
node report.js
```
Crash points: `reserve-side`, `reserve-status`, `charge-side`, `charge-status`, `ship-side`.

## The durable version (Phase 2b — the fix)
`durable/engine.js` is a hand-rolled minimal durable-execution engine (~40 lines):
an append-only event **history** + **replay**. Workflow code calls `ctx.step(name, fn)`;
each step's result is recorded after it runs; on restart the workflow re-runs from the
top and every already-recorded step is **replayed** (recorded result returned, side
effect NOT re-run) until the first unrecorded step, which executes.

```
node reset.js
node durable/run.js order-1            # happy path
node durable/run.js order-1 --crash-after=charge-recorded   # crash AFTER record
node durable/run.js order-1                                 # resume -> replays, 1 charge
node report.js
```
Durable crash points: `<step>-side` (side effect done, result NOT yet in history —
the at-least-once window) and `<step>-recorded` (result durably in history — clean).
Flags: `--idempotent` (charge dedupes on a key — closes the at-least-once gap),
`--nondeterministic` (a branch in orchestration code from raw Math.random() — the
replay-determinism boundary).

