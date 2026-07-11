# Why-doc: OS page cache vs Postgres shared_buffers

**Observable claim (from the contract):** a Postgres read that misses
`shared_buffers` but hits the OS page cache is counted by Postgres as a
`read` (a miss) yet is far faster than a true cold-disk read — and each
tier is separately visible (`pg_buffercache` / `fincore`) and separately
evictable (`restart-pg` / `drop-oscache`).

## Failure matrix (predictions verbatim)

| # | Scenario | Prediction (as stated) | Observed | Verdict |
|---|---|---|---|---|
| 1a | Cold scan `big` (both tiers empty) | *none — ran before predicting* | `hit=0 read=32832`, 742 ms | ungraded |
| 1b | Residency after cold scan | "it keeps full in buffer, 32832" (OS: full) | OS cache: 256.5M full; `shared_buffers`: **96 pages** (ring buffer) | partial ✗ |
| 2 | Immediate re-scan `big`, nothing evicted | "shared hit=192, read=32640, execution time = 200ms" | `hit=192 read=32640`, 113.9 ms — 99.4% "miss" rate, 6.5× faster than cold | ✓ |
| 3 | Restart Postgres only, scan `big` | "hit=0, read=32832, 200ms, closer to nothing happened, tier 2 decides" | `hit=0 read=32832`, 135.9 ms | ✓ |
| 4 | Prewarm `small`, drop OS cache, scan both | "fincore shows 19MB, pg 2460 pages; small hit=2460 read=0 fast; big 600ms cold" | fincore: **0B**; pg: 2460 ✓; `small` all-hits 25 ms, no I/O line at all; `big` 512 ms cold | partial |
| 5 | Threshold: cold `small` (19MB < shared_buffers/4) scanned twice | "full 2,460; hit=2460, read=0; 30ms" | 2,460 pages after scan 1; `hit=2460 read=0`, 17.5 ms | ✓ |

**Scorecard: 3 ✓ / 2 partial / 0 fully wrong** (plus one ungraded — scenario 1
ran before a prediction was recorded). Both misses were the same species:
*what a cache layer declines to keep* — the ring buffer refusing to cache a
big scan (1b), and eviction below not caring about copies above (4). Same
pattern as the storage-layout lab, where the misses were failure modes, not
happy paths.

## What the experiments showed

1. **Postgres `read` means "asked the OS", not "went to disk".** The same
   32,832-page scan cost 742 ms cold, 136 ms after a Postgres restart, and
   114 ms warm — with Postgres reporting a ~100% buffer miss in all three.
   Only `track_io_timing` latency (58 µs/page vs 4 µs/page) and `fincore`
   distinguish the tiers. A "buffer hit ratio" dashboard cannot.
2. **Big sequential scans are quarantined, not cached.** A seq scan on a
   table > `shared_buffers`/4 (32MB here) runs in a 256kB ring — 32 buffers
   per process, recycled (96 total across 3 parallel workers). Postgres
   deliberately refuses to remember bulk scans to protect the hot working
   set, and delegates remembering them to the OS page cache. Under the
   threshold, `small` was fully cached by one scan.
3. **The two caches never coordinate — not on fill, not on eviction.**
   Restarting Postgres wiped tier 1, left tier 2 intact (cheap restart).
   `drop_caches` wiped tier 2, left tier 1 intact (scan with zero OS
   interaction). Every combination of hot/cold per tier is reachable.

## Reproduce cold (interview version)

- "Postgres's `read` counter counts requests to the OS, most of which the
  page cache serves in microseconds; hit ratio alone can't tell a healthy
  system from a dying one — you need I/O latency."
- "Seq scans over tables bigger than a quarter of `shared_buffers` use a
  tiny ring buffer to avoid cache pollution; Postgres intentionally
  double-dips on the OS page cache for bulk data, which is also why
  `shared_buffers` is conventionally sized at ~25% of RAM, not 90%."
- "DB restart loses the buffer pool but not the page cache; host reboot
  loses both — that's the difference between a 136 ms and a 742 ms recovery
  in this lab. O_DIRECT engines (Oracle, InnoDB with O_DIRECT) opt out of
  the page cache entirely to stop paying RAM twice."

## Parking lot (seeds for future labs, not chased here)

- Cold reads were only ~5–6× slower than page-cache reads because the
  "disk" is a Docker VM file on a Mac SSD (possibly host-cached). On EBS /
  network storage the gap is 100×+ — the concept scales, the ratio doesn't.
- Double-buffering cost: the same page resident in both tiers; O_DIRECT
  trade-offs and why Postgres still refuses.
- `pg_prewarm` as an operational tool: warming a replica before failover /
  after restart (autoprewarm).
- Queued before this lab and still queued: **partition skew / scaling**.
