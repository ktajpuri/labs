'use strict';
// The EXTERNAL WORLD — the real, side-effecting systems the workflow talks to:
// inventory, the payment provider, the shipping carrier.
// This is durable on its own (a JSON file). The whole lab is about whether the
// WORKFLOW correctly drives this world exactly once, across crashes.
//
// Every side effect appends a record here. Duplicates are therefore VISIBLE:
// if a charge runs twice, ledger.charges has two rows for the same order.

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'state', 'ledger.json');

function fresh() {
  return { inventory: 100, reservations: [], charges: [], shipments: [] };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  } catch {
    return fresh();
  }
}

function save(l) {
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

// --- side effects on the external world (each is a real, observable action) ---

function reserveInventory(orderId) {
  const l = load();
  l.inventory -= 1;
  l.reservations.push({ orderId, ts: Date.now() });
  save(l);
}

function chargePayment(orderId, amount) {
  const l = load();
  l.charges.push({ orderId, amount, ts: Date.now() });
  save(l);
}

// Idempotent charge: the payment provider dedupes on an idempotency key. A second
// call with a key it has already seen is a no-op (returns the original charge).
// This is what closes the at-least-once gap the engine alone cannot.
function chargePaymentIdempotent(orderId, amount, key) {
  const l = load();
  if (l.charges.some((c) => c.key === key)) return; // already charged for this key
  l.charges.push({ orderId, amount, key, ts: Date.now() });
  save(l);
}

function shipOrder(orderId) {
  const l = load();
  l.shipments.push({ orderId, ts: Date.now() });
  save(l);
}

// --- reporting ---

function report() {
  const l = load();
  const byOrder = {};
  for (const c of l.charges) {
    byOrder[c.orderId] = byOrder[c.orderId] || { charges: 0, total: 0 };
    byOrder[c.orderId].charges += 1;
    byOrder[c.orderId].total += c.amount;
  }
  return { ledger: l, byOrder };
}

function resetWorld() {
  save(fresh());
}

module.exports = {
  load, save, reserveInventory, chargePayment, chargePaymentIdempotent,
  shipOrder, report, resetWorld,
};
