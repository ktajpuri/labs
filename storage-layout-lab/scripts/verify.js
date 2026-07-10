#!/usr/bin/env node
// The one-command steady-state check: all three engines loaded, row counts match.
const pg = require("../engines/postgres");
const ch = require("../engines/clickhouse");
const cass = require("../engines/cassandra");

async function main() {
  const pool = pg.pool();
  const chClient = ch.client();
  await cass.ensureKeyspace();
  const cassClient = cass.client();
  await cassClient.connect();

  const [pgCount, chCount, cassCount] = await Promise.all([
    pg.rowCount(pool).catch((e) => `ERROR: ${e.message}`),
    ch.rowCount(chClient).catch((e) => `ERROR: ${e.message}`),
    cass.rowCount(cassClient).catch((e) => `ERROR: ${e.message}`),
  ]);

  console.log("row counts:");
  console.log(`  postgres:   ${pgCount}`);
  console.log(`  clickhouse: ${chCount}`);
  console.log(`  cassandra:  ${cassCount}`);

  const allNumbers = [pgCount, chCount, cassCount].every((n) => typeof n === "number");
  const allMatch = allNumbers && pgCount === chCount && chCount === cassCount;

  if (allMatch) {
    console.log(`\nPASS — steady state: all three engines hold ${pgCount.toLocaleString()} matching rows.`);
  } else {
    console.log("\nFAIL — row counts don't match (or an engine errored). Run `npm run load` first.");
  }

  await pool.end();
  await chClient.close();
  await cassClient.shutdown();
  process.exit(allMatch ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
