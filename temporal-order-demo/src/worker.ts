// WORKER — the process that executes workflow orchestration + activities. This is what you
// KILL and RESTART to see durable execution: on restart it reconnects, pulls the event
// history for any running workflow, REPLAYS it (re-runs completed activities from history,
// not for real), and continues from where it died.
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';

async function main() {
  const connection = await NativeConnection.connect({ address: 'localhost:7233' });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'orders',
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  console.log('[worker] started, polling task queue "orders" (Ctrl-C to kill)');
  await worker.run();
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
