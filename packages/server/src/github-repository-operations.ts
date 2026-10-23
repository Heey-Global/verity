import type { ProjectRecord } from '@verity/store';
import {
  ForgeOperationError,
  type ForgeIssueView,
  type ForgePullRequestView,
  type ForgeRepositoryOperations,
} from './forge-provider.js';
import type { HttpFetch } from './github.js';

interface GitHubPullRow {
  number: number;
  node_id: string;
  title: string;
  html_url: string;
  state: string;
  merged_at?: string | null;
  draft?: boolean;
  body?: string | null;
  updated_at?: string;
  head: { ref: string; repo?: { full_name?: string } | null };
  base: { ref: string };
}

interface GitHubIssueRow {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
}

function pullView(row: GitHubPullRow): ForgePullRequestView {
  return {
    number: row.number,
    title: row.title,
    url: row.html_url,
    state: row.merged_at ? 'merged' : row.state === 'closed' ? 'closed' : 'open',
    draft: row.draft === true,
    head: row.head.ref,
    base: row.base.ref,
    body: row.body ?? '',
  };
}

export function createGitHubRepositoryOperations(options: {
  project: Pick<ProjectRecord, 'owner' | 'repo'>;
  /** Repository-scoped installation token; undefined when GitHub is not configured. */
  token: () => Promise<string | undefined>;
  fetch?: HttpFetch;
}): ForgeRepositoryOperations {
  const { project } = options;
  const doFetch: HttpFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const repoPath = `/repos/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.repo)}`;
  const fullName = `${project.owner}/${project.repo}`.toLowerCase();

  const request = async <T>(
    action: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> => {
    const token = await options.token();
    if (!token) throw new ForgeOperationError(`${action}: GitHub is not connected`, 502);
    let response;
    try {
      response = await doFetch(`https://api.github.com${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'verity-server',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(15_000),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new ForgeOperationError(`${action}: GitHub is unavailable`, 502);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return body as T;
    const detail =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? `: ${(body as { message: string }).message}`
        : '';
    if (response.status === 404) throw new ForgeOperationError(`${action}: not found`, 404);
    if (response.status === 409) throw new ForgeOperationError(`${action}: conflict${detail}`, 409);
    if (response.status === 422 || response.status === 400)
      throw new ForgeOperationError(`${action}: GitHub rejected the request${detail}`, 422);
    throw new ForgeOperationError(`${action}: GitHub is unavailable`, 502);
  };
  const orNull = async <T>(work: Promise<T>): Promise<T | null> => {
    try {
      return await work;
    } catch (error) {
      if (error instanceof ForgeOperationError && error.status === 404) return null;
      throw error;
    }
  };

  return {
    defaultBranch: async () => {
      const repo = await request<{ default_branch?: string }>('repository', repoPath);
      if (!repo.default_branch)
        throw new ForgeOperationError('repository has no default branch', 409);
      return repo.default_branch;
    },
    createPullRequest: async (input) => {
      if (input.title.trim() === '')
        throw new ForgeOperationError('a pull request needs a title', 422);
      const row = await request<GitHubPullRow>('create pull request', `${repoPath}/pulls`, {
        method: 'POST',
        // Verity never opens drafts: they hold back reviews and ready-gated workflows.
        body: {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: false,
        },
      });
      return pullView(row);
    },
    findPullRequest: async (selector) => {
      if ('number' in selector) {
        const row = await orNull(
          request<GitHubPullRow>('pull request', `${repoPath}/pulls/${selector.number}`),
        );
        return row ? pullView(row) : null;
      }
      const head = encodeURIComponent(`${project.owner}:${selector.head}`);
      const rows = await request<GitHubPullRow[]>(
        'pull request',
        `${repoPath}/pulls?state=all&head=${head}&sort=updated&direction=desc&per_page=50`,
      );
      const match = rows
        .filter(
          (row) =>
            row.head.ref === selector.head && row.head.repo?.full_name?.toLowerCase() === fullName,
        )
        .sort(
          (a, b) =>
            Number(a.state !== 'open') - Number(b.state !== 'open') ||
            (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
        )[0];
      return match ? pullView(match) : null;
    },
    markPullRequestReady: async (number) => {
      const row = await request<GitHubPullRow>('pull request', `${repoPath}/pulls/${number}`);
      if (row.draft !== true) return pullView(row);
      // REST has no endpoint for this; the GraphQL mutation is the documented way.
      const result = await request<{ errors?: { message?: string }[] }>(
        'mark pull request ready',
        '/graphql',
        {
          method: 'POST',
          body: {
            query:
              'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }',
            variables: { id: row.node_id },
          },
        },
      );
      if (result.errors?.length)
        throw new ForgeOperationError('mark pull request ready: GitHub rejected the request', 422);
      return { ...pullView(row), draft: false };
    },
    viewIssue: async (number) => {
      const row = await orNull(request<GitHubIssueRow>('issue', `${repoPath}/issues/${number}`));
      if (!row || row.pull_request !== undefined) return null;
      const view: ForgeIssueView = {
        number: row.number,
        title: row.title,
        url: row.html_url,
        state: row.state === 'closed' ? 'closed' : 'open',
        body: row.body ?? '',
        labels: (row.labels ?? [])
          .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
          .filter((name) => name !== ''),
      };
      return view;
    },
    commentOnIssue: async (number, body) => {
      const row = await request<{ html_url: string }>(
        'comment',
        `${repoPath}/issues/${number}/comments`,
        {
          method: 'POST',
          body: { body },
        },
      );
      return { url: row.html_url };
    },
  };
}
