#!/usr/bin/env node
// Loads data/events.ndjson into one or more engines, idiomatically per engine.
// Usage: node scripts/load.js <pg|ch|cass|all> [--file path]
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");
const { DATA_FILE } = require("../lib/config");

function parseArgs() {
  const args = process.argv.slice(2);
  const target = args[0] && !args[0].startsWith("--") ? args[0] : "all";
  const opts = { file: DATA_FILE };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") opts.file = args[++i];
  }
  return { target, ...opts };
}

async function loadPostgres(file) {
  const pool = pg.pool();
  const t0 = Date.now();
  await pg.resetSchema(pool);
  const n = await pg.loadFromFile(pool, file);
  const ms = Date.now() - t0;
  console.log(`[postgres]   loaded ${n.toLocaleString()} rows in ${ms}ms`);
  await pool.end();
}

async function loadClickhouse(file) {
  const client = ch.client();
  const t0 = Date.now();
  await ch.resetSchema(client);
  const n = await ch.loadFromFile(client, file);
  const ms = Date.now() - t0;
  console.log(`[clickhouse] loaded ${n.toLocaleString()} rows in ${ms}ms`);
  await client.close();
}

async function loadCassandra(file) {
  await cass.ensureKeyspace();
  const client = cass.client();
  await client.connect();
  const t0 = Date.now();
  await cass.resetSchema(client);
  const n = await cass.loadFromFile(client, file);
  const ms = Date.now() - t0;
  console.log(`[cassandra]  loaded ${n.toLocaleString()} rows in ${ms}ms`);
  await client.shutdown();
}

async function main() {
  const { target, file } = parseArgs();
  console.log(`Loading from ${file} into: ${target}`);

  if (target === "pg" || target === "all") await loadPostgres(file);
  if (target === "ch" || target === "all") await loadClickhouse(file);
  if (target === "cass" || target === "all") await loadCassandra(file);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
