#!/usr/bin/env bash
# Driver for the page-cache / buffer-pool lab. Every experiment is a
# combination of these primitives; no primitive runs a scenario for you.
set -euo pipefail
cd "$(dirname "$0")"

DC="docker compose"
PSQL="$DC exec -T postgres psql -U lab -d lab"

usage() {
  cat <<'EOF'
usage: ./lab.sh <command>

  up             build + start postgres, wait until healthy
  seed           create big (~250MB) and small (~19MB) tables, checkpoint
  status         show, per table: pages in shared_buffers (pg_buffercache)
                 and bytes resident in the OS page cache (fincore)
  scan <table>   EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) — timed read
  prewarm <t>    pg_prewarm table into shared_buffers (bypasses ring buffer)
  restart-pg     restart postgres container: shared_buffers emptied,
                 OS page cache SURVIVES (it lives in the VM kernel)
  drop-oscache   sync + echo 3 > drop_caches: OS page cache emptied,
                 shared_buffers SURVIVES
  cold           restart-pg + drop-oscache = everything cold except disk
  psql           interactive psql
  reset          destroy containers AND data volume (full clean slate)
  down           stop containers, keep data
EOF
}

cmd_up() {
  $DC up -d --build --wait
  echo "postgres healthy. shared_buffers:"
  $PSQL -c "SHOW shared_buffers;"
}

cmd_seed() {
  $PSQL <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_buffercache;
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
DROP TABLE IF EXISTS big;
DROP TABLE IF EXISTS small;
-- ~250MB: comfortably bigger than shared_buffers (128MB)
CREATE TABLE big AS
  SELECT g AS id, md5(g::text) || repeat('x', 60) AS pad
  FROM generate_series(1, 2000000) g;
-- ~19MB: comfortably smaller than shared_buffers
CREATE TABLE small AS
  SELECT g AS id, md5(g::text) || repeat('x', 60) AS pad
  FROM generate_series(1, 150000) g;
-- set hint bits now so experiment scans don't show dirtied/written noise
VACUUM (ANALYZE) big;
VACUUM (ANALYZE) small;
CHECKPOINT;
SELECT relname, pg_size_pretty(pg_relation_size(oid)) AS size
FROM pg_class WHERE relname IN ('big','small');
SQL
}

cmd_status() {
  echo "=== tier 1: PostgreSQL shared_buffers (pg_buffercache) ==="
  $PSQL <<'SQL'
SELECT t.relname AS "table",
       coalesce(cnt.buffers, 0)                          AS pages_in_pg,
       pg_size_pretty(coalesce(cnt.buffers,0) * 8192::bigint) AS in_shared_buffers,
       pg_size_pretty(pg_relation_size(t.oid))           AS table_size
FROM (SELECT oid, relname FROM pg_class WHERE relname IN ('big','small')) t
LEFT JOIN (
  SELECT c.oid, count(*) AS buffers
  FROM pg_buffercache b
  JOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
  WHERE b.reldatabase = (SELECT oid FROM pg_database
                         WHERE datname = current_database())
  GROUP BY c.oid
) cnt ON cnt.oid = t.oid
ORDER BY t.relname;
SQL
  echo "=== tier 2: OS page cache (fincore on the data files) ==="
  for t in big small; do
    local path
    path=$($PSQL -Atc "SELECT pg_relation_filepath('$t')")
    echo "--- $t ($path) ---"
    $DC exec -T postgres sh -c \
      "fincore /var/lib/postgresql/data/$path /var/lib/postgresql/data/$path.[0-9] 2>/dev/null" \
      || true
  done
}

cmd_scan() {
  local t="${1:?usage: ./lab.sh scan <table>}"
  # BUFFERS: 'shared hit' = served from shared_buffers,
  #          'read'       = requested from the OS (page cache OR disk —
  #                         postgres cannot tell which; that's the point)
  $PSQL -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
            SELECT count(*) FROM $t;"
}

cmd_prewarm() {
  local t="${1:?usage: ./lab.sh prewarm <table>}"
  $PSQL -c "SELECT pg_prewarm('$t') AS pages_loaded;"
}

cmd_restart_pg() {
  $DC restart postgres
  until $PSQL -c "SELECT 1" >/dev/null 2>&1; do sleep 0.5; done
  echo "postgres restarted: shared_buffers is empty, OS page cache untouched."
}

cmd_drop_oscache() {
  $DC exec -T postgres sh -c 'sync && echo 3 > /proc/sys/vm/drop_caches'
  echo "OS page cache dropped (whole Docker VM). shared_buffers untouched."
}

case "${1:-help}" in
  up)           cmd_up ;;
  seed)         cmd_seed ;;
  status)       cmd_status ;;
  scan)         cmd_scan "${2:-}" ;;
  prewarm)      cmd_prewarm "${2:-}" ;;
  restart-pg)   cmd_restart_pg ;;
  drop-oscache) cmd_drop_oscache ;;
  cold)         cmd_restart_pg; cmd_drop_oscache ;;
  psql)         $DC exec postgres psql -U lab -d lab ;;
  reset)        $DC down -v ;;
  down)         $DC down ;;
  *)            usage ;;
esac
