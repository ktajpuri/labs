// ORDER SERVICE (:3001)
//  - POST /reserve : reserve inventory for an order (the workflow's first activity)
//  - POST /release : COMPENSATION — free the inventory reserved above (saga rollback)
//  - POST /cancel  : COMPENSATION — mark the order CANCELLED (saga rollback)
//  - GET  /state   : inventory + reservations + per-order status
import { serve, log } from './lib';

const state = {
  inventory: 100,
  reservations: [] as string[],
  status: {} as Record<string, 'PLACED' | 'CANCELLED'>,
};

serve('order-svc', 3001, {
  '/reserve': ({ orderId }) => {
    if (!state.reservations.includes(orderId)) {
      state.inventory -= 1;
      state.reservations.push(orderId);
    }
    state.status[orderId] = 'PLACED';
    log('order-svc', `reserved inventory for ${orderId} (left=${state.inventory})`);
    return { reserved: true, orderId };
  },

  // COMPENSATION for /reserve. Idempotent: only frees inventory if this order still holds a
  // reservation, so re-running the compensation (Temporal is at-least-once) can't over-refund.
  '/release': ({ orderId }) => {
    const i = state.reservations.indexOf(orderId);
    if (i !== -1) {
      state.reservations.splice(i, 1);
      state.inventory += 1;
      log('order-svc', `RELEASED inventory for ${orderId} (left=${state.inventory})`);
    } else {
      log('order-svc', `release ${orderId} -> nothing reserved, no-op`);
    }
    return { released: true, orderId, inventory: state.inventory };
  },

  // COMPENSATION: mark the order cancelled. Idempotent by assignment.
  '/cancel': ({ orderId }) => {
    state.status[orderId] = 'CANCELLED';
    log('order-svc', `order ${orderId} marked CANCELLED`);
    return { cancelled: true, orderId };
  },
}, () => state);
