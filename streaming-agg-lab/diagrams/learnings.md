# Session Learnings — Streaming Aggregation Failure Lab

**Date:** 2026-07-08 · **Concept:** *Can I trust a streaming aggregate — and what makes it wrong vs right?* **Format:** predict → run → compare, driven hands-on. Full evidence in [`WHY.md`](https://github.com/ktajpuri/labs/blob/main/streaming-agg-lab/WHY.md).

---

## TL;DR (one-screen refresh)

We built a real streaming-aggregation pipeline (Kafka → Flink SQL → Kafka → ClickHouse) and deliberately broke it 5 ways. What we proved:

- **Late data** is *dropped, not counted* once the watermark closes a window — silently. Widening the watermark delay counts it, but costs **freshness** (window publishes later). The watermark is a **completeness ↔ latency dial**.
- **Crashes:** no checkpoint → **loss**; checkpoint + naive sink → **duplicates** (at-least-once); checkpoint + **idempotent sink** → **correct** (exactly-once). Checkpointing protects Flink's state, *not* the sink.
- **Backpressure** is a **freshness** failure, not a correctness one — events buffer in Kafka, counts stay exact, results just publish late (and recover). Watch for **partition skew**: one hot partition caps throughput.
- **Scorecard: 5/5 scenarios correct on mechanism** (2 predictions imperfect — both where reality was *more* subtle than intuition).

---

## The system

![Diagram 1: Kafka to Flink SQL to Kafka to ClickHouse pipeline](./diagrams/pipeline.svg)

Everything between the two Kafka topics is **Flink (JVM)** — in the real world the aggregation tier is always JVM (Flink/Spark/Kafka-Streams), separate from your app code. Everything else is Node/CLI we could read line by line. Output loops **back through Kafka** before the sink — the real production pattern (gives a second topic + consumer group to observe).

| Component                    | Role                                  | Why it's here                                                 |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| **Kafka** (KRaft, 1 broker)  | durable event log + result bus        | the muscle-memory tool; topics/partitions/consumer-groups/lag |
| **Flink SQL**                | the stream processor (windowed count) | windows + watermarks are *explicit* in ~15 lines of SQL       |
| **ClickHouse**               | OLAP sink (queryable aggregate)       | plain `MergeTree` = appends, so duplicates are *visible*      |
| **Node** producer/sink/query | everything inspectable                | read every line; JS by preference                             |

---

## The two things that corrupt correctness

### Axis 1 — late data & watermarks

![Diagram 2: late data and watermark decision flow](./diagrams/late-data-watermarks.svg)

- A window fires when `watermark = max(event_time) − delay` passes the window end.
- Late records are **dropped by default** in Flink's windowing TVF — they never touch the OLAP store, and the only signal is `numLateRecordsDropped` (which itself *under-reports*, counting dropped **partials**, not raw events).
- A within-tolerance late event **delays publishing**, it does **not** revise a published number (`rows` stays 1 — withheld, then emitted once, final).

### Axis 2 — crashes & exactly-once

![Diagram 3: crash recovery and exactly-once decision flow](./diagrams/crashes-exactly-once.svg)

- **Checkpointing = at-least-once, not exactly-once.** It rewinds the source and restores state (no loss), but replayed windows get re-emitted.
- **Exactly-once at the store = checkpointing + idempotent sink** (dedupe on a *canonical* key, or upsert / `ReplacingMergeTree` / transactional 2-phase-commit).
- Idempotency is only as good as its **key** — a `…30.000` vs `…30` timestamp-format mismatch silently defeated dedupe *and* hid from `rows>1` checks.

### Backpressure (the freshness axis)

![Diagram 4: backpressure and consumer lag flow](./diagrams/backpressure.svg)

---

## Scenarios & takeaways

| #  | We did                                | Learned                                                                         |
| --- | -------------------------------------- | --------------------------------------------------------------------------------- |
| 1  | Injected 10 events 25s in the past    | Late → dropped & silently lost; drop metric under-reports (counts partials)     |
| 2  | Flipped watermark delay 2s → 30s      | Same event now counted; cost = **latency** (window queryable 30s after it ends) |
| 3  | Restart with **no** checkpointing     | ~4 windows lost per restart + partial boundary window; **loss ∝ downtime**      |
| 4a | Restart, checkpoint + naive sink      | No loss, but **duplicate** window (rows=2) — at-least-once, not exactly-once    |
| 4b | Restart, checkpoint + `--dedupe` sink | `DUP SKIPPED` — correct; surfaced the **canonical-key** bug                     |
| 5  | Blast producer >> Flink               | Lag unbounded, freshness ~9min behind, counts stay correct, recovers on stop    |

---

## Gotchas discovered (the war stories)

- **Idle-partition watermark stall** — 4 keys hashed onto 2 of 3 partitions; the empty partition pinned the event-time watermark at −∞ and *no window ever fired*. Fixed with `table.exec.source.idle-timeout`.
- **ClickHouse `default` user is localhost-only** in the image → Node HTTP auth failed. Fixed by provisioning an app user (`lab`) with `CLICKHOUSE_USER/PASSWORD/DB`.
- **Flink SQL client counts quotes/`;` inside `--` comments** — an apostrophe in a comment ("don't") fused statements → `only single statement supported`. Keep `SET` blocks apostrophe-free.
- **`numLateRecordsDropped` under-reports** — local pre-aggregation combines same-window/same-key events, so 10 late events register as 1 dropped partial.
- **Canonical idempotency keys** — timestamp format (`.000`) silently broke dedup *and* naive duplicate detection.
- **Emulation** — Flink runs amd64 under Rosetta on this Mac; a killed TaskManager reboots slowly, so the restart strategy needs many attempts or the job terminally fails.

---

## Tools & commands cheat-sheet

```
# --- Kafka (muscle memory) ---
kafka-topics.sh --create --topic events --partitions 3 --replication-factor 1
kafka-topics.sh --list
kafka-consumer-groups.sh --describe --group flink-agg      # <-- LAG column
kafka-get-offsets.sh --topic events                        # per-partition offsets
kafka-console-consumer.sh --topic agg-results --from-beginning --max-messages 5

# --- Flink ---
./bin/sql-client.sh -f /sql/aggregate.sql                  # submit a job
./bin/flink list                                           # RUNNING jobs
./bin/flink cancel <JOB_ID>

# --- ClickHouse ---
clickhouse-client --query "SELECT ... FROM lab.aggregates"
clickhouse-client --query "TRUNCATE TABLE lab.aggregates"

# --- crash / load injection (this lab's harness) ---
docker compose kill taskmanager && docker compose start taskmanager   # crash Flink worker
npm run inject-late  -- --count 10 --type page_view --age 25          # late events
npm run inject-dup   -- --type page_view                             # duplicate agg-result
npm run blast        -- --batch 1000                                # backpressure firehose
npm run flink-metrics                                               # watermark + drops
```

| Flink SQL knob                                                 | Effect                                      |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `WATERMARK FOR event_time AS event_time - INTERVAL 'N' SECOND` | lateness tolerance ↔ freshness dial         |
| `table.exec.source.idle-timeout`                               | stop idle partitions stalling the watermark |
| `execution.checkpointing.interval`                             | fault tolerance (no-loss recovery)          |
| `restart-strategy.*`                                           | auto-recover after a crash                  |

---

## Harness files

| File                                                     | Purpose                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `docker-compose.yml`                                     | Kafka (KRaft) + Flink jobmanager/taskmanager + ClickHouse |
| `flink/aggregate.sql`                                    | base job (2s watermark)                                   |
| `flink/aggregate-late-tolerant.sql`                      | 30s watermark variant (scenario 2)                        |
| `flink/aggregate-checkpointed.sql`                       | checkpoint + auto-restart (scenario 4)                    |
| `producer/produce.js`                                    | steady producer + ground-truth counter                    |
| `producer/inject-late.js` · `inject-dup.js` · `blast.js` | failure injectors                                         |
| `sink/consume.js`                                        | Kafka → ClickHouse (`--dedupe` = idempotent)              |
| `query/query.js` · `flink-metrics.js`                    | OLAP dashboard · watermark/drop metrics                   |
| `README.md` · `WHY.md`                                   | run guide · failure matrix + why-doc                      |

---

## Next lab (parking lot, top pick)

**Partition skew & scaling streaming aggregation** — surfaced by the scenario-5 question. Keying by a low-cardinality field concentrates load on one hot partition; a consumer group's parallelism is capped by partition count *and* by the hottest partition. Levers: high-cardinality partition key, more partitions + parallelism, two-phase pre-aggregation, provision ≥ peak.

---

## Concepts appendix (the "wait, what exactly is…" answers)

### Watermark delay & when a window closes

A **watermark** is Flink's clock for *event time*: `watermark = (max event_time seen) − delay`. It's a promise — "I've now seen every event with `event_time` ≤ this." The **delay** (the `- INTERVAL '2' SECOND` in the DDL) is your tolerance for out-of-order arrival: how long to wait for stragglers before declaring a moment complete.

A window fires when the **watermark** passes its end (not when wall-clock does):

```
                      window  [00:10  →  00:20)
event time ───┬────────────────────────────┬──────────┬────────►
            00:10                         00:20      00:22
           (start)                        (end)    watermark
                                                   reaches 00:20
• events land between 00:10 and 00:20
• at 00:20 the window ENDS but does NOT emit — it waits `delay` (2s)
• when a live event with event_time ≥ 00:22 arrives, watermark
  (= newest event_time − 2s) crosses 00:20 → window FIRES
• queryable ~2s after it ended, ~12s after it started
```

```
watermark                = (max event_time seen) − delay
window [T, T+size) fires   when max_event_time ≥ T + size + delay
freshness (newest window)  ≈ now − (size + delay)
```

So the ~15–20s Grafana "freshness" baseline is **not lag** — it's `size(10s) + delay(2s)`; the window physically can't publish sooner. Bigger `delay` → fewer late-drops but staler results (the completeness ↔ freshness dial from Scenario 2).

### JobManager vs TaskManager (and why killing the TM recovers the job)

| JobManager (JM)                                                                                                             | TaskManager (TM)                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| coordinator / brain                                                                                                          | worker / executor                                                                                  |
| schedules tasks, triggers checkpoints, detects failures, **orchestrates recovery**, holds job metadata + checkpoint pointer | provides **task slots**, runs the operators (source/window/sink), **holds in-flight window state** |
| one active (HA adds standbys)                                                                                               | many — more TMs = more parallelism                                                                 |

Killing the TM doesn't "restart" the job gratuitously — it **crashes** it (the worker + its state die), and the surviving JM **recovers** it: detects the loss → (with a restart strategy + checkpointing) waits for the TM to come back → restores from the **last checkpoint** onto it, rewinding the source and replaying. We kill the **TM, not the JM**, precisely because the JM must survive to hold the checkpoint and drive recovery. That replay is why Scenario 4a saw duplicates.

### Is the sink "just a Kafka consumer"?

Mechanically yes — `sink/consume.js` is an ordinary kafkajs consumer. What makes it a **sink** is that it *commits results into an external store* (ClickHouse), so it **owns end-to-end delivery semantics** at that boundary. It reads Kafka at-least-once, so a re-emitted (duplicate) message would be inserted twice; the offset-commit-vs-write ordering decides loss vs duplicate on a crash. That's why the fix in 4b was *"make the **sink** idempotent"* (`--dedupe` / upsert / transaction), not *"read differently."* In production this role is a purpose-built sink connector (Kafka Connect / Flink JDBC sink) with batching + transactional/upsert writes; our Node version is the readable stand-in.
