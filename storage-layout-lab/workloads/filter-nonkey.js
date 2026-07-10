#!/usr/bin/env node
// Scenario 4: WHERE user_id = X, where user_id is NOT the primary/partition
// key in any of the three engines.
//   pg:   toggle an index on user_id with --index on|off.
//   ch:   user_id isn't in ORDER BY, so this always scans every granule.
//   cass: first tries the query with no ALLOW FILTERING (Cassandra refuses
//         up front — that refusal IS the result), then runs it again WITH
//         ALLOW FILTERING so you can see the full-partition-range scan cost.
// Usage: node workloads/filter-nonkey.js <pg|ch|cass> [--user-id 12345] [--index on|off]
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");
const { USER_CARDINALITY } = require("../lib/config");

function parseArgs() {
  const args = process.argv.slice(2);
  const engine = args[0];
  const opts = { userId: 1 + Math.floor(Math.random() * USER_CARDINALITY), index: "off" };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--user-id") opts.userId = Number(args[++i]);
    if (args[i] === "--index") opts.index = args[++i];
  }
  return { engine, ...opts };
}

async function runPostgres(userId, index) {
  const pool = pg.pool();
  if (index === "on") await pool.query(pg.schema.createUserIdIndex);
  else await pool.query(pg.schema.dropUserIdIndex);

  const t0 = performance.now();
  const { rows } = await pool.query("SELECT * FROM events WHERE user_id = $1", [userId]);
  const ms = performance.now() - t0;
  await pool.end();
  console.log(`[postgres, index=${index}] user_id=${userId} -> ${rows.length} rows in ${ms.toFixed(1)}ms`);
}

async function runClickhouse(userId) {
  const client = ch.client();
  const t0 = performance.now();
  const rs = await client.query({ query: `SELECT * FROM events WHERE user_id = ${userId}`, format: "JSONEachRow" });
  const rows = await rs.json();
  const ms = performance.now() - t0;
  await client.close();
  console.log(`[clickhouse] user_id=${userId} -> ${rows.length} rows in ${ms.toFixed(1)}ms (user_id not in ORDER BY -> full scan)`);
}

async function runCassandra(userId) {
  const client = cass.client();
  await client.connect();

  try {
    await client.execute("SELECT * FROM lab.events WHERE user_id = ?", [userId], { prepare: true });
    console.log(`[cassandra, no ALLOW FILTERING] unexpectedly succeeded`);
  } catch (e) {
    console.log(`[cassandra, no ALLOW FILTERING] refused: ${e.message}`);
  }

  const t0 = performance.now();
  const rs = await client.execute("SELECT * FROM lab.events WHERE user_id = ? ALLOW FILTERING", [userId], { prepare: true });
  const ms = performance.now() - t0;
  await client.shutdown();
  console.log(`[cassandra, ALLOW FILTERING] user_id=${userId} -> ${rs.rowLength} rows in ${ms.toFixed(1)}ms (full partition-range scan)`);
}

async function main() {
  const { engine, userId, index } = parseArgs();
  if (!["pg", "ch", "cass"].includes(engine)) {
    console.error("Usage: node workloads/filter-nonkey.js <pg|ch|cass> [--user-id 12345] [--index on|off]");
    process.exit(1);
  }
  if (engine === "pg") await runPostgres(userId, index);
  if (engine === "ch") await runClickhouse(userId);
  if (engine === "cass") await runCassandra(userId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
