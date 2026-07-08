-- =============================================================
-- SCENARIO 2 variant: identical to aggregate.sql EXCEPT the watermark
-- delay is 30s instead of 2s. That single change decides whether a
-- 25s-late event is counted or dropped.
--
-- Tradeoff to watch: a longer watermark delay tolerates more lateness,
-- but every window now fires 30s LATER (freshness cost).
-- =============================================================

SET 'pipeline.name' = 'events-tumble-count-late-tolerant';
SET 'table.dml-sync' = 'false';
SET 'table.exec.source.idle-timeout' = '3s';

CREATE TABLE events (
  event_id    STRING,
  event_type  STRING,
  `value`     DOUBLE,
  event_time  TIMESTAMP(3),
  WATERMARK FOR event_time AS event_time - INTERVAL '30' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'events',
  'properties.bootstrap.servers' = 'kafka:9092',
  'properties.group.id' = 'flink-agg',
  'scan.startup.mode' = 'latest-offset',
  'format' = 'json',
  'json.timestamp-format.standard' = 'ISO-8601',
  'json.fail-on-missing-field' = 'false',
  'json.ignore-parse-errors' = 'false'
);

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
