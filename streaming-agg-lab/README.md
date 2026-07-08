# Streaming Aggregation Lab — Kafka → Flink → ClickHouse

**Observable claim (Phase A, happy path):** events flow through a real streaming
pipeline, Flink counts them into 10-second event-time windows, and the count that
lands in the OLAP store (ClickHouse) **matches what the producer actually sent** —
one row per (window, event_type).

You watch two things and compare them:
- the producer's **GROUND TRUTH** printout (`window → type → cnt`)
- the **ClickHouse** table via the query script

Phase B then breaks this on purpose (late events, restarts, backpressure) and asks
you to predict the number *before* each run.

## Data flow

```
Node producer ──▶ Kafka 'events' ──▶ Flink SQL ──▶ Kafka 'agg-results' ──▶ Node sink ──▶ ClickHouse ◀── Node query
 (kafkajs,         (3 partitions)     (tumbling      (per-window counts)    -consumer      (OLAP)        (dashboard
  3–4 types)                          10s window)                           (inserts)                    stand-in)
```
Everything between the two Kafka topics is Flink (JVM — as it is in production).
Everything else is Node/CLI you can read.

## Prerequisites

- Docker (Kafka, Flink jobmanager+taskmanager, ClickHouse)
- Node.js 18+
- Deps installed: `npm install`

## Ports

| Service | URL |
|---|---|
| Kafka (host listener) | `localhost:29092` |
| Flink web UI | http://localhost:8081 |
| ClickHouse HTTP | http://localhost:8123 (user `lab` / pass `lab` / db `lab`) |

---

## Start (5 steps, in order)

The **order matters**: topics before the Flink job, Flink job before the producer
(the source reads from `latest-offset`).

**1. Boot the infra** (first run builds the Flink image — a few minutes):
```bash
docker compose up -d --build
docker compose ps        # wait until kafka is healthy
```

**2. Create the Kafka topics** (you run this — see the partitions):
```bash
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic events --partitions 3 --replication-factor 1
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic agg-results --partitions 1 --replication-factor 1
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
```

**3. Submit the Flink SQL job:**
```bash
docker compose exec jobmanager ./bin/sql-client.sh -f /sql/aggregate.sql
```
Expect it to print a submitted **Job ID** and return to your shell. Confirm it's RUNNING:
```bash
docker compose exec jobmanager ./bin/flink list
```
(or open the Flink UI at http://localhost:8081 → Running Jobs)

**4. Start the sink-consumer** (own terminal — leave it running):
```bash
npm run sink
```

**5. Start the producer** (own terminal):
```bash
npm run produce -- --rate 5
```

---

## Steady-state check (run this FIRST, before any experiment)

Let the producer run ~30 seconds so at least two 10s windows close, then in a
**fourth terminal**:
```bash
npm run query
```

Expect:
- one row per (window_start, event_type), `rows` column = **1** for every row
- the counts match the producer's **GROUND TRUTH** block (stop the producer with
  Ctrl-C to print it; ignore the newest window — it may not have fired yet)

If ClickHouse matches ground truth and every `rows` = 1, the pipeline breathes and
you're ready for Phase B. Watch it live with:
```bash
npm run query -- --watch
```

---

## Reset to clean (repeatable experiments)

**Quick reset** (between scenarios — keeps Flink running):
```bash
# stop producer (Ctrl-C), then wipe the OLAP table:
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE lab.aggregates"
```

**Restart the Flink job** (needed when Phase B changes aggregate.sql):
```bash
docker compose exec jobmanager ./bin/flink list                 # copy the Job ID
docker compose exec jobmanager ./bin/flink cancel <JOB_ID>
docker compose exec jobmanager ./bin/sql-client.sh -f /sql/aggregate.sql
```

**Full reset** (nuke everything, re-init ClickHouse table):
```bash
docker compose down -v
docker compose up -d --build
# then redo steps 2–5
```

## Useful Kafka introspection (muscle memory)

```bash
# consumer lag for Flink's source and for the sink
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group flink-agg
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group clickhouse-sink

# peek at raw events / aggregated results
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic events --from-beginning --max-messages 5
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic agg-results --from-beginning --max-messages 5
```

## Grafana (live dashboard — the `query --watch` in charts)

```bash
docker compose up -d grafana      # first boot installs the ClickHouse plugin (needs internet, ~30s)
# open http://localhost:3000  (anonymous admin — no login)
# dashboard: "Streaming Aggregation (live)"  (auto-refresh 5s)
```

Pre-wired: a **ClickHouse data source** (`lab`/`lab`, native protocol on `clickhouse:9000`) and a
starter dashboard — events-per-window by type, total throughput, and a **freshness** stat
(seconds behind now) that turns yellow/red under backpressure.

Gotcha baked in: `window_start` is stored as a **String**, so every panel query parses it with
`parseDateTimeBestEffort(window_start) AS time`. In a real build you'd store `DateTime64(3)` and skip that.

If a panel shows a datasource/plugin error (plugin-version drift), the data source is still
wired — just **Add panel → ClickHouse → paste the SQL** from the dashboard; the UI writes the
correct panel JSON. Reset the plugin/db without touching the rest: `docker compose up -d grafana`.

---

Phase B scenarios and the failure matrix live in `WHY.md`. Session recap + diagrams in `learnings.md`.
