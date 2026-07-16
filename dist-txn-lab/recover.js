// Coordinator recovery: resolve in-doubt participants using the coordinator log.
// Rule: a logged COMMIT decision rolls FORWARD (commit prepared); no decision on
// record means presumed ABORT (rollback prepared).
const fs = require('fs');
const path = require('path');
const { A, B, connect, log, balances } = require('./lib');

const LOG_FILE = path.join(__dirname, 'coordinator.log.json');

(async () => {
  const entries = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
  const decisions = {};
  for (const e of entries) {
    if (e.phase === 'decision') decisions[e.txid] = e.decision;
  }

  let found = 0;
  for (const cfg of [A, B]) {
    const c = await connect(cfg);
    const prep = await c.query('SELECT gid FROM pg_prepared_xacts');
    for (const row of prep.rows) {
      found++;
      const decision = decisions[row.gid];
      if (decision === 'commit') {
        await c.query(`COMMIT PREPARED '${row.gid}'`);
        log(`${cfg.name}: '${row.gid}' — decision COMMIT on record → rolled FORWARD (COMMIT PREPARED)`);
      } else {
        await c.query(`ROLLBACK PREPARED '${row.gid}'`);
        log(`${cfg.name}: '${row.gid}' — no commit decision on record → presumed ABORT (ROLLBACK PREPARED)`);
      }
    }
    await c.end();
  }

  if (found === 0) log('no in-doubt transactions found — nothing to recover');
  const { alice, bob, total } = await balances();
  log(`RECOVERY DONE — alice=${alice} bob=${bob} total=${total}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
