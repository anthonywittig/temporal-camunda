import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { NAMESPACE, TASK_QUEUE, TEMPORAL_ADDRESS } from './config';

/**
 * The Temporal worker hosts both workflow code and activity code. There is no
 * deployment step for the workflow definition — the worker *is* the
 * definition, and the server never sees the code. Contrast with Camunda, where
 * the BPMN model is deployed to the broker and the workers only supply the
 * service-task implementations.
 */
async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    namespace: NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });

  console.log(`[temporal] worker polling task queue "${TASK_QUEUE}" at ${TEMPORAL_ADDRESS}`);
  await worker.run();
}

main().catch((err) => {
  console.error('[temporal] worker failed', err);
  process.exit(1);
});
