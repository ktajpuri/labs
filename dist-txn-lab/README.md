# dist-txn-lab — atomic commitment: naive dual-write vs 2PC vs saga

Two independent Postgres instances play two services with their own databases:
`bank-a` holds alice (1000), `bank-b` holds bob (1000). Every experiment is a
transfer of 100 from alice to bob. **Invariant: alice + bob = 2000, always.**

Postgres speaks real 2PC (`PREPARE TRANSACTION` / `COMMIT PREPARED`), so
in-doubt transactions, their locks, and their survival across restarts are
genuine — nothing is simulated except the crashes.

## Start

```bash
docker compose up -d
npm install
node reset.js
```

## Reset to clean state (run between every experiment)

```bash
node reset.js       # balances back to 1000/1000, in-doubt txns rolled back, coordinator log cleared
```

## Observe steady state

```bash
node check.js       # balances + invariant + in-doubt txns + blocked sessions
node check.js --watch   # same, every 500ms (the concurrent-reader instrument)
```

## Drivers

| Script | What it does |
|---|---|
| `transfer-naive.js` | two independent commits; `--crash between-commits` |
| `transfer-2pc.js` | real 2PC; `--crash after-prepare` / `after-decision` / `between-commits`, `--vote-no-b` |
| `recover.js` | coordinator recovery from `coordinator.log.json` (commit decision → roll forward; none → presumed abort) |
| `contender.js` | unrelated txn that needs alice's row; shows in-doubt lock blocking (`--lock-timeout MS`) |
| `transfer-saga.js` | saga with compensation; `--fail-step 2`, `--comp-delay-ms N` |

## 2PC config boundary

Postgres ships with `max_prepared_transactions=0` — 2PC is **disabled by default**.
This lab starts the containers with 10. To see the default behavior:

```bash
MAX_PREPARED=0 docker compose up -d --force-recreate
# ...and back:
docker compose up -d --force-recreate
```

## Teardown

```bash
docker compose down -v
```
