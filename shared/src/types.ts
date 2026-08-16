/**
 * Domain types shared by both the Temporal and the Camunda 8 implementation.
 *
 * Keeping these identical is the whole point of the repo: any difference you
 * observe when running the two sagas comes from the orchestrator, not from the
 * business domain.
 */

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

/** The saga steps that can be made to fail on demand. */
export type SagaStep = 'inventory' | 'payment' | 'fraud' | 'shipping' | 'capture';

export type FraudRisk = 'low' | 'high';

export type ReviewDecision = 'approve' | 'reject';

export interface OrderRequest {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  shippingAddress: string;

  /**
   * Test hook: make this step fail. Combined with `transientFailures` this
   * drives both engines through identical failure scenarios without needing
   * to take real services down.
   */
  failAt?: SagaStep;

  /**
   * Test hook: when set, `failAt` fails this many times and then succeeds.
   * When unset (or 0) `failAt` fails permanently, which exhausts the retry
   * policy and forces the compensation path.
   */
  transientFailures?: number;

  /**
   * Test hook: forces the fraud screen's verdict. `high` routes the order
   * into human review.
   */
  fraudRisk?: FraudRisk;
}

export interface ReservationResult {
  reservationId: string;
}

export interface AuthorizationResult {
  authorizationId: string;
  amountCents: number;
}

export interface FraudResult {
  risk: FraudRisk;
  score: number;
}

export interface ShipmentResult {
  shipmentId: string;
  carrier: string;
}

export interface CaptureResult {
  captureId: string;
  amountCents: number;
}

export type OrderOutcome = 'completed' | 'rejected' | 'failed';

export interface OrderResult {
  orderId: string;
  outcome: OrderOutcome;
  /** Populated when `outcome === 'completed'`. */
  shipmentId?: string;
  captureId?: string;
  /** Populated when `outcome !== 'completed'`. */
  reason?: string;
  /** Steps whose compensation actually ran, in the order they ran. */
  compensated: string[];
}

export function orderTotalCents(items: OrderItem[]): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
}
