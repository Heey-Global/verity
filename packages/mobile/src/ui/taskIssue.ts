import type { RefinedTask } from '../api.js';

/** Render a `## heading` + bullet list, or '' when the list is empty. */
function section(heading: string, items: string[]): string {
  if (items.length === 0) return '';
  return `\n\n## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`;
}

/**
 * Compose a (possibly operator-edited) {@link RefinedTask} blueprint into the GitHub
 * issue markdown BODY filed via `createTaskIssue` (ADR 0007, Voice → Refiner). The
 * title is the issue title, carried separately; empty sections are omitted. Runs
 * client-side because the operator edits the blueprint in the review sheet before
 * filing, so composition happens post-edit — this is the single source of truth for
 * the body format.
 */
export function composeRefinedIssueBody(refined: RefinedTask): string {
  return (
    refined.problem.trim() +
    section('Acceptance criteria', refined.acceptanceCriteria) +
    section('Affected areas', refined.affectedAreas) +
    section('Open questions', refined.openQuestions)
  ).trim();
}
