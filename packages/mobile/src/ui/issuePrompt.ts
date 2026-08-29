import type { IssueSummary } from '../api.js';

/**
 * The seed prompt for a spawn-from-issue session (#137): what the freshly-spawned
 * agent receives as its first turn so it starts working on the issue immediately.
 * Carries the issue number, title and body (the server only gets the number, for the
 * branch name — the content travels in the prompt). The body is included verbatim
 * when present; an empty body is simply omitted. The closing instruction keeps the
 * agent on the repo's branch→test→PR workflow and links the PR back to the issue.
 *
 * It names `verity-code-review run` before `mark` deliberately. This line used to
 * abbreviate the gate to "verity-code-review mark", which is the one command that
 * satisfies the pre-push hook without reviewing anything — an instruction to write
 * the marker, delivered as the session's very first turn.
 */
export function buildIssuePrompt(issue: Pick<IssueSummary, 'number' | 'title' | 'body'>): string {
  const header = `Work on GitHub issue #${String(issue.number)}: ${issue.title.trim()}`;
  const body = issue.body.trim();
  const parts = [header];
  if (body.length > 0) parts.push(body);
  parts.push(
    `Implement it end-to-end following this repo's conventions (branch, tests, ` +
      `verity-code-review run then verity-code-review mark), and open a PR that ` +
      `closes #${String(issue.number)}.`,
  );
  return parts.join('\n\n');
}
