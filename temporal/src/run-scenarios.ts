import { Client, Connection, WorkflowHandle } from '@temporalio/client';
import {
  OrderOutcome,
  ScenarioRun,
  allPassed,
  renderReport,
  scenarios,
  verdictFor,
} from '@saga/shared';
import { NAMESPACE, TASK_QUEUE, TEMPORAL_ADDRESS } from './config';
import { orderSaga, reviewDecisionSignal, statusQuery } from './workflows';

/**
 * Drives the shared scenario battery against Temporal.
 *
 * Human review is delivered as a signal. Finding out *whether* an order is
 * waiting for a human means querying the workflow — there is no built-in task
 * list, so the driver polls a query it defined itself. On the Camunda side the
 * equivalent is a real user task the broker knows about, which the driver can
 * search for.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReview(
  handle: WorkflowHandle<typeof orderSaga>,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await handle.query(statusQuery);
    if (status.awaitingReview) return true;
    await sleep(100);
  }
  return false;
}

async function main(): Promise<void> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: NAMESPACE });

  const runId = Date.now().toString(36);
  const runs: ScenarioRun[] = [];

  for (const scenario of scenarios) {
    const order = scenario.build(runId);
    const startedAt = Date.now();

    let actualOutcome: OrderOutcome = 'failed';
    let error: string | undefined;

    try {
      const handle = await client.workflow.start(orderSaga, {
        args: [order],
        taskQueue: TASK_QUEUE,
        workflowId: `temporal-${order.orderId}`,
      });

      if (scenario.review) {
        const reached = await waitForReview(handle);
        if (!reached) throw new Error('workflow never reached human review');
        await handle.signal(reviewDecisionSignal, scenario.review);
      }

      const result = await handle.result();
      actualOutcome = result.outcome;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    runs.push({
      scenario,
      orderId: order.orderId,
      actualOutcome,
      durationMs: Date.now() - startedAt,
      error,
    });
  }

  const verdicts = runs.map(verdictFor);
  console.log(renderReport('TEMPORAL', verdicts));

  await connection.close();
  process.exit(allPassed(verdicts) ? 0 : 1);
}

main().catch((err) => {
  console.error('[temporal] scenario run failed', err);
  process.exit(1);
});
