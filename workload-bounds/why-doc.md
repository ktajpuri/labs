# workload-bounds — learning doc

**The claim:** each workload bound (CPU / disk-IO / memory-capacity / network) produces a
distinct signature in vmstat/iostat, nameable in under 10 seconds.
**What the lab showed:** true, but the signatures are NOT the naive ones. The naive model
("the saturated thing reads 100%") failed in every scenario except pure CPU.

## The interview answer (reproduce cold)

> "I look at vmstat and iostat together. **CPU-bound**: user% pinned near 100, run queue ≥ core
> count, everything else quiet. **Disk-bound**: user ~0, processes in the blocked column, device
> busy in iostat — and critically, iowait is a percentage of *total* CPU, so one blocked thread on
> an 8-core box caps it at ~12%; low iowait does NOT clear the disk. **Memory-capacity-bound**:
> sustained si/so swap traffic with the CPU mostly idle — thrashing converts memory ops into disk
> ops, so it's disk-bound in disguise. **Network-bound** is the invisible one: everything in
> vmstat/iostat looks healthy while app throughput is pinned at a ceiling — I diagnose it by
> elimination and confirm with network-side metrics."

## The concepts, one per scenario

### 1. CPU-bound (◑)
- Signature: `us` ≈ 100, `wa`/`si`/`so`/`bo` dead, transition instant and total.
- **`r` counts RUNNABLE processes = running + queued**, not just queued. 8 burners on 8 cores → r=8.
  r ≈ cores means saturated; **r ≫ cores means contention/queueing** — that's the overload signal.

### 2. Disk-IO-bound, fsync-per-write (✗)
- Observed: us≈0, **wa≈10 (not 90)**, %util 70–79 (not 100), ~2,100 writes/sec (not 100s).
- **wa is % of TOTAL CPU capacity.** Max wa = blocked-threads / cores. 1 thread / 8 cores → 12.5% ceiling.
  A completely disk-crippled single-threaded service on a 32-core box shows wa ≈ 3. This is the #1
  real-world vmstat misread.
- Reliable disk-bound tell: `b` > 0 persistently + busy device (w/s, f/s, high-ish %util) + us ≈ 0.
- fsync on NVMe-backed storage ≈ 0.5 ms (not the 10 ms spinning-rust number) → ~2k fsyncs/sec.
- **%util < 100 can still be the bottleneck**: %util = fraction of time ≥1 request in flight;
  a single-threaded sync writer leaves gaps.
- **Write amplification is visible live**: app wrote 8.7 MB/s, device took ~50 MB/s (journal + metadata ≈ 6×).

### 3. CONTROL — same writes, no fsync (◑)
- Naive expectation "disk-bound" is wrong: the **page cache** absorbs writes at memory speed.
- But it's a loan, not a gift. When dirty pages cross `dirty_ratio`, the kernel's
  **writeback throttling (`balance_dirty_pages`) puts the writer to sleep inside write()** until
  flushers drain. Observed: sawtooth 35k ↔ 1.26M writes/sec, one 1-second sample of 28 writes/sec.
- wa hit 37 — above the 12.5% single-thread cap — because **kworker flusher threads** block on the
  device too (b=3: writer + flushers).
- **Sustained average is still disk speed.** Memory sets burst length; the device sets the mean.
  Signature: violent throughput oscillation + us≈0 + giant bo bursts + deep queue (aqu-sz 100s,
  w_await 1–2 s) + intermittent total stalls.

### 4. Memory-capacity-bound (◑)
- 768 MB working set in a 512 MB container + 512 MB swap → survived and thrashed (no OOM-kill,
  because memswap limit gave it headroom).
- **Major-fault movie**: touch swapped page → trap → kernel reads 4 KB from swap ON DISK (~0.1–1 ms)
  → process SLEEPS → often another page must be evicted (written out) first → resume. One byte
  written, one disk round trip paid.
- In-RAM touch ≈ ns; swapped touch ≈ ms → **average collapses ~40×** (1M+ → ~25k touches/sec).
  "Heavy swap traffic" and "memory-speed access" are mutually exclusive — the traffic IS the collapse.
- Fault wait-time lands in **wa (capped again at 12.5%)**, not sy — kernel CPU work for faults is tiny.
- **bi/bo mirror si/so because swap IS disk.** Thrashing = memory ops converted to disk ops.
  Distinguisher vs plain disk-bound: the IO shows in si/so and the process issues no file IO.

### 5. Network-bound (◑)
- iperf3 through 200 mbit tc cap: 190 Mbit/s flat, 0 retransmits — and vmstat read **id 99–100**.
- Sender blocks in send() when the socket buffer fills (flow-control backpressure); **waiting on
  network is counted as plain idle** — vmstat has no network-wait column; wa is disk-only.
- sy would only climb in the *uncapped* case (multi-Gbit through the stack costs real CPU).
- **The invisible bound**: box looks healthy, app pinned at a ceiling. Diagnose by elimination;
  confirm with iperf/iftop/socket stats/retransmits.

### 6. FLIP — fsync on tmpfs (SKIPPED, unverified)
- Expected: tmpfs has no block device → fsync ≈ no-op → same code becomes single-core
  CPU/syscall-bound (us+sy ≈ 12.5% = one core, iostat silent, ~100k+ writes/sec). **Rerun to confirm.**

## Cross-cutting lessons (where predictions systematically missed)

1. **All percentage columns are fractions of total CPU capacity.** Per-thread ceilings:
   1 blocked thread on N cores maxes wa (or one-core us+sy) at 100/N. Directional reads were right
   all session; magnitudes were wrong because of this arithmetic.
2. **Blocked ≠ busy.** Waiting on disk → wa; waiting on network → id; computing → us; kernel work → sy.
   Know where each kind of time lands before naming the bound.
3. **Latency constants matter**: NAND write µs, fsync-round-trip ~0.5 ms, HDD ~10 ms, page fault from
   swap ~0.1–1 ms. Wrong constant → wrong order of magnitude, even with the right model.
4. The two "quiet" bounds (buffered-write throttling, network) are only visible in **application
   throughput + queues**, not CPU columns — instrument the app, not just the box.

## Scorecard

0 ✓ / 4 ◑ / 1 ✗ over 5 run, 1 skipped. Verdict: concept needed the lab — magnitude/attribution
reasoning (wa arithmetic, where wait-time lands) was the systematic gap, now named.

## Parking lot

- **Memory-BANDWIDTH-bound** (cache misses, perf counters, `perf stat`) — explicitly out of scope, next lab candidate.
- Scenario 6 (tmpfs flip) — run it: prediction first, ~10 minutes total.
- Uncapped iperf3 run — watch the "network" workload become CPU/sy-bound at multi-Gbit.
- OOM-kill variant: set memswap_limit = mem_limit and re-run scenario 4 (predict exit code 137).
