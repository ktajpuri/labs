#!/usr/bin/env node
// Streams a synthetic events dataset to data/events.ndjson so it never has to
// live in memory. Deterministic given the same --rows/--seed, so "identical
// data in all three engines" is a load-time guarantee, not an assumption.
const fs = require("fs");
const path = require("path");
const { mulberry32, randomString } = require("../lib/random");
const { DEFAULT_ROWS, EVENT_TYPES, USER_CARDINALITY, PAYLOAD_BYTES, DATA_FILE, META_FILE } = require("../lib/config");

const FIXED_NOW_MS = Date.UTC(2026, 0, 1); // fixed reference so ts is reproducible across runs
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { rows: DEFAULT_ROWS, seed: 42, out: DATA_FILE };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rows") opts.rows = Number(args[++i]);
    else if (args[i] === "--seed") opts.seed = Number(args[++i]);
    else if (args[i] === "--out") opts.out = args[++i];
  }
  return opts;
}

async function main() {
  const { rows, seed, out } = parseArgs();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rand = mulberry32(seed);
  const stream = fs.createWriteStream(out, { encoding: "utf8" });

  const start = Date.now();
  let written = 0;

  for (let id = 0; id < rows; id++) {
    const user_id = 1 + ((rand() * USER_CARDINALITY) | 0);
    const event_type = EVENT_TYPES[(rand() * EVENT_TYPES.length) | 0];
    const ts = new Date(FIXED_NOW_MS - (rand() * NINETY_DAYS_MS) | 0).toISOString();
    const amount = Math.round(rand() * 100000) / 100; // 0.00 - 1000.00
    const payload = randomString(rand, PAYLOAD_BYTES);

    const ok = stream.write(JSON.stringify({ id, user_id, event_type, ts, amount, payload }) + "\n");
    written++;
    if (!ok) await new Promise((resolve) => stream.once("drain", resolve));

    if (written % 1_000_000 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`  ${written.toLocaleString()} / ${rows.toLocaleString()} rows (${elapsed}s)\r`);
    }
  }

  await new Promise((resolve) => stream.end(resolve));
  fs.writeFileSync(META_FILE, JSON.stringify({ rows, seed, maxId: rows - 1, userCardinality: USER_CARDINALITY }, null, 2));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nWrote ${rows.toLocaleString()} rows to ${out} in ${elapsed}s (seed=${seed})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
