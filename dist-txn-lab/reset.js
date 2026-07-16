// Reset both banks to clean state: alice=1000 on bank-a, bob=1000 on bank-b.
// Also rolls back any lingering prepared (in-doubt) transactions and clears the coordinator log.
const fs = require('fs');
const path = require('path');
const { A, B, connect, log } = require('./lib');

async function resetDb(cfg, account) {
  const c = await connect(cfg);
  const prepared = await c.query('SELECT gid FROM pg_prepared_xacts');
  for (const row of prepared.rows) {
    await c.query(`ROLLBACK PREPARED '${row.gid}'`);
    log(`${cfg.name}: rolled back lingering prepared txn '${row.gid}'`);
  }
  await c.query('DROP TABLE IF EXISTS accounts');
  await c.query('CREATE TABLE accounts (name text PRIMARY KEY, balance int NOT NULL)');
  await c.query(`INSERT INTO accounts VALUES ('${account}', 1000)`);
  await c.end();
  log(`${cfg.name}: ${account} = 1000`);
}

(async () => {
  await resetDb(A, 'alice');
  await resetDb(B, 'bob');
  const logFile = path.join(__dirname, 'coordinator.log.json');
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  log('coordinator log cleared');
  log('RESET COMPLETE — invariant total = 2000');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
