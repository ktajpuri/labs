# workload-bounds — RUNBOOK

Self-contained rerun of the lab as a **retrieval drill**. No chat history needed.

**The claim under test:** each workload bound (CPU / disk-IO / memory-capacity / network)
produces a distinct signature in `vmstat` / `iostat`, nameable in under 10 seconds.

**How to use this:** for each scenario, read the setup, run the commands, and **write your
prediction down before opening the Reveal block**. The reveals contain the observed numbers
from the 2026-07-12 session plus the mechanism. Predicting is the whole point — reading the
reveals without predicting first teaches nothing.

---

## Prerequisites

- Docker Desktop running (macOS: containers run in a Linux VM — that's why every observation
  command runs *inside* a container, so you get real Linux `vmstat` / `iostat -x` / `iowait`).
- Swap enabled in the VM (scenario 4 needs it). `free -m` must show `Swap total > 0`.
  If it's 0: Docker Desktop → Settings → Resources → raise swap.
- 3 terminal windows (workload / vmstat / iostat).

### Start

```sh
cd labs/workload-bounds
docker compose up -d --build
```

### Reset to clean state (between scenarios, and any time results look contaminated)

```sh
docker compose down -v && docker compose up -d --build
```

`-v` drops the `scratch` volume so the disk test file is gone too.

### Steady-state check — run before EVERY scenario

```sh
./check.sh
```

Pass = all 6 containers `Up`; `vmstat` shows `us+sy < 10`, `wa ≈ 0`, `si/so = 0`;
`iostat` `%util ≈ 0`; `free -m` shows swap available.

### Know your core count first — the whole lab's arithmetic depends on it

```sh
docker compose exec observer nproc
```

The session ran on **8 cores**. Every percentage ceiling below (`12.5%`) is `100 / nproc`.
If your `nproc` differs, recompute before predicting — that recomputation *is* the lesson.

### Observation windows (open in separate terminals as each scenario instructs)

```sh
docker compose exec observer vmstat 1        # us/sy/id/wa, r, b, si/so, bi/bo
docker compose exec observer iostat -x 1     # per-device w/s, f/s, wMB/s, aqu-sz, w_await, %util
docker compose exec observer htop            # per-process view of the whole VM
docker stats                                 # per-container CPU/mem
```

Stop any workload with `Ctrl-C` in its terminal.

---

## Scenario 1 — CPU-bound baseline

**Setup:** tight sha256 loop, one process per core. No IO, no allocation.

Terminal A:
```sh
docker compose exec observer vmstat 1
```
Terminal B:
```sh
docker compose exec cpu python /workloads/cpu_burn.py
```

**Predict:** (1) `us` %, (2) `sy` and `wa` %, (3) the `r` column value.

> **STOP — write your prediction before scrolling.**

<details><summary>Reveal</summary>

**Observed:** `us=100`, `sy=0`, `wa=0`, **`r=8`** steady for the entire burn.

**Mechanism:** the transition is instant and total — `wa`/`si`/`so`/`bo` stay dead.

The trap is the `r` column: **`r` counts RUNNABLE processes = currently running + queued**,
not just the ones waiting for a CPU. 8 burners on 8 cores → `r=8`, with nothing queued.

- `r ≈ cores` → saturated, no contention.
- `r ≫ cores` → contention/queueing. *That* is the overload signal, not `r > 0`.

Session verdict: ◑ partial (predicted `r=0`).
</details>

---

## Scenario 2 — Disk-IO-bound (fsync per write, real block device)

**Setup:** sequential 4 KB writes to a file on a named volume (real ext4 on the VM's block
device), with `fsync()` after **every** write — each write must physically reach the device.

Terminal A:
```sh
docker compose exec observer vmstat 1
```
Terminal B:
```sh
docker compose exec observer iostat -x 1
```
Terminal C:
```sh
docker compose exec disk python /workloads/disk_write.py
```

