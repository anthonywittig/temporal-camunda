export const TASK_QUEUE = 'order-saga';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';

export const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
