const { Pool } = require("pg");
const copyFrom = require("pg-copy-streams").from;
const fs = require("fs");
const readline = require("readline");
const { PassThrough } = require("stream");
const cfg = require("../lib/config").postgres;
const schema = require("../lib/schema").postgres;

function pool(overrides = {}) {
  return new Pool({ ...cfg, ...overrides });
}

async function resetSchema(pool) {
  await pool.query(schema.drop);
  await pool.query(schema.create);
}

// Idiomatic bulk load: COPY FROM STDIN, streaming NDJSON -> CSV so the whole
// file never sits in memory.
async function loadFromFile(pool, filePath) {
  const client = await pool.connect();
  try {
    const copyStream = client.query(copyFrom(`COPY events FROM STDIN WITH (FORMAT csv)`));
    const csvStream = new PassThrough();
    const rl = readline.createInterface({ input: fs.createReadStream(filePath) });

    let count = 0;
    rl.on("line", (line) => {
      if (!line) return;
      const r = JSON.parse(line);
      csvStream.write(`${r.id},${r.user_id},${r.event_type},${r.ts},${r.amount},"${r.payload}"\n`);
      count++;
    });
    rl.on("close", () => csvStream.end());

    await new Promise((resolve, reject) => {
      csvStream.pipe(copyStream);
      copyStream.on("finish", resolve);
      copyStream.on("error", reject);
    });
    return count;
  } finally {
    client.release();
  }
}

async function rowCount(pool) {
  const { rows } = await pool.query(schema.count);
  return Number(rows[0].n);
}

module.exports = { pool, resetSchema, loadFromFile, rowCount, schema };
