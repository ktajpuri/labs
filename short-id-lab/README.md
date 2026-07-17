# short-id-lab

One concept: **where does a short-ID scheme store its uniqueness guarantee, and how does each choice fail** — walked as sequential counter → random base62 + collision check → Snowflake-style structured IDs.

No dependencies. Requires Node ≥ 22.5 (uses built-in `node:sqlite`).

## Start / steady state

```sh
node idlab.js sequential --n 100000
```

Expect: 100,000 sequential 7-char ids, `duplicates=0`, and the attacker-view block. If that prints, the harness works.

## Reset to clean state

```sh
node idlab.js reset
```

Removes the SQLite files (`ids.db`, `counter.db`). Every command that uses a DB also recreates its own tables from scratch, so runs are independently repeatable.

## Commands

| command | what it makes observable | key flags (defaults) |
|---|---|---|
| `sequential` | naive `aaaaaaa`++ counter: uniqueness, throughput, enumerability | `--n 100000 --chars 7` |
| `sequential-multi` | multiple generators: `--mode local` (each starts its own counter) vs `--mode shared` (one atomic SQLite counter row) | `--workers 4 --n 5000 --mode local` |
| `birthday` | draws random ids until the FIRST collision, reports the draw number | `--chars 5 --trials 1` |
| `collcount` | draws exactly N random ids, counts collisions | `--chars 7 --n 100000` |
| `check-insert` | collision check under concurrency: `--mode read-then-insert` (plain table) vs `--mode unique` (PRIMARY KEY + retry); simulated network RTT per DB call | `--n 2000 --chars 2 --concurrency 50 --latency 5` |
| `snowflake-burst` | 41-bit ms timestamp \| 10-bit worker \| 12-bit sequence; generate flat-out, per-ms distribution, sequence-exhaustion waits | `--n 50000` |
| `snowflake-rollback` | clock jumps backward mid-run: `--mode naive` vs `--mode guard` | `--rollback 100 --mode naive` |

Counters printed in CAPS (`DUPLICATE IDS ADMITTED`, `DUPLICATE IDS ISSUED`) are the numbers the concept predicts.
