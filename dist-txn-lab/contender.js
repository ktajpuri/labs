// An unrelated transaction that needs alice's row on bank-a.
// Shows what an in-doubt transaction's locks do to everyone else.
// --lock-timeout MS   give up waiting after MS (default 5000)
const { A, connect, log, arg } = require('./lib');

(async () => {
  const timeout = Number(arg('--lock-timeout', 5000));
  const c = await connect(A);
  await c.query(`SET lock_timeout = ${timeout}`);
  log(`bank-a: trying UPDATE on alice's row (lock_timeout=${timeout}ms)...`);
  const t0 = Date.now();
  try {
    await c.query(`UPDATE accounts SET balance = balance - 1 WHERE name='alice'`);
    await c.query(`UPDATE accounts SET balance = balance + 1 WHERE name='alice'`);
    log(`SUCCESS after ${Date.now() - t0}ms — row was free`);
  } catch (e) {
    log(`BLOCKED for ${Date.now() - t0}ms, then: ${e.message}`);
    log('the row is locked by a transaction that no one can commit or abort right now');
  }
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
