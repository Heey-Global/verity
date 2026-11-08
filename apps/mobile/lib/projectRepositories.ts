import {
  providerName,
  pullRequestCounts,
  pullRequestSummary,
  type ProjectPullRequest,
  type ProjectRecord,
  type PullRequestState,
  type RepositoryPullRequests,
} from '@verity/mobile';

import type { StatusIntent } from '../components/ui/Status';

/**
 * The line under a project's name: what its managers wrote about it, else where its
 * code lives. Open pull requests are counted from the code host on the Repositories
 * row, never here — the sessions alone miss every pull request Verity did not open.
 */
export function projectLine(
  project: ProjectRecord,
  description: string | null | undefined,
  repositoryCount?: number,
): string {
  const written = description?.trim();
  if (written) return written;
  if (repositoryCount !== undefined && repositoryCount > 1)
    return `${String(repositoryCount)} repositories`;
  if (project.kind === 'github' || project.kind === 'forgejo')
    return `${providerName(project.kind)} · ${project.owner}/${project.repo}`;
  return 'Local project';
}

/** Pull requests that wait for someone: a failure or a conflict. */
export function needsAttention(pulls: readonly ProjectPullRequest[]): number {
  return pulls.filter((pull) => pull.state === 'failing' || pull.state === 'conflict').length;
}

/** The Repositories row on the project page: every repository summed up. */
export function repositoriesOverview(repositories: readonly RepositoryPullRequests[]): {
  subtitle: string;
  attention: number;
} {
  const pulls = repositories.flatMap((repository) => repository.pullRequests);
  const unavailable = repositories.filter((repository) => repository.status === 'unavailable');
  const where =
    repositories.length === 1
      ? repositories[0]!.name
      : `${String(repositories.length)} repositories`;
  const parts = [where];
  // With every host silent there is no count to give; "0 open PRs" would be wrong.
  if (unavailable.length < repositories.length)
    parts.push(pullRequestSummary(pullRequestCounts(pulls), 'PR'));
  if (unavailable.length > 0) parts.push(`${String(unavailable.length)} unavailable`);
  return { subtitle: parts.join(' · '), attention: needsAttention(pulls) };
}

const STATE_TAGS: Record<PullRequestState, { intent: StatusIntent; label: string }> = {
  conflict: { intent: 'needsSetup', label: 'Conflict' },
  failing: { intent: 'needsSetup', label: 'Failing' },
  running: { intent: 'transient', label: 'Running' },
  ready: { intent: 'ready', label: 'Ready' },
  blocked: { intent: 'optional', label: 'Blocked' },
  unknown: { intent: 'unknown', label: 'Unknown' },
};

export function pullRequestTag(state: PullRequestState): { intent: StatusIntent; label: string } {
  return STATE_TAGS[state];
}

/** Where a pull request came from, as its row's subtitle names it. */
export function pullRequestOrigin(pull: ProjectPullRequest): string {
  if (pull.origin.kind === 'session')
    return pull.origin.name ? `Session · ${pull.origin.name}` : 'Session';
  if (pull.origin.kind === 'renovate') return 'Renovate';
  return pull.author ? `External · ${pull.author}` : 'External';
}

/** One line on the checks, for the pull request's sheet. */
export function checksLine(pull: ProjectPullRequest): string {
  if (pull.state === 'conflict')
    return pull.baseRef ? `Conflicts with ${pull.baseRef}` : 'Conflicts with its base branch';
  const checks = pull.checks;
  if (checks === null || checks.total === 0)
    return pull.fork ? 'Checks of a fork are not shown' : 'No checks reported';
  if (checks.failed > 0) return `${String(checks.failed)} of ${String(checks.total)} checks failed`;
  if (checks.pending > 0)
    return `${String(checks.completed)} of ${String(checks.total)} checks done`;
  return checks.total === 1 ? '1 check passed' : `${String(checks.total)} checks passed`;
}
