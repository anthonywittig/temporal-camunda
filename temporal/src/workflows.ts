import {
  condition,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type * as activities from './activities';
import type { OrderRequest, OrderResult, ReviewDecision } from '@saga/shared';

/**
 * The order saga as Temporal sees it: one function.
 *
 * Note the import discipline — `@saga/shared` is imported with `import type`
 * only. Workflow code runs in a deterministic sandbox with no access to the
 * filesystem or the clock, and the shared module touches `node:fs`, so pulling
 * in a runtime value from it would fail to bundle. Everything with a side
 * effect has to go through an activity. That constraint is unenforceable-by-
 * convention in most frameworks; here the bundler rejects it outright.
 */

/** Forward steps: fail fast, let the saga compensate. */
const {
  reserveInventory,
  authorizePayment,
  screenForFraud,
  createShipment,
  capturePayment,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

/**
 * Compensations get their own, far more patient policy. Failing to undo an
 * effect is worse than failing to do it in the first place, and expressing
 * that is a one-line change here.
 */
const { releaseInventory, voidAuthorization, cancelShipment } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumAttempts: 10,
  },
});

export const reviewDecisionSignal = defineSignal<[ReviewDecision]>('reviewDecision');

export interface SagaStatus {
  stage: string;
  awaitingReview: boolean;
  compensated: string[];
}

export const statusQuery = defineQuery<SagaStatus>('status');

/** How long a flagged order waits for a human before it gives up. */
const REVIEW_TIMEOUT = '7 days';

export async function orderSaga(order: OrderRequest): Promise<OrderResult> {
  // The compensation stack. `unshift` keeps it in LIFO order, so iterating
  // forward undoes the most recent effect first.
  const compensations: Array<{ step: string; run: () => Promise<void> }> = [];
  const compensated: string[] = [];

  let stage = 'starting';
  let decision: ReviewDecision | undefined;

  setHandler(reviewDecisionSignal, (incoming) => {
    decision = incoming;
  });
  setHandler(statusQuery, () => ({
    stage,
    awaitingReview: stage === 'awaiting-review',
    compensated: [...compensated],
  }));

  async function compensate(): Promise<void> {
    stage = 'compensating';
    for (const entry of compensations) {
      await entry.run();
      compensated.push(entry.step);
    }
  }

  try {
    stage = 'inventory';
    const reservation = await reserveInventory(order);
    compensations.unshift({
      step: 'inventory',
      run: () => releaseInventory(order.orderId, reservation.reservationId),
    });

    stage = 'payment';
    const authorization = await authorizePayment(order);
    compensations.unshift({
      step: 'payment',
      run: () => voidAuthorization(order.orderId, authorization.authorizationId),
    });

    stage = 'fraud';
    const fraud = await screenForFraud(order);

    if (fraud.risk === 'high') {
      stage = 'awaiting-review';
      log.info('Order flagged for human review', { orderId: order.orderId, score: fraud.score });

      const reviewed = await condition(() => decision !== undefined, REVIEW_TIMEOUT);

      if (!reviewed) {
        await compensate();
        return {
          orderId: order.orderId,
          outcome: 'failed',
          reason: 'fraud review timed out',
          compensated,
        };
      }

      if (decision === 'reject') {
        await compensate();
        return {
          orderId: order.orderId,
          outcome: 'rejected',
          reason: 'rejected by fraud review',
          compensated,
        };
      }
    }

    stage = 'shipping';
    const shipment = await createShipment(order);
    compensations.unshift({
      step: 'shipping',
      run: () => cancelShipment(order.orderId, shipment.shipmentId),
    });

    stage = 'capture';
    const capture = await capturePayment(order, authorization.authorizationId);

    stage = 'completed';
    return {
      orderId: order.orderId,
      outcome: 'completed',
      shipmentId: shipment.shipmentId,
      captureId: capture.captureId,
      compensated,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('Order saga failed, compensating', { orderId: order.orderId, reason });
    await compensate();
    stage = 'failed';
    return { orderId: order.orderId, outcome: 'failed', reason, compensated };
  }
}
