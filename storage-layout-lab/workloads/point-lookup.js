#!/usr/bin/env node
// Scenario 1 (and 6, same code — reused deliberately: scenario 6 is a
// discussion of WHY ClickHouse's number looks the way it does, not a
// different query): fetch one row by id, N iterations, wall-clock ms.
// Usage: node workloads/point-lookup.js <pg|ch|cass> [--n 1000]
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");
const { readMeta } = require("../lib/meta");

function parseArgs() {
  const args = process.argv.slice(2);
  const engine = args[0];
  const opts = { n: 1000 };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--n") opts.n = Number(args[++i]);
  }
  return { engine, ...opts };
}

function randomIds(n, maxId) {
  const ids = new Array(n);
  for (let i = 0; i < n; i++) ids[i] = Math.floor(Math.random() * (maxId + 1));
  return ids;
}

function summarize(label, samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  console.log(`[${label}] n=${sorted.length} total=${sum.toFixed(1)}ms avg=${(sum / sorted.length).toFixed(3)}ms p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`);
}

async function runPostgres(ids) {
  const pool = pg.pool();
  const client = await pool.connect();
  const samples = [];
  for (const id of ids) {
    const t0 = performance.now();
    await client.query("SELECT * FROM events WHERE id = $1", [id]);
    samples.push(performance.now() - t0);
  }
  client.release();
  await pool.end();
  summarize("postgres", samples);
}

async function runClickhouse(ids) {
  const client = ch.client();
  const samples = [];
  for (const id of ids) {
    const t0 = performance.now();
    const rs = await client.query({ query: `SELECT * FROM events WHERE id = ${id}`, format: "JSONEachRow" });
    await rs.json();
    samples.push(performance.now() - t0);
  }
  await client.close();
  summarize("clickhouse", samples);
}

async function runCassandra(ids) {
  const client = cass.client();
  await client.connect();
  const samples = [];
  const query = "SELECT * FROM lab.events WHERE id = ?";
  for (const id of ids) {
    const t0 = performance.now();
    await client.execute(query, [id], { prepare: true });
    samples.push(performance.now() - t0);
  }
  await client.shutdown();
  summarize("cassandra", samples);
}

async function main() {
  const { engine, n } = parseArgs();
  if (!["pg", "ch", "cass"].includes(engine)) {
    console.error("Usage: node workloads/point-lookup.js <pg|ch|cass> [--n 1000]");
    process.exit(1);
  }
  const { maxId } = readMeta();
  const ids = randomIds(n, maxId);

  if (engine === "pg") await runPostgres(ids);
  if (engine === "ch") await runClickhouse(ids);
  if (engine === "cass") await runCassandra(ids);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
