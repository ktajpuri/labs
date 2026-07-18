'use strict';
// Show the external world's state — the numbers that matter.
const world = require('./lib/world');
const { ledger, byOrder } = world.report();

console.log('=== WORLD ===');
console.log(`inventory left : ${ledger.inventory}`);
console.log(`reservations   : ${ledger.reservations.length}`);
console.log(`charges        : ${ledger.charges.length}`);
console.log(`shipments      : ${ledger.shipments.length}`);
console.log('--- per order ---');
for (const [id, s] of Object.entries(byOrder)) {
  const flag = s.charges > 1 ? '  <-- DOUBLE CHARGED' : '';
  console.log(`  ${id}: ${s.charges} charge(s), total $${s.total}${flag}`);
}
if (Object.keys(byOrder).length === 0) console.log('  (no charges yet)');
