// Two-phase commit coordinator. Participants: bank-a (debit), bank-b (credit).
// The coordinator writes its decision to coordinator.log.json BEFORE sending commits —
// that log is what recover.js uses to resolve in-doubt participants.
//
// Flags:
//   --crash after-prepare     die after both participants voted YES, before logging a decision
//   --crash after-decision    die after logging COMMIT decision, before telling anyone
//   --crash between-commits   die after committing bank-a, before committing bank-b
//   --vote-no-b               bank-b votes NO (abort path)
//   --amount N                default 100
const fs = require('fs');
const path = require('path');
const { A, B, connect, log, arg, has, balances } = require('./lib');

const LOG_FILE = path.join(__dirname, 'coordinator.log.json');

function writeLog(entry) {
  const entries = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
  entries.push({ ts: new Date().toISOString(), ...entry });
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

(async () => {
  const amount = Number(arg('--amount', 100));
  const crash = arg('--crash', null);
  const txid = `2pc_${Date.now()}`;

  log(`coordinator: starting distributed txn '${txid}'`);
  const a = await connect(A);
  const b = await connect(B);

  // Phase 0: do the work inside open transactions on both participants
  await a.query('BEGIN');
  await a.query(`UPDATE accounts SET balance = balance - ${amount} WHERE name='alice'`);
  await b.query('BEGIN');
  await b.query(`UPDATE accounts SET balance = balance + ${amount} WHERE name='bob'`);
  log('work done on both participants (uncommitted)');

  // Phase 1: PREPARE — each participant votes by durably promising it CAN commit
  writeLog({ txid, phase: 'preparing' });
  await a.query(`PREPARE TRANSACTION '${txid}'`);
  log(`bank-a: voted YES — PREPARE TRANSACTION '${txid}' (locks now held until a decision)`);

  if (has('--vote-no-b')) {
    log('bank-b: voted NO (simulated) — coordinator must abort everywhere');
    await b.query('ROLLBACK');
    writeLog({ txid, phase: 'decision', decision: 'abort' });
    await a.query(`ROLLBACK PREPARED '${txid}'`);
    log(`bank-a: ROLLBACK PREPARED — atomic abort complete`);
    await a.end();
    await b.end();
    const { alice, bob, total } = await balances();
    log(`DONE (aborted) — alice=${alice} bob=${bob} total=${total}`);
    return;
  }

  await b.query(`PREPARE TRANSACTION '${txid}'`);
  log(`bank-b: voted YES — PREPARE TRANSACTION '${txid}'`);

  if (crash === 'after-prepare') {
    log('*** CRASH: coordinator dies AFTER both prepares, BEFORE logging a decision ***');
    log('*** both participants are now IN-DOUBT — they cannot commit OR abort alone ***');
    process.exit(1);
  }

  // Phase 2: decision is logged first (the commit point), then pushed to participants
  writeLog({ txid, phase: 'decision', decision: 'commit' });
  log('coordinator: decision COMMIT logged — the txn is now committed, whatever happens next');

  if (crash === 'after-decision') {
    log('*** CRASH: coordinator dies after logging COMMIT, before telling participants ***');
    process.exit(1);
  }

  await a.query(`COMMIT PREPARED '${txid}'`);
  log('bank-a: COMMIT PREPARED done');

  if (crash === 'between-commits') {
    log('*** CRASH: coordinator dies after committing bank-a, before bank-b ***');
    process.exit(1);
  }

  await b.query(`COMMIT PREPARED '${txid}'`);
  log('bank-b: COMMIT PREPARED done');
  writeLog({ txid, phase: 'done' });

  await a.end();
  await b.end();
  const { alice, bob, total } = await balances();
  log(`DONE — alice=${alice} bob=${bob} total=${total}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
