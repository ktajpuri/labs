// Orchestrated saga: T1 = debit alice on bank-a (local commit),
// T2 = credit bob on bank-b (local commit). If T2 fails, compensation
// C1 = re-credit alice on bank-a.
//
// Flags:
//   --fail-step 2         T2 fails (simulated: credit service down)
//   --comp-delay-ms N     wait N ms before running compensation (default 0)
//   --amount N            default 100
const { A, B, connect, log, arg, balances } = require('./lib');

(async () => {
  const amount = Number(arg('--amount', 100));
  const failStep = Number(arg('--fail-step', 0));
  const compDelay = Number(arg('--comp-delay-ms', 0));

  // T1: local, committed, visible to the world immediately
  const a = await connect(A);
  await a.query('BEGIN');
  await a.query(`UPDATE accounts SET balance = balance - ${amount} WHERE name='alice'`);
  await a.query('COMMIT');
  log(`SAGA T1: debit alice ${amount} on bank-a — COMMITTED (visible to everyone NOW)`);

  // T2
  if (failStep === 2) {
    log('SAGA T2: credit bob on bank-b — FAILED (simulated: service down)');
    if (compDelay > 0) {
      log(`...compensation will run in ${compDelay}ms — watch the system state meanwhile...`);
      await new Promise((r) => setTimeout(r, compDelay));
    }
    // C1: compensate T1
    await a.query('BEGIN');
    await a.query(`UPDATE accounts SET balance = balance + ${amount} WHERE name='alice'`);
    await a.query('COMMIT');
    log(`SAGA C1: compensation — re-credit alice ${amount} on bank-a — COMMITTED`);
  } else {
    const b = await connect(B);
    await b.query('BEGIN');
    await b.query(`UPDATE accounts SET balance = balance + ${amount} WHERE name='bob'`);
    await b.query('COMMIT');
    log(`SAGA T2: credit bob ${amount} on bank-b — COMMITTED`);
    await b.end();
  }

  await a.end();
  const { alice, bob, total } = await balances();
  log(`SAGA DONE — alice=${alice} bob=${bob} total=${total}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
