#!/usr/bin/env node
// Scenario 2 (and scenario 5, memory-capped — same script, run it again after
// you've capped container memory with `docker update`, see README):
// SUM(amount) GROUP BY event_type over the full table.
//
// Cassandra note: CQL's GROUP BY only accepts primary-key columns in key
// order, and event_type is neither the partition nor a clustering column
// here — `GROUP BY event_type` is not legal CQL. The only way to answer this
// query against this schema is a full-table scan with client-side
// aggregation, which is exactly the point: this query shape is hostile to a
// partition-key-addressed store, and the code below shows why (every row
// crosses the wire into Node before it's summed).
// Usage: node workloads/aggregate.js <pg|ch|cass>
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");

function printResult(label, ms, rows) {
  console.log(`[${label}] ${ms.toFixed(1)}ms`);
  for (const r of rows) console.log(`  ${r.event_type}: ${r.sum}`);
}

async function runPostgres() {
  const pool = pg.pool();
  const t0 = performance.now();
  const { rows } = await pool.query("SELECT event_type, SUM(amount) AS sum FROM events GROUP BY event_type ORDER BY event_type");
  const ms = performance.now() - t0;
  await pool.end();
  printResult("postgres", ms, rows);
}

async function runClickhouse() {
  const client = ch.client();
  const t0 = performance.now();
  const rs = await client.query({
    query: "SELECT event_type, SUM(amount) AS sum FROM events GROUP BY event_type ORDER BY event_type",
    format: "JSONEachRow",
  });
  const rows = await rs.json();
  const ms = performance.now() - t0;
  await client.close();
  printResult("clickhouse", ms, rows);
}

async function runCassandra() {
  const client = cass.client();
  await client.connect();
  const sums = new Map();
  const t0 = performance.now();

  await new Promise((resolve, reject) => {
    client.eachRow(
      "SELECT event_type, amount FROM lab.events",
      [],
      { prepare: true, fetchSize: 5000, autoPage: true },
      (n, row) => {
        const prev = sums.get(row.event_type) || 0;
        sums.set(row.event_type, prev + Number(row.amount));
      },
      (err) => (err ? reject(err) : resolve())
    );
  });

  const ms = performance.now() - t0;
  await client.shutdown();
  const rows = [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([event_type, sum]) => ({ event_type, sum: sum.toFixed(2) }));
  printResult("cassandra (client-side scan)", ms, rows);
}

async function main() {
  const engine = process.argv[2];
  if (!["pg", "ch", "cass"].includes(engine)) {
    console.error("Usage: node workloads/aggregate.js <pg|ch|cass>");
    process.exit(1);
  }
  if (engine === "pg") await runPostgres();
  if (engine === "ch") await runClickhouse();
  if (engine === "cass") await runCassandra();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
