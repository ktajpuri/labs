// SHIPMENT SERVICE (:3003) — the workflow's ship activity calls this.
//  - POST /ship : body {orderId}
//                 If SHIPMENT_FAIL=1, every ship returns 422 "address undeliverable" — a
//                 PERMANENT business failure (retrying won't help), forcing the workflow to
//                 COMPENSATE the already-successful reserve + charge. Scenario 5.
//  - GET  /state: shipments
import { serve, log, httpError } from './lib';

const FAIL = process.env.SHIPMENT_FAIL === '1';
const state = { shipments: [] as string[] };

serve('shipment-svc', 3003, {
  '/ship': ({ orderId }) => {
    if (FAIL) {
      log('shipment-svc', `FAIL ${orderId} -> 422 (address undeliverable; retry won't help)`);
      throw httpError(422, 'address undeliverable');
    }
    if (!state.shipments.includes(orderId)) state.shipments.push(orderId);
    log('shipment-svc', `shipped ${orderId} (total=${state.shipments.length})`);
    return { shipped: true, orderId };
  },
}, () => state);
