import { compensations, readEffects } from './effects';
import { Scenario } from './scenarios';
import { OrderOutcome } from './types';

/**
 * Shared assertion + reporting so both engines produce a byte-identical
 * report format. If the two reports differ, the engines genuinely behaved
 * differently — it is not a reporting artifact.
 */

export interface ScenarioRun {
  scenario: Scenario;
  orderId: string;
  actualOutcome: OrderOutcome;
  durationMs: number;
  error?: string;
}

export interface ScenarioVerdict extends ScenarioRun {
  actualCompensations: string[];
  /**
   * Whether compensations ran in strict reverse-completion order.
   *
   * This is reported rather than asserted, because the two engines genuinely
   * differ: a Temporal saga unwinds a stack sequentially, so it is always
   * LIFO, while Zeebe fans compensation handlers out concurrently and their
   * completion order varies between runs of the same model.
   */
  lifoOrder: boolean;
  attempts: Record<string, number>;
  passed: boolean;
  problems: string[];
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

export function verdictFor(run: ScenarioRun): ScenarioVerdict {
  const actualCompensations = compensations(run.orderId);
  const problems: string[] = [];

  if (run.error) {
    problems.push(`driver error: ${run.error}`);
  }
  if (run.actualOutcome !== run.scenario.expect.outcome) {
    problems.push(`outcome ${run.actualOutcome}, expected ${run.scenario.expect.outcome}`);
  }

  // Pass/fail is on *which* effects were undone. Ordering is reported
  // separately so an engine that compensates concurrently is not scored as
  // broken for doing something it never promised.
  const expected = run.scenario.expect.compensated;
  if (!sameSet(actualCompensations, expected)) {
    problems.push(
      `compensated [${actualCompensations.join(', ')}], expected [${expected.join(', ')}]`,
    );
  }
  const lifoOrder = actualCompensations.join(',') === expected.join(',');

  const attempts: Record<string, number> = {};
  for (const effect of readEffects(run.orderId)) {
    if (effect.kind === 'attempt') {
      attempts[effect.step] = (attempts[effect.step] ?? 0) + 1;
    }
  }

  return {
    ...run,
    actualCompensations,
    lifoOrder,
    attempts,
    passed: problems.length === 0,
    problems,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function renderReport(engine: string, verdicts: ScenarioVerdict[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`=== ${engine} — order saga scenario battery ===`);
  lines.push('');

  const header = `${pad('SCENARIO', 20)} ${pad('OUTCOME', 11)} ${pad('COMPENSATED', 30)} ${pad('LIFO', 6)} ${pad('ATTEMPTS', 14)} RESULT`;
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const v of verdicts) {
    const comp = v.actualCompensations.length ? v.actualCompensations.join(' → ') : '—';
    const lifo = v.actualCompensations.length === 0 ? '—' : v.lifoOrder ? 'yes' : 'no';
    const attempts = Object.entries(v.attempts)
      .filter(([, count]) => count > 1)
      .map(([step, count]) => `${step}×${count}`)
      .join(' ');
    lines.push(
      `${pad(v.scenario.key, 20)} ${pad(v.actualOutcome, 11)} ${pad(comp, 30)} ${pad(lifo, 6)} ${pad(attempts || '—', 14)} ${v.passed ? 'PASS' : 'FAIL'}`,
    );
    for (const problem of v.problems) {
      lines.push(`${' '.repeat(20)} ↳ ${problem}`);
    }
  }

  lines.push('');
  const passed = verdicts.filter((v) => v.passed).length;
  lines.push(`${passed}/${verdicts.length} scenarios passed`);
  lines.push('');
  return lines.join('\n');
}

export function allPassed(verdicts: ScenarioVerdict[]): boolean {
  return verdicts.every((v) => v.passed);
}
