// ORDER SERVICE (:3001)
//  - POST /reserve : reserve inventory for an order (the workflow's first activity calls this)
//  - GET  /state   : inventory + reservations
import { serve, log } from './lib';

const state = { inventory: 100, reservations: [] as string[] };

serve('order-svc', 3001, {
  '/reserve': ({ orderId }) => {
    if (!state.reservations.includes(orderId)) {
      state.inventory -= 1;
      state.reservations.push(orderId);
    }
    log('order-svc', `reserved inventory for ${orderId} (left=${state.inventory})`);
    return { reserved: true, orderId };
  },
}, () => state);
