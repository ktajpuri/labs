// WORKFLOW — deterministic orchestration ONLY. No side effects here, no Date.now()/random
// in the body (that would break replay). It just says: reserve, then charge, then ship.
//
// This function is what Temporal REPLAYS from event history after any worker crash. Because
// each activity's result is recorded, a restarted worker fast-forwards through completed
// activities (no re-run) and continues from the first incomplete one — durable execution,
// for real, exactly like the hand-rolled engine but with a production runtime + UI.

import { proxyActivities, sleep, log } from '@temporalio/workflow';
import type * as activities from './activities';

const { reserveInventory, chargePayment, shipOrder } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumAttempts: 5, // at-least-once: a flaky activity is retried up to 5x
  },
});

export async function orderWorkflow(orderId: string, amount: number, holdSeconds = 0): Promise<string> {
  log.info(`workflow start order=${orderId} amount=${amount}`);

  await reserveInventory(orderId);
  await chargePayment(orderId, amount);

  // A DURABLE TIMER. This sleep survives a worker crash — kill the worker here, restart it,
  // and Temporal resumes the timer from history and ships when it fires. Set via holdSeconds
  // to give you a window to kill the worker for the crash-resume demo.
  if (holdSeconds > 0) {
    log.info(`holding ${holdSeconds}s before ship (durable timer — safe to kill the worker now)`);
    await sleep(`${holdSeconds}s`);
  }

  await shipOrder(orderId);

  log.info(`workflow done order=${orderId}`);
  return `order ${orderId} complete`;
}
