// PAYMENT GATEWAY (:3004) — the external system. This is the boundary of durable
// execution: Temporal can retry the charge activity (at-least-once), so the gateway
// MUST dedupe on an idempotency key or the customer is double-charged.
//
//  - POST /charge : body {orderId, amount}, header 'idempotency-key'
//                   If GATEWAY_FLAKY=1, the FIRST call for each key fails (503) to force
//                   a Temporal retry — proving the key makes the retry a no-op.
//  - GET  /state  : charges actually captured (one row per idempotency key)
import { serve, log, httpError } from './lib';

const FLAKY = process.env.GATEWAY_FLAKY === '1';
const charges: { key: string; orderId: string; amount: number }[] = [];
const seenAttempts = new Set<string>();

serve('gateway', 3004, {
  '/charge': ({ orderId, amount, headers }) => {
    const key = headers['idempotency-key'] as string;
    if (!key) throw httpError(400, 'missing idempotency-key');

    // Idempotency: if we already captured this key, return the original — no double charge.
    const existing = charges.find((c) => c.key === key);
    if (existing) {
      log('gateway', `DEDUP  key=${key} already charged $${existing.amount} -> no-op`);
      return { captured: true, deduped: true, amount: existing.amount };
    }

    // Optional flakiness: fail the first attempt per key to force a retry.
    if (FLAKY && !seenAttempts.has(key)) {
      seenAttempts.add(key);
      log('gateway', `FLAKY  key=${key} first attempt -> 503 (forces Temporal retry)`);
      throw httpError(503, 'gateway temporarily unavailable');
    }

    charges.push({ key, orderId, amount });
    log('gateway', `CHARGE key=${key} $${amount} captured (total charges=${charges.length})`);
    return { captured: true, deduped: false, amount };
  },
}, () => ({ charges, count: charges.length }));
