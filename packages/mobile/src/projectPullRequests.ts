import { z } from 'zod';

const checksSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  successful: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});

/** Where a pull request stands. A state a newer server adds reads as `unknown`. */
export const PULL_REQUEST_STATES = [
  'conflict',
  'failing',
  'running',
  'ready',
  'blocked',
  'unknown',
] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

const projectPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  branch: z.string(),
  headSha: z.string(),
  baseRef: z.string().nullable(),
  fork: z.boolean(),
  state: z.enum(PULL_REQUEST_STATES).catch('unknown'),
  checks: checksSchema.nullable(),
  viewerCanMerge: z.boolean().nullable(),
  origin: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('session'), sessionId: z.string(), name: z.string().nullable() }),
      z.object({ kind: z.literal('renovate') }),
      z.object({ kind: z.literal('external') }),
    ])
    .catch({ kind: 'external' }),
});
export type ProjectPullRequest = z.infer<typeof projectPullRequestSchema>;

const repositoryBase = {
  id: z.string(),
  name: z.string(),
  kind: z.enum(['github', 'forgejo']),
  owner: z.string(),
  repo: z.string(),
  isDefault: z.boolean(),
};

/** A connected repository and its open pull requests. "unavailable" means the code
 *  host did not answer, which is not the same as no open pull requests. */
export const repositoryPullRequestsSchema = z.discriminatedUnion('status', [
  z.object({
    ...repositoryBase,
    status: z.literal('ok'),
    webUrl: z.string(),
    pullRequests: z.array(projectPullRequestSchema),
  }),
  z.object({
    ...repositoryBase,
    status: z.literal('unavailable'),
    webUrl: z.null(),
    pullRequests: z.array(projectPullRequestSchema).max(0),
  }),
]);
export type RepositoryPullRequests = z.infer<typeof repositoryPullRequestsSchema>;

export interface PullRequestCounts {
  open: number;
  failing: number;
  conflicts: number;
}

export function pullRequestCounts(pulls: readonly ProjectPullRequest[]): PullRequestCounts {
  return {
    open: pulls.length,
    failing: pulls.filter((pull) => pull.state === 'failing').length,
    conflicts: pulls.filter((pull) => pull.state === 'conflict').length,
  };
}

/** "6 open · 2 failing · 1 conflict"; failures and conflicts only when present. */
export function pullRequestSummary(counts: PullRequestCounts, noun = ''): string {
  const open = noun === '' ? `${String(counts.open)} open` : plural(counts.open, `open ${noun}`);
  const parts = [open];
  if (counts.failing > 0) parts.push(`${String(counts.failing)} failing`);
  if (counts.conflicts > 0) parts.push(plural(counts.conflicts, 'conflict'));
  return parts.join(' · ');
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** What a pull request offers in the list: merge when green, fix when it failed
 *  and no session owns it. A session's own pull request is fixed by that session. */
export function pullRequestAction(pull: ProjectPullRequest): 'merge' | 'fix' | null {
  if (pull.state === 'ready' && pull.viewerCanMerge !== false) return 'merge';
  if ((pull.state === 'failing' || pull.state === 'conflict') && pull.origin.kind !== 'session')
    return 'fix';
  return null;
}
