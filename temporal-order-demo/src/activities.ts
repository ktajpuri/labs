// ACTIVITIES — the ONLY place side effects (HTTP calls to the services) happen.
// Temporal records each activity's RESULT in the workflow's event history; on replay a
// completed activity is NOT re-run, its recorded result is returned. If an activity throws,
// Temporal RETRIES it per the workflow's retry policy (at-least-once execution).

async function post(url: string, body: any) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function reserveInventory(orderId: string) {
  return post('http://localhost:3001/reserve', { orderId });
}

export async function chargePayment(orderId: string, amount: number) {
  // payment-svc forwards to the gateway with orderId as the idempotency key, so any
  // retry of THIS activity results in exactly one captured charge.
  return post('http://localhost:3002/charge', { orderId, amount });
}

export async function shipOrder(orderId: string) {
  return post('http://localhost:3003/ship', { orderId });
}
