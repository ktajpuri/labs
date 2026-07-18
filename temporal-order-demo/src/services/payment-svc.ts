// PAYMENT SERVICE (:3002) — the workflow's charge activity calls this; it forwards to
// the payment gateway with a STABLE idempotency key (the orderId), so any Temporal retry
// of the charge activity hits the gateway with the same key and is deduped.
//
//  - POST /charge : body {orderId, amount}
import { serve, log, httpError } from './lib';

serve('payment-svc', 3002, {
  '/charge': async ({ orderId, amount }) => {
    const idempotencyKey = orderId; // one charge per order, stable across retries
    log('payment-svc', `charging ${orderId} $${amount} via gateway (key=${idempotencyKey})`);
    const r = await fetch('http://localhost:3004/charge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ orderId, amount }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw httpError(r.status, `gateway ${r.status}: ${body}`);
    }
    return r.json();
  },
}, () => ({ ok: true }));
