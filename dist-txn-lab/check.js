// Observe system state: balances, invariant, in-doubt (prepared) transactions, blocked sessions.
// One-shot by default; --watch polls every 500ms (Ctrl-C to stop).
const { A, B, connect, log, has, INVARIANT_TOTAL } = require('./lib');

async function snapshot() {
  const a = await connect(A);
  const b = await connect(B);
  const alice = Number((await a.query(`SELECT balance FROM accounts WHERE name='alice'`)).rows[0].balance);
  const bob = Number((await b.query(`SELECT balance FROM accounts WHERE name='bob'`)).rows[0].balance);
  const total = alice + bob;
  const ok = total === INVARIANT_TOTAL;
  log(`alice(bank-a)=${alice}  bob(bank-b)=${bob}  TOTAL=${total}  invariant ${ok ? 'OK' : `VIOLATED (expected ${INVARIANT_TOTAL}, missing ${INVARIANT_TOTAL - total})`}`);

  for (const c of [a, b]) {
    const prep = await c.query(`SELECT gid, round(extract(epoch from now() - prepared)) AS age_s FROM pg_prepared_xacts`);
    for (const row of prep.rows) {
      log(`  ${c.label}: IN-DOUBT prepared txn '${row.gid}' (age ${row.age_s}s) — holding locks, waiting for a decision`);
    }
    const blocked = await c.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock'`);
    if (Number(blocked.rows[0].n) > 0) {
      log(`  ${c.label}: ${blocked.rows[0].n} session(s) BLOCKED waiting on a lock`);
    }
  }
  await a.end();
  await b.end();
}

(async () => {
  if (has('--watch')) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await snapshot();
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    await snapshot();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
