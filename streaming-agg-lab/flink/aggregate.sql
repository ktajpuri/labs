-- =============================================================
-- Streaming aggregation: tumbling 10s event-time window COUNT
--
--   Reads  : Kafka topic 'events'       (raw events, JSON)
--   Writes : Kafka topic 'agg-results'  (per-window counts, JSON)
--
-- The Node sink-consumer then loads 'agg-results' into ClickHouse.
-- This whole file is ~15 lines of actual logic. Read it top to bottom.
-- =============================================================

SET 'pipeline.name' = 'events-tumble-count';
SET 'table.dml-sync' = 'false';
SET 'table.exec.source.idle-timeout' = '3s';

-- Phase B knob (leave commented for the happy path):
-- SET 'execution.checkpointing.interval' = '10s';

-- ---- SOURCE ---------------------------------------------------
CREATE TABLE events (
  event_id    STRING,
  event_type  STRING,
  `value`     DOUBLE,
  event_time  TIMESTAMP(3),
  -- WATERMARK = how long we wait for stragglers before declaring a
  -- window "complete" and firing it. This 2s is the knob we flip in Phase B.
  WATERMARK FOR event_time AS event_time - INTERVAL '2' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'events',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'flink-agg',
  'scan.startup.mode' = 'latest-offset',      -- start Flink BEFORE the producer
  'format' = 'json',
  'json.timestamp-format.standard' = 'ISO-8601',
  'json.fail-on-missing-field' = 'false',
  'json.ignore-parse-errors' = 'false'
);

-- ---- SINK -----------------------------------------------------
CREATE TABLE agg_results (
  window_start TIMESTAMP(3),
  window_end   TIMESTAMP(3),
  event_type   STRING,
  cnt          BIGINT,
  sum_value    DOUBLE
) WITH (
  'connector' = 'kafka',
  'topic' = 'agg-results',
  'properties.bootstrap.servers' = 'kafka:9092',
  'format' = 'json',
  'json.timestamp-format.standard' = 'ISO-8601'
);

-- ---- THE CONTINUOUS QUERY -------------------------------------
-- One row per (10s window, event_type) is emitted WHEN the watermark
-- passes the end of the window. Late events (past the watermark) are dropped.
INSERT INTO agg_results
SELECT
  window_start,
  window_end,
  event_type,
  COUNT(*)      AS cnt,
  SUM(`value`)  AS sum_value
FROM TABLE(
  TUMBLE(TABLE events, DESCRIPTOR(event_time), INTERVAL '10' SECONDS)
)
GROUP BY window_start, window_end, event_type;
