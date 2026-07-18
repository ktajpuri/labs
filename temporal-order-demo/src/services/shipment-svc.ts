// SHIPMENT SERVICE (:3003) — the workflow's ship activity calls this.
//  - POST /ship : body {orderId}
//  - GET  /state: shipments
import { serve, log } from './lib';

const state = { shipments: [] as string[] };

serve('shipment-svc', 3003, {
  '/ship': ({ orderId }) => {
    if (!state.shipments.includes(orderId)) state.shipments.push(orderId);
    log('shipment-svc', `shipped ${orderId} (total=${state.shipments.length})`);
    return { shipped: true, orderId };
  },
}, () => state);
