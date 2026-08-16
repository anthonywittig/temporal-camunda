import { Camunda8 } from '@camunda8/sdk';
import { join } from 'node:path';

export const PROCESS_ID = 'order-saga';

export const BPMN_PATH = join(__dirname, '..', 'bpmn', 'order-saga.bpmn');

/**
 * Self-managed, auth disabled. The compose file in `infra/` turns off OAuth so
 * the sample stays about the saga rather than about token plumbing.
 */
export function camundaClient() {
  const c8 = new Camunda8({
    ZEEBE_GRPC_ADDRESS: process.env.ZEEBE_GRPC_ADDRESS ?? 'grpc://localhost:26500',
    ZEEBE_REST_ADDRESS: process.env.ZEEBE_REST_ADDRESS ?? 'http://localhost:8088',
    CAMUNDA_AUTH_STRATEGY: 'NONE',
    CAMUNDA_OAUTH_DISABLED: true,
  });
  return c8.getCamundaRestClient();
}
