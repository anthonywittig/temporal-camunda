import * as services from '@saga/shared';
import type {
  AuthorizationResult,
  CaptureResult,
  FraudResult,
  OrderRequest,
  ReservationResult,
  ShipmentResult,
} from '@saga/shared';

/**
 * Temporal activities: thin wrappers around the shared fake services.
 *
 * Activities are ordinary async functions — no registration metadata, no
 * annotations. The worker picks them up by export name, and `proxyActivities`
 * in the workflow gets its types straight from `typeof import('./activities')`,
 * so a rename or a signature change is a compile error rather than a runtime
 * surprise. That end-to-end type link is the single biggest ergonomic
 * difference from the Camunda side, where the contract between the model and
 * the worker is a job-type string.
 */

export async function reserveInventory(order: OrderRequest): Promise<ReservationResult> {
  return services.reserveInventory(order);
}

export async function releaseInventory(orderId: string, reservationId: string): Promise<void> {
  services.releaseInventory(orderId, reservationId);
}

export async function authorizePayment(order: OrderRequest): Promise<AuthorizationResult> {
  return services.authorizePayment(order);
}

export async function voidAuthorization(orderId: string, authorizationId: string): Promise<void> {
  services.voidAuthorization(orderId, authorizationId);
}

export async function screenForFraud(order: OrderRequest): Promise<FraudResult> {
  return services.screenForFraud(order);
}

export async function createShipment(order: OrderRequest): Promise<ShipmentResult> {
  return services.createShipment(order);
}

export async function cancelShipment(orderId: string, shipmentId: string): Promise<void> {
  services.cancelShipment(orderId, shipmentId);
}

export async function capturePayment(
  order: OrderRequest,
  authorizationId: string,
): Promise<CaptureResult> {
  return services.capturePayment(order, authorizationId);
}
