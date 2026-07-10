#!/usr/bin/env node
// Drops and recreates the events table/keyspace in one or more engines,
// leaving them empty. This is the "reset to clean state" step from the README
// — run it, then `npm run load` to repopulate.
// Usage: node scripts/reset.js [pg|ch|cass|all]
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");

async function main() {
  const target = process.argv[2] || "all";

  if (target === "pg" || target === "all") {
    const pool = pg.pool();
    await pg.resetSchema(pool);
    await pool.end();
    console.log("[postgres]   reset to empty events table");
  }
  if (target === "ch" || target === "all") {
    const client = ch.client();
    await ch.resetSchema(client);
    await client.close();
    console.log("[clickhouse] reset to empty events table");
  }
  if (target === "cass" || target === "all") {
    await cass.ensureKeyspace();
    const client = cass.client();
    await client.connect();
    await cass.resetSchema(client);
    await client.shutdown();
    console.log("[cassandra]  reset to empty events table");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
