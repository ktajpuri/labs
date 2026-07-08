-- =============================================================
-- SCENARIO 4 variant: base 2s job PLUS fault tolerance.
--   - checkpointing every 10s (source offsets + window state are saved)
--   - fixed-delay restart strategy (auto-recover after a TaskManager crash)
-- Everything else is identical to aggregate.sql.
--
-- On a TaskManager kill, the JobManager restores the job from the last
-- checkpoint and REWINDS the Kafka source to the checkpointed offset, so
-- the outage events get reprocessed instead of skipped. Watch what that
-- reprocessing does to the sink.
-- =============================================================

SET 'pipeline.name' = 'events-tumble-count-checkpointed';
SET 'table.dml-sync' = 'false';
SET 'table.exec.source.idle-timeout' = '3s';
SET 'execution.checkpointing.interval' = '10s';
SET 'restart-strategy.type' = 'fixed-delay';
SET 'restart-strategy.fixed-delay.attempts' = '1000000';
SET 'restart-strategy.fixed-delay.delay' = '10s';

CREATE TABLE events (
  event_id    STRING,
  event_type  STRING,
  `value`     DOUBLE,
  event_time  TIMESTAMP(3),
  WATERMARK FOR event_time AS event_time - INTERVAL '2' SECOND
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
