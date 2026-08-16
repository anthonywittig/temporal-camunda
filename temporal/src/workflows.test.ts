import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The shared services resolve their effect directory at call time, so pointing
// it at a scratch dir before anything else runs keeps test runs isolated.
process.env.SAGA_EFFECT_DIR = mkdtempSync(join(tmpdir(), 'saga-test-'));

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { compensations, scenarioByKey } from '@saga/shared';
import * as activities from './activities';
import { orderSaga, reviewDecisionSignal, statusQuery } from './workflows';

/**
 * Workflow tests run against a real Temporal server that the SDK starts in
 * process, with a *skipping clock*: a workflow blocked on a seven-day timer
 * resolves in milliseconds. The whole saga — timers, retries, signals — is
 * exercised without Docker and without waiting.
 *
 * This is the capability with no direct Camunda 8 equivalent. Zeebe's own
 * test support exists for Java (`zeebe-process-test`), but there is no
 * in-process broker for a Node worker, so testing the Camunda saga end to end
 * means a running broker.
 */

const TASK_QUEUE = 'order-saga-test';

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;

before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  // One worker for the whole suite. `runUntil` would tear the worker down
  // after the first test, so drive it manually and shut it down in `after`.
  workerRun = worker.run();
});

after(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => undefined);
  await env?.teardown();
});

function runOptions(workflowId: string) {
  return { taskQueue: TASK_QUEUE, workflowId };
}

describe('orderSaga', () => {
  it('completes the happy path with no compensation', async () => {
    const order = scenarioByKey('happy-path')!.build('unit');

    const result = await env.client.workflow.execute(orderSaga, {
      ...runOptions(`test-${order.orderId}`),
      args: [order],
    });

    assert.strictEqual(result.outcome, 'completed');
    assert.deepStrictEqual(result.compensated, []);
    assert.ok(result.shipmentId);
    assert.ok(result.captureId);
  });

  it('retries a flapping activity and still completes', async () => {
    const order = scenarioByKey('transient-payment')!.build('unit');

    const result = await env.client.workflow.execute(orderSaga, {
      ...runOptions(`test-${order.orderId}`),
      args: [order],
    });

    assert.strictEqual(result.outcome, 'completed');
    assert.deepStrictEqual(result.compensated, []);
  });

  it('unwinds effects in LIFO order when a late step fails', async () => {
    const order = scenarioByKey('capture-fails')!.build('unit');

    const result = await env.client.workflow.execute(orderSaga, {
      ...runOptions(`test-${order.orderId}`),
      args: [order],
    });

    assert.strictEqual(result.outcome, 'failed');
    assert.deepStrictEqual(result.compensated, ['shipping', 'payment', 'inventory']);
    assert.deepStrictEqual(compensations(order.orderId), ['shipping', 'payment', 'inventory']);
  });

  it('compensates when a human rejects the order', async () => {
    const order = scenarioByKey('fraud-rejected')!.build('unit');

    const handle = await env.client.workflow.start(orderSaga, {
      ...runOptions(`test-${order.orderId}`),
      args: [order],
    });

    // Wait for the saga to actually reach the review gate before signalling,
    // otherwise the signal races the fraud screen.
    while (!(await handle.query(statusQuery)).awaitingReview) {
      await env.sleep(100);
    }
    await handle.signal(reviewDecisionSignal, 'reject');
    const result = await handle.result();

    assert.strictEqual(result.outcome, 'rejected');
    assert.deepStrictEqual(result.compensated, ['payment', 'inventory']);
  });

  it('times out a review that no human ever picks up (7 days, skipped)', async () => {
    const order = scenarioByKey('fraud-approved')!.build('timeout-unit');

    // No signal is ever sent. The seven-day timer fires under the skipping
    // clock, so this assertion lands in milliseconds.
    const result = await env.client.workflow.execute(orderSaga, {
      ...runOptions(`test-${order.orderId}`),
      args: [order],
    });

    assert.strictEqual(result.outcome, 'failed');
    assert.match(result.reason ?? '', /timed out/);
    assert.deepStrictEqual(result.compensated, ['payment', 'inventory']);
  });
});
