// Naive dual-write: two INDEPENDENT local commits, one per database.
// Flags:
//   --crash between-commits   die after bank-a committed, before bank-b runs
//   --amount N                default 100
const { A, B, connect, log, arg, balances } = require('./lib');

(async () => {
  const amount = Number(arg('--amount', 100));
  const crash = arg('--crash', null);

  const a = await connect(A);
  log(`bank-a: BEGIN; debit alice ${amount}; COMMIT`);
  await a.query('BEGIN');
  await a.query(`UPDATE accounts SET balance = balance - ${amount} WHERE name='alice'`);
  await a.query('COMMIT');
  log('bank-a: committed (money has LEFT alice, durably)');
  await a.end();

  if (crash === 'between-commits') {
    log('*** CRASH: process dies between the two commits ***');
    process.exit(1);
  }

  const b = await connect(B);
  log(`bank-b: BEGIN; credit bob ${amount}; COMMIT`);
  await b.query('BEGIN');
  await b.query(`UPDATE accounts SET balance = balance + ${amount} WHERE name='bob'`);
  await b.query('COMMIT');
  log('bank-b: committed');
  await b.end();

  const { alice, bob, total } = await balances();
  log(`DONE — alice=${alice} bob=${bob} total=${total}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
