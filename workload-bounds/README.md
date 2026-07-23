# workload-bounds lab

Learning harness: make CPU-bound, disk-IO-bound, memory-capacity-bound, and
network-bound workloads each show their distinct signature in standard Linux
metrics (vmstat / iostat / htop / docker stats).

**macOS note:** Docker Desktop runs containers in a Linux VM. All observation
commands run *inside* containers so you get real Linux `vmstat` / `iostat -x` /
`iowait`. `/proc/stat`, `/proc/vmstat`, `/proc/diskstats` are not namespaced,
so vmstat/iostat from the observer report the **whole VM** — exactly what we want.

## Start

```sh
docker compose up -d --build
```

## Steady-state check (run before every experiment)

```sh
./check.sh
```

Pass = all 6 containers Up; vmstat shows us+sy < 10 and wa ≈ 0 and si/so = 0;
iostat %util ≈ 0; `free -m` shows Swap total > 0 (needed for scenario 4 —
if it's 0, raise swap in Docker Desktop → Settings → Resources).

## Reset to clean state

```sh
docker compose down -v && docker compose up -d --build
```

(`-v` drops the scratch volume so the disk test file is gone too.)

## Observation windows

Open each in its own terminal as instructed per scenario:

```sh
docker compose exec observer vmstat 1        # us/sy/id/wa columns + si/so swap
docker compose exec observer iostat -x 1     # per-device w/s, wMB/s, %util
docker compose exec observer htop            # per-process view of the whole VM
docker stats                                 # per-container CPU/mem
```

## Layout

- `docker-compose.yml` — observer + one container per workload
- `workloads/cpu_burn.py` — tight sha256 loop, one process per core
- `workloads/disk_write.py` — 4K writes; `--fsync` (default) or `--no-fsync`; `--path` picks real disk (`/data`) vs tmpfs (`/ramdata`)
- `workloads/mem_thrash.py` — 768 MB working set inside a 512 MB-limit container
- `workloads/net_transfer.sh` — iperf3 through a 200 mbit tc egress cap
- `failure-matrix.md` — predictions vs observations (the deliverable)
- `why-doc.md` — written at the end
- `RUNBOOK.md` — **rerun the lab solo as a retrieval drill**: per-scenario setup, exact
  commands, predict-first stop lines, answers hidden in collapsed reveal blocks

Exact per-scenario commands are issued in-session: prediction on record first,
then the command. No prediction, no run. To rerun without Claude, use `RUNBOOK.md`.
