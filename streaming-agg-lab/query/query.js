// Query script: reads the OLAP aggregate out of ClickHouse — this is the
// "consumer" of the pipeline, standing in for a dashboard.
//
//   node query/query.js            # print once
//   node query/query.js --watch    # refresh every 2s
//
// The `rows` column = how many PHYSICAL rows exist per (window,type).
// Happy path: always 1. rows>1 means the sink inserted a window twice
// (duplicate / double-count) — the signal we hunt in Phase B.
//
const { createClient } = require('@clickhouse/client');
const cfg = require('../lib/config');

const ch = createClient(cfg.clickhouse);
const watch = process.argv.includes('--watch');

async function once() {
  const rs = await ch.query({
    query: `
      SELECT window_start,
             event_type,
             sum(cnt)                AS cnt,
             round(sum(sum_value),2) AS sum_value,
             count()                 AS rows
      FROM aggregates
      GROUP BY window_start, event_type
      ORDER BY window_start DESC, event_type
      LIMIT 24`,
    format: 'JSONEachRow',
  });
  const rows = await rs.json();
  if (watch) console.clear();
  console.log(`ClickHouse aggregates @ ${new Date().toISOString().slice(11, 19)}  (latest windows first)\n`);
  console.log('  window_start              type          cnt   sum_value   rows');
  console.log('  ' + '-'.repeat(62));
  for (const r of rows) {
    console.log(
      `  ${String(r.window_start).padEnd(24)}  ${String(r.event_type).padEnd(11)} ` +
      `${String(r.cnt).padStart(4)}   ${String(r.sum_value).padStart(9)}   ${r.rows}`
    );
  }
  if (rows.some((r) => Number(r.rows) > 1)) {
    console.log('\n  ⚠ some (window,type) pairs have rows>1 — the sink wrote a window more than once.');
  }
  if (rows.length === 0) console.log('  (no rows yet — is the producer running and has a window closed?)');
}

async function main() {
  if (watch) {
    for (;;) { await once().catch((e) => console.error(e.message)); await new Promise((r) => setTimeout(r, 2000)); }
  } else {
    await once(); process.exit(0);
  }
}
main();
