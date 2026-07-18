// WORKFLOW — deterministic orchestration ONLY. No side effects here, no Date.now()/random
// in the body (that would break replay). It says: reserve, then charge, then ship — and if
// any step fails, UNWIND the steps that already succeeded (the saga / compensating-transaction
// pattern), then mark the order cancelled.
//
// This function is what Temporal REPLAYS from event history after any worker crash. Because
// each activity's result is recorded, a restarted worker fast-forwards through completed
// activities (no re-run) and continues from the first incomplete one — durable execution,
// for real, exactly like the hand-rolled engine but with a production runtime + UI.

import { proxyActivities, sleep, log } from '@temporalio/workflow';
import type * as activities from './activities';

const {
  reserveInventory, chargePayment, shipOrder,
  releaseInventory, refundPayment, cancelOrder,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumAttempts: 5, // at-least-once: a flaky activity is retried up to 5x
  },
});

export async function orderWorkflow(orderId: string, amount: number, holdSeconds = 0): Promise<string> {
  log.info(`workflow start order=${orderId} amount=${amount}`);

  // A stack of compensations. Each forward step, once it succeeds, PUSHES how to undo itself.
  // On failure we pop them in REVERSE order (LIFO) — the mirror image of how they were applied.
  const compensations: { name: string; run: () => Promise<unknown> }[] = [];

  try {
    await reserveInventory(orderId);
    compensations.push({ name: 'releaseInventory', run: () => releaseInventory(orderId) });

    await chargePayment(orderId, amount); // throws non-retryably on a 402 decline
    compensations.push({ name: 'refundPayment', run: () => refundPayment(orderId) });

    // A DURABLE TIMER. This sleep survives a worker crash — kill the worker here, restart it,
    // and Temporal resumes the timer from history and ships when it fires.
    if (holdSeconds > 0) {
      log.info(`holding ${holdSeconds}s before ship (durable timer — safe to kill the worker now)`);
      await sleep(`${holdSeconds}s`);
    }

    await shipOrder(orderId);

    log.info(`workflow done order=${orderId}`);
    return `order ${orderId} complete`;
  } catch (err) {
    // Temporal wraps an activity error in an ActivityFailure; the real reason (e.g. the
    // PaymentDeclined ApplicationFailure) is the nested cause.
    const cause = err instanceof Error ? err.cause : undefined;
    const reason = (cause instanceof Error ? cause.message : undefined) ??
      (err instanceof Error ? err.message : String(err));
    log.warn(`order ${orderId} FAILED: ${reason} — compensating in reverse (${compensations.length} step(s))`);

    // Unwind whatever already succeeded, newest first. Compensations run as normal activities,
    // so they get their own retries and are recorded in history — the rollback is durable too.
    for (const c of compensations.reverse()) {
      log.info(`  compensating: ${c.name}(${orderId})`);
      await c.run();
    }

    await cancelOrder(orderId);
    log.info(`order ${orderId} rolled back + CANCELLED`);
    // The saga did its job: system is left consistent, so this is a clean terminal state
    // (Completed with a "cancelled" result), NOT a system failure. Re-throw instead if you
    // want the workflow to surface as Failed in the UI.
    return `order ${orderId} cancelled (${reason})`;
  }
}
