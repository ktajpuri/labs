'use strict';
// NAIVE order workflow — the reasonable thing you write BEFORE you know durable
// execution exists. State is a `status` column persisted to a JSON file, and a
// supervisor re-runs any order that isn't SHIPPED. Retrying looks safe because
// the code "picks up where it left off" by reading status.
//
// Usage:
//   node naive/run.js <orderId> [--crash-after=POINT]
//   node naive/run.js <orderId>            # a re-run == what a supervisor/retry does
//
// Crash points (process dies abruptly at that instant, like a real kill -9):
//   reserve-side   : after inventory is reserved in the world, BEFORE status saved
//   reserve-status : after status=RESERVED is saved (a clean boundary)
//   charge-side    : after payment is charged in the world, BEFORE status saved
//   charge-status  : after status=CHARGED is saved (a clean boundary)
//   ship-side      : after shipment recorded, BEFORE status saved
//
// Watch the number: world charges for this order should end at exactly 1.

const fs = require('fs');
const path = require('path');
const world = require('../lib/world');

const ORDERS = path.join(__dirname, '..', 'state', 'orders.json');

function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS, 'utf8')); } catch { return {}; }
}
function saveOrders(o) { fs.writeFileSync(ORDERS, JSON.stringify(o, null, 2)); }

function getOrder(id) {
  const all = loadOrders();
  return all[id] || { id, status: 'NEW' };
}
function putOrder(order) {
  const all = loadOrders();
  all[order.id] = order;
  saveOrders(all);
}

function maybeCrash(point, crashAfter) {
  if (point === crashAfter) {
    console.log(`  !! CRASH (kill -9) right after: ${point}`);
    process.exit(137); // abrupt death — no cleanup, no further writes
  }
}

// A value the workflow computes IN MEMORY, at the start, not saved anywhere on
// its own. Different every run. This is the "in-flight state" a naive resume loses.
function computePrice() {
  const discount = Math.floor(Math.random() * 30); // a "promo" that varies run-to-run
  return 100 - discount;
}

function runWorkflow(id, crashAfter) {
  let order = getOrder(id);
  console.log(`[naive] order ${id} starting at status=${order.status}`);

  // Orchestration recomputes the price on every (re-)entry — it is NOT persisted.
  const amount = computePrice();

  if (order.status === 'NEW') {
    world.reserveInventory(id);
    maybeCrash('reserve-side', crashAfter);
    order.status = 'RESERVED';
    putOrder(order);
    maybeCrash('reserve-status', crashAfter);
    console.log('  reserved inventory');
  }

  if (order.status === 'RESERVED') {
    world.chargePayment(id, amount);
    maybeCrash('charge-side', crashAfter);
    order.status = 'CHARGED';
    order.amount = amount;
    putOrder(order);
    maybeCrash('charge-status', crashAfter);
    console.log(`  charged $${amount}`);
  }

  if (order.status === 'CHARGED') {
    world.shipOrder(id);
    maybeCrash('ship-side', crashAfter);
    order.status = 'SHIPPED';
    putOrder(order);
    console.log('  shipped');
  }

  console.log(`[naive] order ${id} finished at status=${order.status}`);
}

const [, , id, ...rest] = process.argv;
if (!id) {
  console.error('usage: node naive/run.js <orderId> [--crash-after=POINT]');
  process.exit(1);
}
const crashArg = rest.find((a) => a.startsWith('--crash-after='));
const crashAfter = crashArg ? crashArg.split('=')[1] : null;
runWorkflow(id, crashAfter);
