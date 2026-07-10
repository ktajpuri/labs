#!/usr/bin/env node
// Scenario 3: N concurrent writers, random keys, fixed duration, writes/sec.
// ClickHouse is deliberately hit with row-by-row INSERTs here (not batched) —
// that's the point: watch part counts and merge behavior degrade under a
// write shape ClickHouse was never designed for. Watch Postgres too, for
// WAL/checkpoint effects as the run goes on.
// Usage: node workloads/write-throughput.js <pg|ch|cass> [--seconds 60] [--concurrency 8]
const crypto = require("crypto");
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");
const { EVENT_TYPES, USER_CARDINALITY } = require("../lib/config");

function parseArgs() {
  const args = process.argv.slice(2);
  const engine = args[0];
  const opts = { seconds: 60, concurrency: 8 };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--seconds") opts.seconds = Number(args[++i]);
    if (args[i] === "--concurrency") opts.concurrency = Number(args[++i]);
  }
  return { engine, ...opts };
}

const MAX_RANDOM_ID = 2 ** 48 - 1; // crypto.randomInt's hard ceiling

function randomRow() {
  return {
    id: crypto.randomInt(0, MAX_RANDOM_ID),
    user_id: 1 + Math.floor(Math.random() * USER_CARDINALITY),
    event_type: EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)],
    ts: new Date().toISOString(),
    amount: Math.round(Math.random() * 100000) / 100,
    payload: crypto.randomBytes(48).toString("hex"),
  };
}

// Runs `concurrency` parallel loops that each keep calling writeFn() with a
// fresh random row until `seconds` has elapsed. Reports writes/sec and error count.
async function runWorkers(writeFn, { seconds, concurrency }) {
  const deadline = Date.now() + seconds * 1000;
  let ok = 0;
  let errors = 0;

  async function worker() {
    while (Date.now() < deadline) {
      try {
        await writeFn(randomRow());
        ok++;
      } catch (e) {
        errors++;
      }
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedSec = (performance.now() - t0) / 1000;

  console.log(`writes ok=${ok} errors=${errors} elapsed=${elapsedSec.toFixed(1)}s -> ${(ok / elapsedSec).toFixed(0)} writes/sec`);
}

async function runPostgres(seconds, concurrency) {
  const pool = pg.pool({ max: Math.max(concurrency, 10) });
  await runWorkers(
    (r) => pool.query("INSERT INTO events (id, user_id, event_type, ts, amount, payload) VALUES ($1,$2,$3,$4,$5,$6)", [r.id, r.user_id, r.event_type, r.ts, r.amount, r.payload]),
    { seconds, concurrency }
  );
  await pool.end();
}

async function runClickhouse(seconds, concurrency) {
  const client = ch.client();
  await runWorkers((r) => ch.insertOne(client, r), { seconds, concurrency });
  await client.close();
}

async function runCassandra(seconds, concurrency) {
  const client = cass.client();
  await client.connect();
  await runWorkers((r) => cass.insertOne(client, r), { seconds, concurrency });
  await client.shutdown();
}

async function main() {
  const { engine, seconds, concurrency } = parseArgs();
  if (!["pg", "ch", "cass"].includes(engine)) {
    console.error("Usage: node workloads/write-throughput.js <pg|ch|cass> [--seconds 60] [--concurrency 8]");
    process.exit(1);
  }
  console.log(`[${engine}] ${concurrency} concurrent writers for ${seconds}s, random keys...`);
  if (engine === "pg") await runPostgres(seconds, concurrency);
  if (engine === "ch") await runClickhouse(seconds, concurrency);
  if (engine === "cass") await runCassandra(seconds, concurrency);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
