import type { CycleReport } from '../cycle.ts';
import { UnrecoverableError } from '../minions/errors.ts';

/**
 * A failed maintenance phase fails the job (dead, idempotency key released) rather
 * than completing it. Freshness was not stamped, so the next dispatch reruns the
 * window; an in-job retry would repeat every phase. Warnings stay a partial result.
 */
export function assertMaintenancePhasesPassed(report: CycleReport): void {
  if (report.reason === 'aborted' || report.reason === 'lock_stolen') return;
  const failed = report.phases.filter(phase => phase.status === 'fail');
  if (failed.length === 0) return;
  const detail = failed.map(phase => `${phase.phase}: ${phase.error?.message ?? phase.summary}`).join('; ');
  throw Object.assign(new UnrecoverableError(`autopilot-global-maintenance: ${failed.length} phase(s) failed: ${detail}`), { report });
}
