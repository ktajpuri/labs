// ACTIVITIES — the ONLY place side effects (HTTP calls to the services) happen.
// Temporal records each activity's RESULT in the workflow's event history; on replay a
// completed activity is NOT re-run, its recorded result is returned. If an activity throws,
// Temporal RETRIES it per the workflow's retry policy (at-least-once execution) — UNLESS we
// throw a non-retryable ApplicationFailure, which fails the activity immediately.

import { ApplicationFailure } from '@temporalio/activity';

async function post(url: string, body: any) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    const e: any = new Error(`${url} -> ${r.status}: ${text}`);
    e.status = r.status; // surface the HTTP status so the caller can decide retry vs fail-fast
    throw e;
  }
  return r.json();
}

// ---- forward steps -------------------------------------------------------

export async function reserveInventory(orderId: string) {
  return post('http://localhost:3001/reserve', { orderId });
}

export async function chargePayment(orderId: string, amount: number) {
  // payment-svc forwards to the gateway with orderId as the idempotency key, so any
  // retry of THIS activity results in exactly one captured charge.
  try {
    return await post('http://localhost:3002/charge', { orderId, amount });
  } catch (e: any) {
    // 402 = business decline. Retrying can't fix "card declined", so fail fast (non-retryable)
    // and let the workflow COMPENSATE instead of burning all 5 retry attempts. A 503 (transient)
    // falls through and IS retried — that's the retry-vs-compensate distinction.
    if (e.status === 402) {
      throw ApplicationFailure.nonRetryable(`payment declined for ${orderId}: ${e.message}`, 'PaymentDeclined');
    }
    throw e;
  }
}

export async function shipOrder(orderId: string) {
  try {
    return await post('http://localhost:3003/ship', { orderId });
  } catch (e: any) {
    // 422 = permanent business failure (e.g. undeliverable address). Don't retry — compensate.
    if (e.status === 422) {
      throw ApplicationFailure.nonRetryable(`shipment failed for ${orderId}: ${e.message}`, 'ShipmentFailed');
    }
    throw e;
  }
}

// ---- compensations (saga rollback) --------------------------------------
// Each is idempotent on the service side, because Temporal runs activities at-least-once.

export async function releaseInventory(orderId: string) {
  return post('http://localhost:3001/release', { orderId });
}

export async function refundPayment(orderId: string) {
  return post('http://localhost:3002/refund', { orderId });
}

export async function cancelOrder(orderId: string) {
  return post('http://localhost:3001/cancel', { orderId });
}
