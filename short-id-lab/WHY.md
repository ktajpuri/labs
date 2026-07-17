# WHY — short-ID generation: where uniqueness actually lives

**The observable claim this lab made visible:** every short-ID scheme stores its uniqueness guarantee somewhere specific — in a coordination point, in a probabilistic keyspace + check, or in a monotonic clock's structure — and each location has a failure mode you can watch happen and count.

---

## What the experiments showed

Three schemes, walked in order of what each fixes about the last:

### 1. Sequential counter (`aaaaaaa`++) — S1, S2

Uniqueness lives in **one shared counter**. Single-process it is flawless and blindingly fast (10M/s) — a counter cannot collide with itself. Two failures surface the moment you look wider:

- **Enumerability (S1):** the ID *is* the sequence number. One leaked ID (`aaaajMW`) yields the exact next and previous IDs, and reveals total volume issued (37,001). A competitor reads your growth rate off any single short link, and every URL you've ever issued is walkable.
- **Coordination cost (S2):** run 4 uncoordinated generators and each replays the identical sequence — 15,000 duplicates in 20,000 (75%). Fix it with one atomic counter row and uniqueness returns, but every ID now costs a serialized, disk-backed round trip: throughput collapses ~700× (10M/s → 14.6k/s). **The counter's guarantee lives in a single point of coordination, and you pay for it on every ID.**

### 2. Random base62 + collision check — S3, S4, S5

Uniqueness lives in a **huge keyspace** (62⁷ ≈ 3.52 trillion) — no coordination, any server generates independently. But:

- **The birthday bound (S3, the key miss):** collisions do NOT arrive near the keyspace size D. They arrive at **≈ 1.25·√D**. First collision on 7-char landed at draw ~4.5M — not ~10¹³. Mechanism: a collision is *any* pair of draws matching, and after n draws there are ≈ n²/2 pairs, each matching with probability 1/D — so expected collisions ≈ n²/2D, hitting 1 at n ≈ √(2D). **"3.5 trillion IDs" really means "a few million IDs before your first collision."** That is why random short IDs are never shipped without a collision check.
- **The control (S4):** the same bound proves safety too — at 100k draws, n²/2D ≈ 0.14%, so 0 collisions. The failure point is *computable*, not vague.
- **Where the check must live (S5):** a read-then-insert collision check in app code is TOCTOU-broken. Under 50 concurrent inserters the check ran 801 times and *still* admitted 12 duplicates — because the SELECT and the INSERT are two separate round trips, and a concurrent identical candidate lands in the gap. A `UNIQUE` constraint doesn't remove the races (14 retries ≈ the same collisions), it **moves the decision into the write itself**, converting silent corruption into a visible, retryable error. **The check must live where the write is atomic — the database — not in application logic.**

### 3. Snowflake-style structured IDs — S6, S7

Uniqueness lives in the **structure**: `41-bit ms timestamp | 10-bit worker id | 12-bit per-ms sequence`. No coordination, no keyspace gamble, no check.

- **Structure alone works (S6):** 50,000 IDs, zero duplicates, strictly increasing, ~1.9M/s single-worker. The 12-bit sequence caps a worker at **4,096 IDs/ms** — but that's a *theoretical* ceiling; actual wall time (26.8 ms, ~2× the naive 13 ms floor) was set by generator throughput (~1.86M/s → ~1,862/ms, below the ceiling), so most milliseconds never filled. The ceiling is a floor on time; real throughput binds first.
- **The whole thing rests on a monotonic clock (S7):** force the clock 100 ms into the past and the naive generator issues **2,972 duplicates**. Not ~50 (one tick's worth) — the clock stays back, so the generator re-traverses the *entire 100 ms window* it already used, re-issuing every ID in it. The only safe response to `ts < lastTs` is to **stop emitting**: the guard mode stalled 88 ms and issued 0 duplicates. **Snowflake trades a coordination point for a dependency on time moving forward — and NTP steps, VM migration, and leap seconds all violate that.**

---

## The three sentences to reproduce cold

1. **Random base62 + check:** collisions arrive at **≈√(keyspace)**, not near the keyspace, because they accumulate by pairs (n²/2D) — so 62⁷'s 3.5 trillion space collides after only a few million IDs, and the collision check must be enforced atomically at the write (a UNIQUE constraint), never as a read-then-insert in app code, which is TOCTOU-broken under concurrency.
2. **Sequential counters** give perfect uniqueness in one coordination point but leak volume + enumerability and cost a serialized disk round trip per ID; **Snowflake** removes both coordination and the keyspace gamble by encoding `time | worker | sequence` structurally.
3. **Snowflake's uniqueness rests entirely on a monotonic clock:** a backward clock step re-issues every ID in the rolled-over window (not a one-tick blip), so a correct generator refuses to emit while `ts < lastTs`.

---

## Parking-lot items (seeds for future labs, NOT chased here)

- **Multi-worker Snowflake coordination:** this lab used a single hardcoded `workerId=7`. The real distributed problem is *assigning* unique worker IDs across a fleet without collision (ZooKeeper/etcd lease, k8s ordinal, MAC-derived) — a coordination problem the 10 worker-id bits merely *encode*, don't *solve*.
- **The magnitude-intuition gap (the through-line of both misses):** S3 (√D not D) and S7 (whole window not one tick) were both underestimates of how quantities accumulate. A dedicated lab on birthday bound / coupon collector / queue backlog under sustained overload would target the shared root directly.
- **Base-conversion sequential IDs (Flickr/Instagram-style):** a monotonic DB bigint run through base62 *encoding* — hides the raw integer's appearance but NOT its enumerability (still decodable to a sequence). Worth a scenario contrasting "looks random" vs "is unpredictable."
- **Sqlite `database is locked` under WAL + high write concurrency:** surfaced as a harness bug in S5 (fixed with `busy_timeout` + sidecar cleanup), but it's a real adjacent concept — WAL allows concurrent readers but still serializes writers.
