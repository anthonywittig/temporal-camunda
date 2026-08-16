import { OrderOutcome, OrderRequest, ReviewDecision } from './types';

/**
 * The scenario battery. Both engines are driven through exactly these cases,
 * and the assertions are on the shared effect log, so the results are
 * directly comparable.
 */

export interface Scenario {
  key: string;
  title: string;
  /** What this scenario is meant to expose about the two engines. */
  probes: string;
  build(runId: string): OrderRequest;
  /** Decision to send when the order lands in human review. */
  review?: ReviewDecision;
  expect: {
    outcome: OrderOutcome;
    /** Compensations expected, in execution order (LIFO). */
    compensated: string[];
  };
}

const baseItems = [
  { sku: 'WIDGET-1', quantity: 2, unitPriceCents: 4_999 },
  { sku: 'GIZMO-7', quantity: 1, unitPriceCents: 12_500 },
];

/** A large basket, over the fraud screen's 50_000 cent threshold. */
const bigItems = [{ sku: 'ANVIL-9', quantity: 3, unitPriceCents: 29_900 }];

function order(runId: string, key: string, extra: Partial<OrderRequest> = {}): OrderRequest {
  return {
    orderId: `${key}-${runId}`,
    customerId: 'cust-1001',
    items: baseItems,
    shippingAddress: '1 Alameda Ave, Burbank CA',
    ...extra,
  };
}

export const scenarios: Scenario[] = [
  {
    key: 'happy-path',
    title: 'Happy path',
    probes: 'Baseline. Every step succeeds, no compensation, no human involvement.',
    build: (runId) => order(runId, 'happy-path', { fraudRisk: 'low' }),
    expect: { outcome: 'completed', compensated: [] },
  },
  {
    key: 'transient-payment',
    title: 'Payment flaps, then recovers',
    probes:
      'Retry policy. Payment fails twice and succeeds on the third attempt. ' +
      'Temporal retries the activity; Camunda retries the job via its retry count and backoff.',
    build: (runId) =>
      order(runId, 'transient-payment', {
        fraudRisk: 'low',
        failAt: 'payment',
        transientFailures: 2,
      }),
    expect: { outcome: 'completed', compensated: [] },
  },
  {
    key: 'shipping-fails',
    title: 'Shipping fails permanently',
    probes:
      'Compensation after retries are exhausted. Inventory and payment already ' +
      'succeeded, so both must be undone in reverse order.',
    build: (runId) =>
      order(runId, 'shipping-fails', { fraudRisk: 'low', failAt: 'shipping' }),
    expect: { outcome: 'failed', compensated: ['payment', 'inventory'] },
  },
  {
    key: 'capture-fails',
    title: 'Capture fails after shipment is created',
    probes:
      'Deepest compensation path — three effects to unwind. This is where BPMN ' +
      'compensation events and a code-level compensation stack diverge most.',
    build: (runId) =>
      order(runId, 'capture-fails', { fraudRisk: 'low', failAt: 'capture' }),
    expect: { outcome: 'failed', compensated: ['shipping', 'payment', 'inventory'] },
  },
  {
    key: 'fraud-approved',
    title: 'High risk, human approves',
    probes:
      'Human-in-the-loop. Camunda gets a real user task in Tasklist; Temporal ' +
      'needs a signal handler plus your own task list and UI.',
    build: (runId) =>
      order(runId, 'fraud-approved', { items: bigItems, fraudRisk: 'high' }),
    review: 'approve',
    expect: { outcome: 'completed', compensated: [] },
  },
  {
    key: 'fraud-rejected',
    title: 'High risk, human rejects',
    probes:
      'Human rejection triggers the same compensation machinery as a technical ' +
      'failure — a business outcome, not an error.',
    build: (runId) =>
      order(runId, 'fraud-rejected', { items: bigItems, fraudRisk: 'high' }),
    review: 'reject',
    expect: { outcome: 'rejected', compensated: ['payment', 'inventory'] },
  },
];

export function scenarioByKey(key: string): Scenario | undefined {
  return scenarios.find((s) => s.key === key);
}
