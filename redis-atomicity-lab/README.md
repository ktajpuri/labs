# Redis Atomicity Lab — Lost Update / Oversell

**Observable claim:** Stock = 100, 500 concurrent buyers. The naive `GET`-then-`SET`
path sells **more than 100 units** (lost decrements → oversell). Atomic paths never do.

You watch one number: `units_sold` vs the `STOCK` invariant.

## Prerequisites

- Docker (for Redis)
- Node.js
- Deps installed: `npm install`

## Start

```bash
docker compose up -d      # boots redis on localhost:6379
```

## Steady-state check (run this FIRST, before any experiment)

Confirm the wiring works with a single, non-concurrent buyer:

```bash
BUYERS=1 node buy.js naive
```

Expect: `units_sold: 1`, `final_stock_key: 99`, `INVARIANT ... : OK`.
If you see that, the harness talks to Redis correctly and you're ready to run scenarios.

## The one-command experiment

```bash
node buy.js <mode>
```

`mode` = `naive` | `decr` | `lua` | `watch`

Knobs (env vars):

| var    | default    | meaning                                            |
|--------|------------|----------------------------------------------------|
| STOCK  | 100        | units on the shelf at start                        |
| BUYERS | 500        | concurrent buyers                                  |
| EXEC   | parallel   | `parallel` (concurrent) or `serial` (one at a time)|
| DELAY  | 3          | ms of fake app-compute between GET and SET (naive) |

Each run **resets stock automatically**, so runs are independently repeatable.

## Reset to clean state / peek

```bash
node reset.js    # STOCK=100 node reset.js to choose a value
node peek.js     # print the current value of the stock key
```

## Stop / teardown

```bash
docker compose down
```
