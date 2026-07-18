// Start all four services in one process (one terminal). Importing each module runs its serve().
import './order-svc';
import './payment-svc';
import './shipment-svc';
import './gateway';
console.log('[services] order:3001  payment:3002  shipment:3003  gateway:3004  (GATEWAY_FLAKY=' + (process.env.GATEWAY_FLAKY ?? '0') + ')');