**Predict:** (1) `us` %, (2) `wa` %, (3) device `%util`, (4) writes/sec — and say what sets it.

> **STOP — write your prediction before scrolling.**

<details><summary>Reveal</summary>

**Observed:** `us ≈ 0`, **`wa ≈ 10` (not 90)**, `%util 70–79` (not 100), **~2,100 writes/sec**.
Also: `b=1` persistently, `f/s ≈ 4300`, and **6× write amplification** — the app wrote
8.7 MB/s while the device took ~50 MB/s (journal + metadata).

**Mechanism — three separate misreads to fix:**

1. **`wa` is a percentage of TOTAL CPU capacity, not of the blocked process.**
   Max `wa` = blocked-threads / cores. One thread on 8 cores → **12.5% ceiling**.
   A completely disk-crippled single-threaded service on a 32-core box shows `wa ≈ 3`.
   **Low iowait does NOT clear the disk.** This is the #1 real-world vmstat misread.
   The reliable disk-bound tell is: `b > 0` persistently **+** busy device **+** `us ≈ 0`.

2. **`%util < 100` can still be the bottleneck.** `%util` = fraction of time with ≥1 request
   in flight. A single-threaded synchronous writer leaves gaps between completing one fsync
   and issuing the next — the device is the constraint anyway.

3. **Latency constant:** fsync on NVMe-backed storage ≈ **0.5 ms**, not the 10 ms
   spinning-rust number → ~2k fsyncs/sec, not ~100. Wrong constant → wrong order of
   magnitude even with the right model.

Session verdict: ✗ (predicted `us 5 / wa 90 / %util 100 / ~100 writes-per-sec`).
</details>

---

## Scenario 3 — CONTROL: same writes, no fsync

**Setup:** identical code path, `fsync()` removed. Naive expectation is "still disk-bound".

Same three terminals; workload becomes:
```sh
docker compose exec disk python /workloads/disk_write.py --no-fsync
```

Let it run **at least 60–90 seconds** — the interesting behavior only appears after the page
cache fills.

**Predict:** (1) writes/sec, (2) `us` and `wa`, (3) the shape of the throughput over time
(flat? bursty?), (4) what the limiting resource actually is.

> **STOP — write your prediction before scrolling.**

<details><summary>Reveal</summary>

**Observed:** rate **sawtoothed between 35k and 1.26M writes/sec** — one 1-second sample read
**28 writes/sec**. `us ≈ 0`. `wa` started at 0, then hit **30–37** later in the run with `b=3`.
`iostat`: vda writeback 126–500 MB/s, `aqu-sz` in the hundreds, `w_await` 1–2 **seconds**.

**Mechanism:** the **page cache** absorbs writes at memory speed — that's the burst.
But it's a loan, not a gift. When dirty pages cross `dirty_ratio`, the kernel's writeback
throttling (`balance_dirty_pages`) **puts the writer to sleep inside `write()`** until the
flusher threads drain to the device. Hence the sawtooth, and the total stalls.

Two details worth keeping:
- **`wa` hit 37, above the 12.5% single-thread cap**, because the kworker flusher threads
  block on the device too — `b=3` (writer + flushers). The cap is per *blocked thread*, and
  the kernel added threads.
- **The sustained average is still disk speed.** Memory sets the burst *length*; the device
  sets the *mean*. "Buffered writes made it memory-bound" is only true over short windows.

Signature to recognize: violent throughput oscillation + `us ≈ 0` + giant `bo` bursts +
deep queue (`aqu-sz` in the 100s, `w_await` seconds) + intermittent total stalls.

Session verdict: ◑ partial (rate and shape right, missed that the sustained mean stays
disk-bound and that `wa` could exceed the single-thread cap).
</details>

---

## Scenario 4 — Memory-capacity-bound (thrashing)

**Setup:** 768 MB working set inside a container capped at **512 MB RAM + 512 MB swap**
(`mem_limit: 512m`, `memswap_limit: 1g`), touching random pages forever. ~256 MB must live
in swap at any moment. Allocation takes ~30–60 s before the thrash phase starts.

