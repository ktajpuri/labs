# Page-cache / buffer-pool lab

**Concept:** a database read is served from one of three stacked tiers —
Postgres `shared_buffers`, the OS page cache, or real disk. Two independent
caches, separate accounting, separate eviction.

**Observable claim:** a read that misses `shared_buffers` but hits the OS
page cache is counted by Postgres as a `read` (a miss!) yet is orders of
magnitude faster than a true cold-disk read. We watch pages move through the
tiers by evicting each cache independently.

## The three tiers and how each is observed

| Tier | Evicted by | Observed via |
|---|---|---|
| 1. `shared_buffers` (128MB here) | `./lab.sh restart-pg` | `pg_buffercache` (in `status`), `shared hit=` in `scan` |
| 2. OS page cache (Docker VM kernel) | `./lab.sh drop-oscache` | `fincore` on the data files (in `status`) |
| 3. Disk | — | what's left: `read=` count + `I/O Timings` + wall clock in `scan` |

Key trap: Postgres's `read=N` counter means "asked the OS for N pages". It
**cannot distinguish** page-cache hits from disk reads — only latency and
`fincore` can.

## Start / verify steady state

```sh
./lab.sh up      # build + start (privileged container; needed for drop_caches)
./lab.sh seed    # big ≈ 250MB (> shared_buffers), small ≈ 19MB (< shared_buffers/4)
./lab.sh status  # both cache tiers, per table
./lab.sh scan big
```

Steady state is verified when `status` shows nonzero numbers in both tiers
and `scan big` prints a plan with `Buffers: shared hit=… read=…` plus
`I/O Timings`.

## Reset to clean

```sh
./lab.sh cold    # both caches emptied, data intact — start of most scenarios
./lab.sh reset   # nuke containers + volume; re-run up + seed
```

## Notes / caveats

- macOS: Postgres runs in Docker's Linux VM; the "OS page cache" here is the
  VM kernel's, which is the real thing as far as Postgres is concerned.
  `drop-oscache` drops the whole VM's page cache.
- `shared_buffers=128MB` and `track_io_timing=on` are set in the compose file.
- Sequential scans of tables larger than `shared_buffers/4` (32MB here) use a
  small ring buffer — relevant to the experiments, left unexplained here on
  purpose.
