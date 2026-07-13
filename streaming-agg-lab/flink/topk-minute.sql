-- =============================================================
-- Top-K lab: tumbling 1-minute COUNT(*) per item_id.
--
--   Reads  : Kafka topic 'events2'       (raw events, JSON: item_id, event_time)
--   Writes : Kafka topic 'minute-counts' (per-minute per-item counts, JSON)
--
-- This is the ONLY thing Flink does for this lab: exact per-minute counts.
-- Every top-K question (30m/1h/1d, correct vs naive-merge) is answered later
-- by query/topk.js reading these exact buckets out of ClickHouse — rollup
-- correctness is a query-time concern, not a stream-processing concern.
-- =============================================================

SET 'pipeline.name' = 'topk-minute-count';
SET 'table.dml-sync' = 'false';
-- Same idle-partition fix as the parent lab's aggregate.sql: if any of
-- events2's 3 partitions goes quiet for a minute, its watermark pins at
-- Long.MIN and NO window ever fires. See streaming-agg-lab learnings.md.
SET 'table.exec.source.idle-timeout' = '3s';

-- ---- SOURCE ---------------------------------------------------
CREATE TABLE events2 (
  item_id     STRING,
  event_time  TIMESTAMP(3),
  WATERMARK FOR event_time AS event_time - INTERVAL '2' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'events2',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'flink-topk',
  'scan.startup.mode' = 'latest-offset',      -- start Flink BEFORE the producer
  'format' = 'json',
  'json.timestamp-format.standard' = 'ISO-8601',
  'json.fail-on-missing-field' = 'false',
  'json.ignore-parse-errors' = 'false'
);

-- ---- SINK -----------------------------------------------------
CREATE TABLE minute_counts (
  window_start TIMESTAMP(3),
  window_end   TIMESTAMP(3),
  item_id      STRING,
  cnt          BIGINT
) WITH (
  'connector' = 'kafka',
  'topic' = 'minute-counts',
  'properties.bootstrap.servers' = 'kafka:9092',
  'format' = 'json',
  'json.timestamp-format.standard' = 'ISO-8601'
);

-- ---- THE CONTINUOUS QUERY -------------------------------------
-- One row per (1-minute window, item_id), emitted when the watermark passes
-- the window end. This is the ONLY aggregation Flink does — no ranking here.
INSERT INTO minute_counts
SELECT
  window_start,
  window_end,
  item_id,
  COUNT(*) AS cnt
FROM TABLE(
  TUMBLE(TABLE events2, DESCRIPTOR(event_time), INTERVAL '1' MINUTE)
)
GROUP BY window_start, window_end, item_id;