Terminal A:
```sh
docker compose exec observer vmstat 1
```
Terminal B:
```sh
docker compose exec mem python /workloads/mem_thrash.py
```

**Predict:** (1) does it survive or get OOM-killed, (2) `si`/`so` KB/s, (3) page-touches/sec,
(4) which CPU column absorbs the time and how much.

> **STOP — write your prediction before scrolling.**

<details><summary>Reveal</summary>

**Observed:** survived and thrashed (no OOM-kill). `si`/`so` sustained **26–38k KB/s**,
`swpd ≈ 270 MB`. Touches **~20–30k/sec**. CPU: `us 0`, `sy 1–2`, `id 88`, **`wa 10–11`**.
`bi`/`bo` mirrored `si`/`so`.

**Mechanism — the major-fault movie:** touch a swapped-out page → trap → the kernel reads
4 KB from swap **on disk** (~0.1–1 ms) → **the process sleeps** → often another page must be
evicted (written out) first → resume. One byte written, one disk round trip paid.

Three keepers:
- In-RAM touch ≈ nanoseconds; swapped touch ≈ milliseconds → the average **collapses ~40×**
  (1M+ → ~25k touches/sec). "Heavy swap traffic" and "memory-speed access" are mutually
  exclusive — **the traffic IS the collapse**. (The session's prediction of high si/so *and*
  a high touch rate was internally contradictory.)
- Fault wait-time lands in **`wa`** — capped at 12.5% again — **not `sy`**. The kernel's CPU
  work per fault is tiny; it's the disk read that costs.
- **`bi`/`bo` mirror `si`/`so` because swap IS disk.** Thrashing converts memory operations
  into disk operations — it's disk-bound in disguise. Distinguisher vs plain disk-bound:
  the IO shows up in `si`/`so` and the process issues no file IO of its own.

No OOM-kill because `memswap_limit` (1g) gave 512 MB of headroom above `mem_limit` (512m).

Session verdict: ◑ partial (survival and si/so right; touch rate, time-column, and the
internal contradiction were the misses).
</details>

---

## Scenario 5 — Network-bound

**Setup:** bulk iperf3 transfer to `net-server` through a **200 mbit tc tbf egress cap**.
The qdisc IS the "link" being saturated — container-to-container traffic on one host would
otherwise run at memory-bus speed and the bottleneck would be CPU, not the network.

Terminal A:
```sh
docker compose exec observer vmstat 1
```
Terminal B:
```sh
docker compose exec observer iostat -x 1
```
Terminal C:
```sh
docker compose exec -e RATE=200mbit -e DURATION=30 net-client sh /workloads/net_transfer.sh
```

**Predict:** (1) throughput iperf3 reports, (2) which CPU column carries the time and how
much, (3) what `iostat` shows.

> **STOP — write your prediction before scrolling.**

<details><summary>Reveal</summary>

**Observed:** 190 Mbit/s flat, **0 retransmits**. `vmstat`: `us 0–2`, `sy 0–2`,
**`id 99–100`**, `wa 0`. `iostat`: silent.

**Mechanism:** the sender blocks in `send()` when the socket buffer fills (flow-control
backpressure). **Waiting on the network is counted as plain idle** — `vmstat` has no
network-wait column, and `wa` is **disk-only**. So the box looks *healthy* while the app is
pinned at a ceiling.

`sy` would only climb in the **uncapped** case, where pushing multi-Gbit through the stack
costs real kernel CPU. At 200 mbit there's nothing to pay for.

**This is the invisible bound.** You cannot diagnose it from CPU columns — you diagnose it
**by elimination** (CPU quiet, disk quiet, app throughput flat at a suspiciously round
number) and confirm with network-side metrics: iperf3, iftop, socket stats, retransmit counts.

Session verdict: ◑ partial (throughput right; predicted `sy 100` — the time is in `id`).
</details>

