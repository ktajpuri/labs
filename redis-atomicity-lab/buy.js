'use strict';
// Flash-sale harness.
//
//   node buy.js <mode>
//
// mode = naive | decr | lua | watch
//
// Env knobs:
//   STOCK   initial units on the shelf   (default 100)
//   BUYERS  concurrent buyers to unleash (default 500)
//   EXEC    parallel | serial            (default parallel)
//   DELAY   ms of fake "app compute" between GET and SET in naive mode (default 3)
//
// Each buyer tries to purchase exactly 1 unit. We then compare units_sold
// against the STOCK invariant: a correct system must NEVER sell more than STOCK.

const { connect, KEY } = require('./lib');

const MODE = process.argv[2] || 'naive';
const STOCK = parseInt(process.env.STOCK || '100', 10);
const BUYERS = parseInt(process.env.BUYERS || '500', 10);
const EXEC = process.env.EXEC || 'parallel';
const DELAY = parseInt(process.env.DELAY || '3', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Buy strategies. Every strategy returns { sold: 0|1, aborts: number } ---

// NAIVE: read-modify-write. GET, decide in app code, SET. NOT atomic: the
// window between GET and SET is where concurrent buyers clobber each other.
async function buyNaive(redis) {
  const v = parseInt(await redis.get(KEY), 10);
  if (v > 0) {
    await sleep(Math.random() * DELAY); // simulate app-side work; widens the race window
    await redis.set(KEY, v - 1);
    return { sold: 1, aborts: 0 };
  }
  return { sold: 0, aborts: 0 };
}

// DECR: single atomic decrement, THEN check the result. The decrement itself
// can never be lost... but nothing stops the counter going negative.
async function buyDecr(redis) {
  const remaining = await redis.decr(KEY);
  return { sold: remaining >= 0 ? 1 : 0, aborts: 0 };
}

// LUA: check-and-decrement executed atomically server-side. Only decrements
// when stock > 0, so the counter floors at 0 and the count stays correct.
const BUY_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]))
if n and n > 0 then
  redis.call('DECR', KEYS[1])
  return 1
end
return 0`;
async function buyLua(redis) {
  const sold = await redis.eval(BUY_LUA, 1, KEY);
  return { sold, aborts: 0 };
}

// WATCH/MULTI: optimistic locking. WATCH the key, read it, and only commit if
// nobody else touched it since. On conflict EXEC returns null -> retry.
async function buyWatch(redis) {
  let aborts = 0;
  for (;;) {
    await redis.watch(KEY);
    const v = parseInt(await redis.get(KEY), 10);
    if (!(v > 0)) {
      await redis.unwatch();
      return { sold: 0, aborts };
    }
    const res = await redis.multi().set(KEY, v - 1).exec();
    if (res === null) {
      aborts++; // someone modified the key between WATCH and EXEC -> retry
      continue;
    }
    return { sold: 1, aborts };
  }
}

const STRATEGIES = { naive: buyNaive, decr: buyDecr, lua: buyLua, watch: buyWatch };

async function main() {
  const strategy = STRATEGIES[MODE];
  if (!strategy) {
    console.error(`unknown mode "${MODE}". use: ${Object.keys(STRATEGIES).join(' | ')}`);
    process.exit(1);
  }

  // Each buyer gets its own connection so buyers are genuinely concurrent
  // clients, not one client issuing serialized commands.
  const conns = Array.from({ length: BUYERS }, () => connect());
  const control = connect();

  await control.set(KEY, STOCK); // clean slate for this run

  let sold = 0;
  let aborts = 0;
  const t0 = Date.now();

  if (EXEC === 'serial') {
    for (let i = 0; i < BUYERS; i++) {
      const r = await strategy(conns[i]);
      sold += r.sold;
      aborts += r.aborts;
    }
  } else {
    const results = await Promise.all(conns.map((c) => strategy(c)));
    for (const r of results) {
      sold += r.sold;
      aborts += r.aborts;
    }
  }

  const ms = Date.now() - t0;
  const finalStock = parseInt(await control.get(KEY), 10);
  const oversold = Math.max(0, sold - STOCK);
  const ok = sold <= STOCK;

  await Promise.all(conns.map((c) => c.quit()));
  await control.quit();

  const line = '─'.repeat(46);
  console.log(line);
  console.log(`mode=${MODE}  exec=${EXEC}  buyers=${BUYERS}  initial_stock=${STOCK}`);
  console.log(line);
  console.log(`units_sold        : ${sold}`);
  console.log(`final_stock_key   : ${finalStock}`);
  console.log(`oversold          : ${oversold}`);
  if (MODE === 'watch') console.log(`retry_aborts      : ${aborts}`);
  console.log(`elapsed_ms        : ${ms}`);
  console.log(line);
  console.log(
    ok
      ? `INVARIANT units_sold <= ${STOCK} : OK`
      : `INVARIANT units_sold <= ${STOCK} : VIOLATED  (${sold} > ${STOCK})`
  );
  console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
