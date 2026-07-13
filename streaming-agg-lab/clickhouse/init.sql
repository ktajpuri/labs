-- The OLAP sink table. Plain MergeTree = appends only (no dedup).
-- That is deliberate: if the sink ever inserts a (window,type) twice,
-- you will SEE two physical rows. The query script flags rows>1.
CREATE DATABASE IF NOT EXISTS lab;

CREATE TABLE IF NOT EXISTS lab.aggregates
(
    window_start String,
    window_end   String,
    event_type   String,
    cnt          UInt64,
    sum_value    Float64,
    inserted_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (window_start, event_type);

-- Note: the app connects as user 'lab' over HTTP. The image restricts the
-- built-in 'default' user to localhost only, so a dedicated network-reachable
-- user (provisioned via CLICKHOUSE_USER/PASSWORD in docker-compose) is required.

-- Top-K lab: exact per-minute counts. 30m/1h/1d top-K are derived from this
-- table at query time (query/topk.js) — that derivation is the whole lab.
CREATE TABLE IF NOT EXISTS lab.minute_counts
(
    window_start DateTime64(3),
    window_end   DateTime64(3),
    item_id      String,
    cnt          UInt64,
    inserted_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (window_start, item_id);