---

## Scenario 6 — CONFIG-BOUNDARY FLIP: fsync on tmpfs

> **Never run in the original session** (it ended first). The reveal below is the *expected*
> result, unverified. Run it, predict first, and **correct the reveal from what you actually
> see** — then update `failure-matrix.md` row 6 and `why-doc.md` §6.

**Setup:** byte-for-byte the same command as scenario 2 — fsync after every write — but the
file lives on a **tmpfs mount** (`/ramdata`, 1200m, declared in `docker-compose.yml`) instead
of the block-device volume. Only the path changes.

Terminal A:
```sh
docker compose exec observer vmstat 1
```
Terminal B:
```sh
docker compose exec observer iostat -x 1
```
Terminal C:
```sh
docker compose exec disk python /workloads/disk_write.py --path /ramdata/testfile
```

**Predict:** (1) writes/sec vs scenario 2's 2,100, (2) `us`, `sy`, `wa`, (3) `iostat` `%util`,
(4) name the bound.

> **STOP — write your prediction before scrolling.**

<details><summary>Reveal (EXPECTED — unverified, confirm or correct it)</summary>

**Expected:** tmpfs has no backing block device, so `fsync()` is effectively a **no-op**.
The same code becomes **single-core CPU/syscall-bound**: `us+sy ≈ 12.5%` (= one core of
eight, split between userspace loop and `write()` syscall time), `wa ≈ 0`, `iostat` silent,
~100k+ writes/sec.

**Why it's the boundary scenario:** identical application code, identical syscall sequence —
only the *storage medium under the mount point* changed, and the bound moved from disk to
CPU. Durability is what costs; the code doesn't know the difference. This is the config
threshold the whole lab lives in.
</details>

---

## Teardown

```sh
docker compose down -v
```

---

## The interview answer (reproduce cold, before checking)

<details><summary>Reveal</summary>

> "I look at vmstat and iostat together. **CPU-bound**: user% pinned near 100, run queue ≥ core
> count, everything else quiet. **Disk-bound**: user ~0, processes in the blocked column, device
> busy in iostat — and critically, iowait is a percentage of *total* CPU, so one blocked thread on
> an 8-core box caps it at ~12%; low iowait does NOT clear the disk. **Memory-capacity-bound**:
> sustained si/so swap traffic with the CPU mostly idle — thrashing converts memory ops into disk
> ops, so it's disk-bound in disguise. **Network-bound** is the invisible one: everything in
> vmstat/iostat looks healthy while app throughput is pinned at a ceiling — I diagnose it by
> elimination and confirm with network-side metrics."

**The four cross-cutting lessons** (these were the systematic misses, 0✓/4◑/1✗):

1. **All percentage columns are fractions of total CPU capacity.** 1 blocked thread on N cores
   caps `wa` (or one-core `us+sy`) at `100/N`. Directional reads were right all session;
   magnitudes were wrong because of this arithmetic.
2. **Blocked ≠ busy.** Disk wait → `wa`. Network wait → `id`. Computing → `us`. Kernel work →
   `sy`. Know where each kind of time lands before naming the bound.
3. **Latency constants matter**: NAND write µs, fsync round trip ~0.5 ms, HDD seek ~10 ms,
   swap-in page fault ~0.1–1 ms. Wrong constant → wrong order of magnitude.
4. The two "quiet" bounds (buffered-write throttling, network) are visible only in **application
   throughput and queue depth**, not CPU columns. Instrument the app, not just the box.
</details>

---

## Parking lot (NOT part of this runbook — future labs)

- **Memory-BANDWIDTH-bound** (cache misses, `perf stat`) — explicitly out of scope, next lab candidate.
- Uncapped iperf3 run — watch the "network" workload become CPU/`sy`-bound at multi-Gbit.
- OOM-kill variant: set `memswap_limit` = `mem_limit` in `docker-compose.yml` and rerun
  scenario 4 (predict exit code 137).
