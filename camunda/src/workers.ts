import * as services from '@saga/shared';
import { OrderRequest, StepFailure } from '@saga/shared';
import { camundaClient } from './config';

/**
 * Job workers for every service task in the BPMN model.
 *
 * Two things here have no counterpart on the Temporal side:
 *
 * 1. The contract between model and worker is a *string*. `reserve-inventory`
 *    in the XML has to match `reserve-inventory` here. Nothing checks that at
 *    compile time — a typo just means the job is never picked up and the
 *    instance sits at that task forever.
 *
 * 2. Exhausting retries does NOT unwind the process. Zeebe's default is to
 *    raise an *incident*: the instance parks itself and waits for a human in
 *    Operate. That is a deliberate and often desirable choice, but it means
 *    saga semantics are opt-in — the worker has to translate a technical
 *    failure into a BPMN error that the model catches. See `runStep` below.
 */

const client = camundaClient();

/** Variables every job sees. `order` is set when the instance is created. */
interface SagaVariables {
  order: OrderRequest;
  reservationId?: string;
  authorizationId?: string;
  shipmentId?: string;
}

/**
 * Whatever a service returns becomes process variables. The SDK's variable
 * type isn't re-exported from the package root, so the cast in `runStep`
 * derives it from the `complete` signature instead of deep-importing it.
 */
type StepOutput = object | void;

/**
 * Wraps a service call with the retry/compensate translation described above.
 */
function runStep(name: string, work: (vars: SagaVariables) => StepOutput) {
  return client.createJobWorker({
    type: name,
    worker: `${name}-worker`,
    maxJobsToActivate: 5,
    timeout: 10_000,
    pollIntervalMs: 200,
    jobHandler: async (job) => {
      const vars = job.variables as unknown as SagaVariables;

      try {
        const output = work(vars);
        return job.complete((output ?? {}) as Parameters<typeof job.complete>[0]);
      } catch (err) {
        if (!(err instanceof StepFailure)) throw err;

        if (job.retries > 1) {
          // Still have attempts left: fail the job and let Zeebe redeliver.
          // `retryBackOff` is the broker-side equivalent of Temporal's
          // retry policy interval — but it lives here in the worker, not in
          // the process definition.
          return job.fail({
            errorMessage: err.message,
            retries: job.retries - 1,
            retryBackOff: 200,
          });
        }

        // Out of retries. Without this the instance would raise an incident
        // and park. Converting to a BPMN error is what lets the model's error
        // boundary events route into the compensation throw.
        return job.error({
          errorCode: 'STEP_FAILED',
          errorMessage: err.message,
          variables: {},
        });
      }
    },
  });
}

const workers = [
  runStep('reserve-inventory', ({ order }) => services.reserveInventory(order)),

  runStep('authorize-payment', ({ order }) => services.authorizePayment(order)),

  runStep('screen-fraud', ({ order }) => {
    const result = services.screenForFraud(order);
    // The exclusive gateway's FEEL condition reads `fraudRisk`, so the shape of
    // this output is load-bearing for the model. Renaming it breaks routing at
    // runtime, silently.
    return { fraudRisk: result.risk, fraudScore: result.score };
  }),

  runStep('create-shipment', ({ order }) => services.createShipment(order)),

  runStep('capture-payment', ({ order, authorizationId }) =>
    services.capturePayment(order, authorizationId!),
  ),

  // ---- compensation handlers -------------------------------------------
  // Attached to their tasks by compensation boundary events in the model.
  // Nothing in this file says these are compensations; that lives in the BPMN.
  runStep('release-inventory', ({ order, reservationId }) => {
    services.releaseInventory(order.orderId, reservationId!);
  }),

  runStep('void-authorization', ({ order, authorizationId }) => {
    services.voidAuthorization(order.orderId, authorizationId!);
  }),

  runStep('cancel-shipment', ({ order, shipmentId }) => {
    services.cancelShipment(order.orderId, shipmentId!);
  }),
];

console.log(`[camunda] ${workers.length} job workers polling`);

async function shutdown(): Promise<void> {
  await Promise.all(workers.map((w) => w.stop()));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
