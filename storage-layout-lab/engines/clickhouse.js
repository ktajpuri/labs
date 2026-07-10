const { createClient } = require("@clickhouse/client");
const fs = require("fs");
const readline = require("readline");
const cfg = require("../lib/config").clickhouse;
const schema = require("../lib/schema").clickhouse;

function client() {
  return createClient(cfg);
}

async function resetSchema(client) {
  await client.command({ query: schema.drop });
  await client.command({ query: schema.create });
}

// Idiomatic bulk load: batched JSONEachRow inserts (one INSERT per batch, not
// per row) — ClickHouse wants few large writes, not many small ones.
async function loadFromFile(client, filePath, batchSize = 50_000) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  let batch = [];
  let count = 0;
  for await (const line of rl) {
    if (!line) continue;
    batch.push(JSON.parse(line));
    if (batch.length >= batchSize) {
      await client.insert({ table: "events", values: batch, format: "JSONEachRow" });
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await client.insert({ table: "events", values: batch, format: "JSONEachRow" });
    count += batch.length;
  }
  return count;
}

async function insertOne(client, row) {
  await client.insert({ table: "events", values: [row], format: "JSONEachRow" });
}

async function rowCount(client) {
  const rs = await client.query({ query: schema.count, format: "JSONEachRow" });
  const [row] = await rs.json();
  return Number(row.n);
}

module.exports = { client, resetSchema, loadFromFile, insertOne, rowCount, schema };
