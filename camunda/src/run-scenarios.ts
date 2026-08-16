import {
  OrderOutcome,
  ScenarioRun,
  allPassed,
  renderReport,
  scenarios,
  verdictFor,
} from '@saga/shared';
import { PROCESS_ID, camundaClient } from './config';

/**
 * Drives the shared scenario battery against Camunda 8.
 *
 * The human-review step is a real user task the broker knows about, so the
 * driver *searches* for it rather than querying the instance for a
 * self-declared status the way the Temporal driver has to. That search is the
 * same API Tasklist uses, which is the concrete payoff of modelling human work
 * as a first-class element instead of as a signal.
 */

const client = camundaClient();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Everything below polls the search APIs, which are served from Elasticsearch
 * rather than from the broker. They are eventually consistent — a task or an
 * instance state can lag the broker by a beat — so each read is a poll with a
 * deadline rather than a single request.
 *
 * The Temporal driver needs none of this: a workflow query is answered by the
 * workflow itself and `handle.result()` resolves the moment it finishes.
 */
async function waitForUserTask(processInstanceKey: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await client.searchUserTasks({
      filter: { state: 'CREATED', processInstanceKey },
    });
    const task = found.items?.[0];
    if (task) return task;
    await sleep(200);
  }
  throw new Error('user task never appeared');
}

async function waitForInstanceToEnd(processInstanceKey: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await client.searchProcessInstances({
      filter: { processInstanceKey },
    });
    const state = found.items?.[0]?.state;
    if (state === 'COMPLETED' || state === 'TERMINATED') return state;
    await sleep(200);
  }
  throw new Error('process instance never reached a terminal state');
}

/** Reads the `outcome` variable set by the output mapping on each end event. */
async function readOutcome(processInstanceKey: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await client.searchVariables({
      filter: { processInstanceKey, name: 'outcome' },
    });
    const raw = found.items?.[0]?.value;
    if (raw) return JSON.parse(raw) as string;
    await sleep(200);
  }
  throw new Error('outcome variable never appeared');
}

async function main(): Promise<void> {
  const runId = Date.now().toString(36);
  const runs: ScenarioRun[] = [];

  for (const scenario of scenarios) {
    const order = scenario.build(runId);
    const startedAt = Date.now();

    let actualOutcome: OrderOutcome = 'failed';
    let error: string | undefined;

    try {
      // Deliberately not `createProcessInstanceWithResult`: holding a REST
      // request open for the lifetime of a human review makes the gateway
      // return 503, and the SDK's retry then starts a *second* instance of
      // the same order. Start it, get the key, then poll.
      const created = await client.createProcessInstance({
        processDefinitionId: PROCESS_ID,
        variables: { order },
      });
      const processInstanceKey = String(created.processInstanceKey);

      if (scenario.review) {
        const task = await waitForUserTask(processInstanceKey);
        await client.completeUserTask({
          userTaskKey: task.userTaskKey,
          variables: { reviewDecision: scenario.review },
        });
      }

      await waitForInstanceToEnd(processInstanceKey);
      const outcome = await readOutcome(processInstanceKey);

      if (outcome === 'completed' || outcome === 'rejected' || outcome === 'failed') {
        actualOutcome = outcome;
      } else {
        error = `process ended without a recognised outcome variable (${String(outcome)})`;
      }
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
  console.log(renderReport('CAMUNDA 8', verdicts));

  process.exit(allPassed(verdicts) ? 0 : 1);
}

main().catch((err) => {
  console.error('[camunda] scenario run failed', err);
  process.exit(1);
});
