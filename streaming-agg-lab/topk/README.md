# Top-K Rollup Lab

**Observable claim:** a key that never appears in ANY minute's top-K list can be the
**#1 key of the hour** — from the same ClickHouse table, a naive merge-of-top-Ks query
omits it while a sum-then-rank query puts it at #1, side by side. **Counts are
mergeable across time windows. Ranks are not.**

This lab reuses the parent `streaming-agg-lab` infra unchanged (Kafka, Flink,
ClickHouse — see `../README.md` for ports and prerequisites). It adds its own topics,
Flink job, table, and scripts so the parent lab's data stays untouched.

Full scope contract, harness design, and the 5 scenarios: [`PLAN.md`](./PLAN.md).
Failure matrix + why-doc land in `WHY.md` once the scenarios are run.

## Data flow

```
topk-produce.js ──▶ Kafka 'events2' ──▶ Flink SQL (1-min TUMBLE COUNT) ──▶ Kafka 'minute-counts' ──▶ topk-sink.js ──▶ ClickHouse lab.minute_counts ◀── topk.js (comparator)
```

Flink does ONE thing: exact per-minute counts per `item_id`. Every top-K question
(30m/1h/1d, correct-vs-naive) is answered later by `query/topk.js` reading those exact
buckets — rollup correctness is a query-time concern here, not a stream-processing one.

## Start (assumes the parent lab's infra is already up — see `../README.md` step 1)

**1. Boot the shared infra** (if not already running):
```bash
docker compose up -d --build
docker compose ps        # wait until kafka is healthy
```

**2. Create this lab's Kafka topics:**
```bash
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic events2 --partitions 3 --replication-factor 1
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic minute-counts --partitions 1 --replication-factor 1
```

**3. Submit the Flink SQL job** (separate job from the parent lab's `aggregate.sql`):
```bash
docker compose exec jobmanager ./bin/sql-client.sh -f /sql/topk-minute.sql
docker compose exec jobmanager ./bin/flink list        # confirm RUNNING
```

**4. Create the ClickHouse table** (already appended to `clickhouse/init.sql` — only
needed manually if your ClickHouse volume predates this lab):
```bash
docker compose exec clickhouse clickhouse-client --query "
CREATE TABLE IF NOT EXISTS lab.minute_counts (
  window_start DateTime64(3), window_end DateTime64(3), item_id String, cnt UInt64,
  inserted_at DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY (window_start, item_id)"
```

**5. Start the sink** (own terminal — leave it running):
```bash
npm run topk:sink
```

**6. Run the producer for a scenario** (own terminal):
```bash
npm run topk:produce -- --scenario zipf --minutes 5
```

---

## Steady-state check (run this FIRST, before any scenario)

```bash
npm run topk:produce -- --scenario zipf --minutes 5
# wait ~10s for the final window to flush and the sink to insert it
npm run topk:query -- --window 1m --k 12
```

Expect: the single latest 1-minute bucket's ranking matches the producer's own
GROUND TRUTH printout for that minute exactly (1-minute buckets are exact — no rollup
involved yet), and no `rows>1` dedup warning. If that matches, the pipeline breathes
and you're ready for the scenarios in `PLAN.md` section 3.

## Reset between scenarios (required — read this before S2)

Each scenario's synthetic timeline is anchored to a **fixed** epoch, not to
real "now" (`zipf`=2020-01-01, `sleeper`=2020-01-11, `burst`=2020-01-21,
`retain`=2020-01-31 — see `producer/topk-produce.js`). This makes every run's
window boundaries deterministic. The consequence: Flink's watermark only
moves **forward**, so **restart the Flink job before every new scenario** —
if you re-run the producer against a job whose watermark has already passed
that scenario's epoch (e.g. from a previous scenario or a previous run), all
of its events are silently dropped as late and no window ever fires.

```bash
docker compose exec jobmanager ./bin/flink list                              # copy the Job ID
docker compose exec jobmanager ./bin/flink cancel <JOB_ID>
docker compose exec jobmanager ./bin/sql-client.sh -f /sql/topk-minute.sql    # fresh job, watermark reset
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE lab.minute_counts"
```

Re-running the **same** scenario without restarting the job is safe (window
boundaries repeat exactly; a stray late write just duplicates a row, visible
as the `rows>1` warning) — but always truncate before trusting a new run's
totals.

### Gotchas already found and fixed (don't rediscover these)

- **Idle-partition watermark stall.** `events2` has 3 partitions; a scenario
  minute's ~11 keys can easily hash so that one partition gets no new message
  for several minutes. Flink's watermark is the MIN across partitions, so
  that one quiet partition can stall it forever and no window fires — even
  with `'table.exec.source.idle-timeout' = '3s'` set (the parent lab's fix
  for this exact class of bug didn't reliably apply here). Fixed in the
  producer: every synthetic minute (and the final flush) explicitly sends one
  heartbeat message to **every** partition (bypassing the key hash), so no
  partition can ever go idle. If you see windows stop firing partway through
  a run, check this first — it's almost certainly a reintroduced idle
  partition, not a Flink issue.
- **Off-by-one range boundary.** The comparator's window range must use
  `window_start >= start` (inclusive), not `>`. With `>`, the earliest bucket
  in range (which sits exactly on the boundary) gets silently excluded —
  this is invisible for multi-bucket windows (just one bucket's data missing
  from a big sum) but breaks `--window 1m` outright (0 buckets scanned).

## Full reset

```bash
docker compose down -v
docker compose up -d --build
# then redo steps 2–5 above (and re-run parent lab steps if you need that pipeline too)
```

## Grafana dashboard

```bash
docker compose up -d grafana      # if not already running
# open http://localhost:3000/d/topk-lab/top-k-rollup-lab
```

**"Top-K Rollup Lab"** — auto-provisioned (`grafana/dashboards/topk.json`), no login.
Three controls at the top mirror `query/topk.js`'s CLI flags exactly:

| Control | Maps to |
|---|---|
| **Window** (1m / 30m / 1h / 1d) | `--window` |
| **K** | `--k` |
| **Retain (K')** | `--retain` |

Panels: a raw per-minute events timeseries (sanity check — whatever scenario is
currently loaded shows up as a block of activity on its own fixed date, see the
epoch table in the reset section above), **CORRECT top-K** and **NAIVE top-K** tables
side by side (same headline comparison as the CLI, just always-on and interactive),
and two stat tiles tracking `sleeper` specifically (its correct rank, and its NAIVE
total — 0 means invisible to the naive merge). The dashboard's time-range picker is
cosmetic here — every panel computes its own "trailing $Window from the latest loaded
data" independent of it, since the data isn't live/now-anchored (see the fixed-epoch
note above). No `--tiered` equivalent panel; run that comparison via the CLI.

## Introspection

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
  --topic minute-counts --from-beginning --max-messages 5
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group flink-topk
```
