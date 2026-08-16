import { attemptCount, record } from './effects';
import {
  AuthorizationResult,
  CaptureResult,
  FraudResult,
  OrderRequest,
  ReservationResult,
  SagaStep,
  ShipmentResult,
  orderTotalCents,
} from './types';

/**
 * Fake downstream services: inventory, payments, fraud, shipping.
 *
 * Both the Temporal activities and the Camunda job workers are thin wrappers
 * around these functions, so the "business logic" is provably identical and
 * every behavioural difference you see is the orchestrator's doing.
 *
 * Every call is deterministic — IDs are derived from the order id, and
 * failures are injected via `failAt` / `transientFailures` on the request.
 * That makes the same scenario reproducible on both engines.
 */

export class StepFailure extends Error {
  constructor(
    readonly step: SagaStep,
    message: string,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

/**
 * Injected-failure gate. Call after recording the attempt so the attempt
 * counter includes the current try.
 */
function maybeFail(order: OrderRequest, step: SagaStep): void {
  if (order.failAt !== step) return;

  const transient = order.transientFailures ?? 0;
  const attempts = attemptCount(order.orderId, step);

  if (transient > 0 && attempts > transient) return; // recovered after N failures

  const kind = transient > 0 ? `transient ${attempts}/${transient}` : 'permanent';
  const message = `${step} failed (injected ${kind})`;
  record(order.orderId, step, 'failure', message);
  throw new StepFailure(step, message);
}

export function reserveInventory(order: OrderRequest): ReservationResult {
  record(order.orderId, 'inventory', 'attempt');
  maybeFail(order, 'inventory');

  const reservationId = `res-${order.orderId}`;
  record(order.orderId, 'inventory', 'success', reservationId);
  return { reservationId };
}

export function releaseInventory(orderId: string, reservationId: string): void {
  record(orderId, 'inventory', 'compensation', `released ${reservationId}`);
}

export function authorizePayment(order: OrderRequest): AuthorizationResult {
  record(order.orderId, 'payment', 'attempt');
  maybeFail(order, 'payment');

  const amountCents = orderTotalCents(order.items);
  const authorizationId = `auth-${order.orderId}`;
  record(order.orderId, 'payment', 'success', `${authorizationId} for ${amountCents}`);
  return { authorizationId, amountCents };
}

export function voidAuthorization(orderId: string, authorizationId: string): void {
  record(orderId, 'payment', 'compensation', `voided ${authorizationId}`);
}

export function screenForFraud(order: OrderRequest): FraudResult {
  record(order.orderId, 'fraud', 'attempt');
  maybeFail(order, 'fraud');

  // Deterministic default: large orders look risky. `fraudRisk` overrides it.
  const totalCents = orderTotalCents(order.items);
  const risk = order.fraudRisk ?? (totalCents > 50_000 ? 'high' : 'low');
  const score = risk === 'high' ? 88 : 12;

  record(order.orderId, 'fraud', 'success', `${risk} (score ${score})`);
  return { risk, score };
}

export function createShipment(order: OrderRequest): ShipmentResult {
  record(order.orderId, 'shipping', 'attempt');
  maybeFail(order, 'shipping');

  const shipmentId = `shp-${order.orderId}`;
  record(order.orderId, 'shipping', 'success', shipmentId);
  return { shipmentId, carrier: 'ACME Freight' };
}

export function cancelShipment(orderId: string, shipmentId: string): void {
  record(orderId, 'shipping', 'compensation', `cancelled ${shipmentId}`);
}

export function capturePayment(order: OrderRequest, authorizationId: string): CaptureResult {
  record(order.orderId, 'capture', 'attempt');
  maybeFail(order, 'capture');

  const amountCents = orderTotalCents(order.items);
  const captureId = `cap-${order.orderId}`;
  record(order.orderId, 'capture', 'success', `${captureId} for ${amountCents}`);
  return { captureId, amountCents };
}

