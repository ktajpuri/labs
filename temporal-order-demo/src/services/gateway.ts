// PAYMENT GATEWAY (:3004) — the external system. This is the boundary of durable
// execution: Temporal can retry the charge activity (at-least-once), so the gateway
// MUST dedupe on an idempotency key or the customer is double-charged.
//
//  - POST /charge : body {orderId, amount}, header 'idempotency-key'
//                   * amount >= 1000  -> 402 "card declined" (a BUSINESS decline: retrying
//                     won't help, so the workflow must COMPENSATE, not retry). Scenario 4.
//                   * GATEWAY_FLAKY=1 -> the FIRST call per key fails 503 (a TRANSIENT error:
//                     retrying DOES help). Scenario 3. 503 vs 402 = retry vs compensate.
//  - POST /refund : COMPENSATION — reverse a captured charge for an idempotency key.
//  - GET  /state  : charges actually captured (one row per idempotency key)
import { serve, log, httpError } from './lib';

const FLAKY = process.env.GATEWAY_FLAKY === '1';
const DECLINE_AT = 1000; // amount >= this is declined (e.g. "over limit")
const charges: { key: string; orderId: string; amount: number; refunded?: boolean }[] = [];
const seenAttempts = new Set<string>();

serve('gateway', 3004, {
  '/charge': ({ orderId, amount, headers }) => {
    const key = headers['idempotency-key'] as string;
    if (!key) throw httpError(400, 'missing idempotency-key');

    // Idempotency: if we already captured this key, return the original — no double charge.
    const existing = charges.find((c) => c.key === key && !c.refunded);
    if (existing) {
      log('gateway', `DEDUP  key=${key} already charged $${existing.amount} -> no-op`);
      return { captured: true, deduped: true, amount: existing.amount };
    }

    // BUSINESS decline — permanent for this order. 402 signals "do not retry, compensate".
    if (amount >= DECLINE_AT) {
      log('gateway', `DECLINE key=${key} $${amount} -> 402 (over limit; retry won't help)`);
      throw httpError(402, `card declined: amount $${amount} over limit`);
    }

    // TRANSIENT failure — fail the first attempt per key to force a Temporal retry.
    if (FLAKY && !seenAttempts.has(key)) {
      seenAttempts.add(key);
      log('gateway', `FLAKY  key=${key} first attempt -> 503 (forces Temporal retry)`);
      throw httpError(503, 'gateway temporarily unavailable');
    }

    charges.push({ key, orderId, amount });
    log('gateway', `CHARGE key=${key} $${amount} captured (total charges=${charges.length})`);
    return { captured: true, deduped: false, amount };
  },

  // COMPENSATION for /charge. Idempotent: only reverses a live charge for this key.
  '/refund': ({ headers }) => {
    const key = headers['idempotency-key'] as string;
    if (!key) throw httpError(400, 'missing idempotency-key');
    const c = charges.find((x) => x.key === key && !x.refunded);
    if (c) {
      c.refunded = true;
      log('gateway', `REFUND key=${key} $${c.amount} reversed`);
      return { refunded: true, amount: c.amount };
    }
    log('gateway', `refund key=${key} -> no live charge, no-op`);
    return { refunded: false };
  },
}, () => ({ charges, count: charges.filter((c) => !c.refunded).length }));
