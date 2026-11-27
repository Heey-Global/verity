import type { SessionSummary } from './server-types.js';

/**
 * Whether the overview shows a plan waiting for approval. The plan text can
 * run to pages and overview rows reach every device, so they carry only this.
 * `/sessions` and `session.summary` both derive it here, so the two never
 * disagree about a row's `planningPresented`.
 */
export function planningPresented(summary: {
  planning?: SessionSummary['planning'] | undefined;
  planningPlan?: SessionSummary['planningPlan'] | undefined;
}): { planningPresented?: true } {
  return summary.planning === 'active' && summary.planningPlan != null
    ? { planningPresented: true }
    : {};
}
