# Why — Redis atomicity / lost-update lab

## The observable claim we tested
Stock = 100, 500 concurrent buyers. A naive `GET`-then-`SET` buy path sells **more
than 100 units** (oversell). Atomic paths never do. We watched `units_sold` vs the
`units_sold <= 100` invariant.

## What the experiments showed
- **Concurrency is the trigger, not the code.** The *same* naive code run serially
  (Scenario 1) sold exactly 100 and was perfectly correct. Run in parallel
  (Scenario 2) it sold **500** — a 400-unit oversell. The bug lives in the gap
  between `GET` and `SET`, and only concurrency opens that gap.
- **Lost update, made visible.** In the parallel naive run, ~all 500 buyers `GET`
  the same ~100, so ~all 500 `SET` ~99. Last-writer-wins leaves the counter at
  **~97** — it *barely moved* while 400 phantom units sold. The stored number lies.
- **Atomic on the number ≠ correct system.** Unconditional `DECR` (Scenario 3) got
  the *count* right (exactly 100 buyers see `remaining >= 0`) but drove the stored
  counter to **−400**. That pollution burns any second reader: a restock of +400
  lands at 0 (shelf still empty), a "items left" display shows nonsense.
- **The clean fix is one atomic check-and-mutate.** Lua (Scenario 4) reads-and-
  decrements *inside Redis* as one indivisible step. Nothing interleaves: 100 sold,
  counter floors at 0. Correct count AND correct counter, in one round-trip (~56ms).
- **Optimistic locking is correct but can be catastrophically wasteful.**
  `WATCH`/`MULTI` (Scenario 5) also gave 100 sold / stock 0 — by detecting collisions
  at `EXEC` and retrying the losers. On a single hot key that meant **~26K aborted
  transactions and ~1400ms (25× slower than Lua)** to reach the identical result.

## The 2–3 sentences to reproduce cold (interview-ready)
> A read-modify-write across two Redis round-trips (`GET` then `SET`) is not atomic:
> under concurrency, buyers read the same stale value and overwrite each other, so
> decrements are lost and you oversell. The fix is to make the check-and-decrement a
> single atomic operation — a Lua script (or `DECR` with a `>0` guard / floor) — so
> no other client can interleave between the read and the write. `WATCH`/`MULTI`
> optimistic locking is also correct but degrades into a retry storm on a hot key,
> so it fits *low*-contention conflicts, not a flash sale on one counter.

## Parking lot (adjacent gaps — seeds for the NEXT lab, not this one)
- **When IS optimistic locking the right call?** Re-run WATCH/MULTI at *low*
  contention (many keys, rare conflicts) and watch aborts collapse toward 0.
- **`DECR` + rollback** (`DECR`, and `INCR` back if it went negative) vs Lua — does
  the rollback reintroduce a window?
- **Naive race's dependence on timing** — with `DELAY=0`, does the oversell shrink?
  How much does the GET→SET window width matter?
- **Distributed locks (SET NX PX / Redlock)** — a different atomicity concept:
  single-owner critical sections, not counters.
- **Lua caveats** — scripts block the server; effect-based replication; keep them
  fast and deterministic.
