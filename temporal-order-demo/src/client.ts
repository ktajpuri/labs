// CLIENT / STARTER — kicks off an order workflow. In a real system the ORDER service would
// do this on POST /orders; here it's a CLI so you can trigger runs easily.
//
//   npm run order -- <orderId> [amount] [holdSeconds]
//   npm run order -- order-1 79 0     # instant happy path
//   npm run order -- order-2 79 30    # 30s durable-timer hold (window to kill the worker)
import { Connection, Client } from '@temporalio/client';
import { orderWorkflow } from './workflows';

async function main() {
  const orderId = process.argv[2] ?? `order-${Date.now()}`;
  const amount = Number(process.argv[3] ?? 79);
  const holdSeconds = Number(process.argv[4] ?? 0);

  const connection = await Connection.connect({ address: 'localhost:7233' });
  const client = new Client({ connection });

  const handle = await client.workflow.start(orderWorkflow, {
    taskQueue: 'orders',
    workflowId: orderId, // dedupes: starting the same id twice reuses the running workflow
    args: [orderId, amount, holdSeconds],
  });
  console.log(`[client] started workflow id=${handle.workflowId} runId=${handle.firstExecutionRunId}`);
  console.log(`[client] watch it at: http://localhost:8080/namespaces/default/workflows/${orderId}`);
  const result = await handle.result();
  console.log(`[client] result: ${result}`);
}

main().catch((err) => {
  console.error('[client] error', err);
  process.exit(1);
});
