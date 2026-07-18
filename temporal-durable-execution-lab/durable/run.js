'use strict';
// DURABLE order workflow — same 3 steps as naive/run.js, but every step (including
// computing the price) goes through the durable engine's ctx.step(). Re-running the
// command == the engine replaying history and continuing from the first unrecorded step.
//
// Usage:
//   node durable/run.js <orderId> [--crash-after=POINT] [--idempotent] [--nondeterministic]
//
// Crash points (mirror the naive lab, but relative to the HISTORY write, not a status col):
//   price-side / price-recorded
//   reserve-side / reserve-recorded
//   charge-side     : side effect done, result NOT yet in history  (at-least-once window)
//   charge-recorded : result durably in history                    (clean boundary)
//   ship-side / ship-recorded
//
// --idempotent        : charge uses an idempotency key -> safe even across at-least-once re-run
// --nondeterministic  : make a branch in ORCHESTRATION code depend on Math.random()
//                       (NOT inside a step) -> demonstrates the replay-determinism boundary

const engine = require('./engine');
const world = require('../lib/world');

const [, , id, ...rest] = process.argv;
if (!id) {
  console.error('usage: node durable/run.js <orderId> [--crash-after=POINT] [--idempotent] [--nondeterministic]');
  process.exit(1);
}
const crashArg = rest.find((a) => a.startsWith('--crash-after='));
const crashAfter = crashArg ? crashArg.split('=')[1] : null;
const idempotent = rest.includes('--idempotent');
const nondeterministic = rest.includes('--nondeterministic');

function orderWorkflow(ctx) {
  console.log(`[durable] order ${id} (replaying history, then continuing)`);

  // price is a STEP -> its result is recorded and replayed, never recomputed.
  const amount = ctx.step('price', () => 100 - Math.floor(Math.random() * 30));

  ctx.step('reserve', () => { world.reserveInventory(id); return 'reserved'; });

  ctx.step('charge', () => {
    if (idempotent) {
      world.chargePaymentIdempotent(id, amount, `${id}:charge`);
    } else {
      world.chargePayment(id, amount);
    }
    return { amount };
  });

  // BOUNDARY DEMO: a branch decided in orchestration code from raw Math.random().
  // This value is NOT a step, so replay re-executes it and can diverge run-to-run.
  if (nondeterministic) {
    const gift = Math.random() < 0.5;
    ctx.step('gift-note', () => { console.log(`    (gift note: ${gift})`); return gift; });
  }

  ctx.step('ship', () => { world.shipOrder(id); return 'shipped'; });

  console.log(`[durable] order ${id} finished`);
}

engine.run(orderWorkflow, crashAfter);
