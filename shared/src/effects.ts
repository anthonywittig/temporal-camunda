import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file-backed log of every side effect the fake services perform.
 *
 * Both engines write to the same log in the same format, which is what lets a
 * scenario script assert "compensation actually ran, in this order" without
 * caring which orchestrator produced it. It also survives worker restarts,
 * so it doubles as the attempt counter for transient-failure injection.
 */

export type EffectKind = 'attempt' | 'success' | 'failure' | 'compensation';

export interface Effect {
  orderId: string;
  step: string;
  kind: EffectKind;
  detail?: string;
  at: string;
}

function effectDir(): string {
  return process.env.SAGA_EFFECT_DIR ?? join(process.cwd(), '.effects');
}

function effectFile(orderId: string): string {
  return join(effectDir(), `${orderId}.jsonl`);
}

export function record(orderId: string, step: string, kind: EffectKind, detail?: string): void {
  const dir = effectDir();
  mkdirSync(dir, { recursive: true });
  const effect: Effect = { orderId, step, kind, detail, at: new Date().toISOString() };
  appendFileSync(effectFile(orderId), `${JSON.stringify(effect)}\n`, 'utf8');
}

export function readEffects(orderId: string): Effect[] {
  const file = effectFile(orderId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Effect);
}

export function clearEffects(orderId: string): void {
  const file = effectFile(orderId);
  if (existsSync(file)) rmSync(file);
}

/** How many times `step` has been attempted for this order so far. */
export function attemptCount(orderId: string, step: string): number {
  return readEffects(orderId).filter((e) => e.step === step && e.kind === 'attempt').length;
}

/** The compensations that ran, in execution order. */
export function compensations(orderId: string): string[] {
  return readEffects(orderId)
    .filter((e) => e.kind === 'compensation')
    .map((e) => e.step);
}
