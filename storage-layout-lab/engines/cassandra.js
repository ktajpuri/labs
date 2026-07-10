const cassandraDriver = require("cassandra-driver");
const { concurrent } = cassandraDriver;
const fs = require("fs");
const readline = require("readline");
const cfg = require("../lib/config").cassandra;
const schema = require("../lib/schema").cassandra;

const INSERT = `INSERT INTO lab.events (id, user_id, event_type, ts, amount, payload) VALUES (?, ?, ?, ?, ?, ?)`;

function client() {
  return new cassandraDriver.Client(cfg);
}

// Bootstrap client without a keyspace, for keyspace creation.
function bootstrapClient() {
  const { keyspace, ...rest } = cfg;
  return new cassandraDriver.Client(rest);
}

// Must run BEFORE the keyspace-scoped client (cass.client(), which has
// keyspace: 'lab' baked into its config) connects — connecting with a
// keyspace that doesn't exist yet fails outright.
async function ensureKeyspace() {
  const boot = bootstrapClient();
  await boot.connect();
  await boot.execute(schema.createKeyspace);
  await boot.shutdown();
}

async function resetSchema(client) {
  await client.execute(schema.drop);
  await client.execute(schema.create);
}

function toParams(r) {
  return [r.id, r.user_id, r.event_type, new Date(r.ts), r.amount.toFixed(2), r.payload];
}

// Idiomatic bulk load: prepared statement, fired concurrently (not wrapped in
// a multi-row BATCH — id is the partition key here and every row is its own
// partition, so batching unrelated partitions would just be the classic
// Cassandra anti-pattern). executeConcurrent drives many single-partition
// prepared writes in parallel, which is the actual idiomatic path.
async function loadFromFile(client, filePath, batchSize = 10_000, concurrencyLevel = 128) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  let batch = [];
  let count = 0;
  for await (const line of rl) {
    if (!line) continue;
    batch.push(toParams(JSON.parse(line)));
    if (batch.length >= batchSize) {
      await concurrent.executeConcurrent(client, INSERT, batch, { concurrencyLevel, collectResults: false });
      count += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await concurrent.executeConcurrent(client, INSERT, batch, { concurrencyLevel, collectResults: false });
    count += batch.length;
  }
  return count;
}

async function insertOne(client, row) {
  await client.execute(INSERT, toParams(row), { prepare: true });
}

async function rowCount(client) {
  // A single COUNT(*) is one unbounded range-scan query — at real dataset
  // sizes it blows past Cassandra's own server-side range_request_timeout
  // (raising the client socket timeout doesn't help, the coordinator times
  // itself out). Paginating like a normal full-table read keeps every
  // individual page fast, same technique as the aggregate workload.
  let count = 0;
  await new Promise((resolve, reject) => {
    client.eachRow(
      "SELECT id FROM lab.events",
      [],
      { prepare: true, fetchSize: 50_000, autoPage: true },
      () => count++,
      (err) => (err ? reject(err) : resolve())
    );
  });
  return count;
}

module.exports = { client, ensureKeyspace, resetSchema, loadFromFile, insertOne, rowCount, schema, INSERT, toParams };
