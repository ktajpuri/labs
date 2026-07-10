# storage-layout-lab

Same data, three storage layouts: Postgres (B-tree row store), ClickHouse (columnar MergeTree), Cassandra (LSM, partition-key-addressed). The lab makes visible which workload shape survives on which engine, and where each one visibly breaks.

Schema is identical everywhere: `id, user_id, event_type, ts, amount, payload`. `id` is the primary/partition key in all three engines on purpose (see `lib/schema.js`) — it's what makes scenario 1's "point lookup" comparison apples-to-apples, and what makes scenario 4's "filter on a non-key column" (`user_id`) fair across all three.

## Start

```
docker compose up -d
npm install
```

Wait for all three containers to report healthy:

```
docker compose ps
```

## Generate + load

```
npm run generate                 # writes data/events.ndjson + data/meta.json (default 20M rows)
npm run load all                 # loads all three engines idiomatically (COPY / batch insert / concurrent prepared writes)
```

For a fast first pass (don't wait on 20M rows just to confirm the harness works):

```
npm run generate -- --rows 200000
npm run load all
```

Load a single engine: `npm run load pg`, `npm run load ch`, or `npm run load cass`.

## Steady-state verification (one command)

```
npm run verify
```

Prints row counts from all three engines and PASSes only if they match. Cassandra's count is a paginated full-table scan (that's inherent to the engine, not a bug in this script) so `verify` is slower on Cassandra than the other two — at 20M rows expect it to take a couple of minutes, not a hang. It's paginated rather than a single `COUNT(*)` on purpose: one unbounded `COUNT(*)` over 20M rows blows past Cassandra's own server-side `range_request_timeout` regardless of client timeout settings — the same thing that bites you if you ever run an unguarded full scan against Cassandra in production.

## Reset to clean state

```
npm run reset          # drops + recreates empty tables/keyspace in all three
npm run reset pg       # or just one engine: pg | ch | cass
```

Followed by `npm run load all` to repopulate.

## Full teardown

```
docker compose down -v
```

Drops the containers and their volumes — next `up` starts from nothing.

## Scenario command reference

1. **Point lookup by id** (1000 iterations, wall-clock ms):
   ```
   npm run workload:point-lookup pg
   npm run workload:point-lookup ch
   npm run workload:point-lookup cass
   ```
2. **Full-table aggregate** (`SUM(amount) GROUP BY event_type`):
   ```
   npm run workload:aggregate pg
   npm run workload:aggregate ch
   npm run workload:aggregate cass   # client-side scan — CQL GROUP BY can't group by a non-key column at all
   ```
3. **Sustained random-key write throughput** (default 60s, 8 concurrent writers; ClickHouse is intentionally hit row-by-row, not batched):
   ```
   npm run workload:write-throughput pg   -- --seconds 60 --concurrency 8
   npm run workload:write-throughput ch   -- --seconds 60 --concurrency 8
   npm run workload:write-throughput cass -- --seconds 60 --concurrency 8
   ```
4. **Filter on a non-key column** (`WHERE user_id = X`):
   ```
   npm run workload:filter-nonkey pg -- --user-id 12345 --index off
   npm run workload:filter-nonkey pg -- --user-id 12345 --index on
   npm run workload:filter-nonkey ch -- --user-id 12345
   npm run workload:filter-nonkey cass -- --user-id 12345   # tries with no ALLOW FILTERING first (expect a refusal), then with it
   ```
5. **Memory-capped scan** — re-run scenario 2's aggregate, but first cap the running container's memory so the working set exceeds RAM:
   ```
   docker update --memory=512m --memory-swap=512m sll-postgres
   docker update --memory=512m --memory-swap=512m sll-clickhouse
   npm run workload:aggregate pg
   npm run workload:aggregate ch
   ```
   Undo afterward with `docker update --memory=0 --memory-swap=-1 <container>` (or just `docker compose restart <service>` to fall back to the compose defaults).
6. **Control — ClickHouse point lookup via its ORDER BY key.** Same command as scenario 1:
   ```
   npm run workload:point-lookup ch
   ```
   The interesting part of this scenario isn't a new query, it's explaining the number — ClickHouse's sparse primary index and granules, not a per-row index.

## Tip: picking a real `user_id` for scenario 4

`user_id` is drawn from a large space (2M distinct values by default) relative to the row count, so a random guess will usually return 0 rows — which measures the same scan cost but is less satisfying to look at. Pull a real one out of the loaded data first:

```
docker exec sll-postgres psql -U lab -d lab -t -c "SELECT user_id FROM events LIMIT 1;"
```

## Notes

- Row count and seed are fixed per `data/meta.json` after `generate` — workloads read `maxId` from there rather than re-scanning any engine, so point-lookup key ranges stay valid without an expensive `COUNT(*)` against Cassandra on every run.
- Cassandra's bulk loader (`engines/cassandra.js`) does **not** wrap rows in a multi-row `BATCH` statement. `id` is the partition key and every row is its own partition here, so batching unrelated partitions together would be the classic Cassandra anti-pattern, not an optimization. The idiomatic load path is many concurrent single-partition prepared writes, via the driver's `executeConcurrent` helper — that's what's implemented.
