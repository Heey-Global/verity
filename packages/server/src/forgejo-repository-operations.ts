import type { ProjectRecord } from '@verity/store';
import {
  ForgeOperationError,
  type ForgeIssueView,
  type ForgePullRequestView,
  type ForgeRepositoryOperations,
} from './forge-provider.js';
import { ForgejoRequestError, type ForgejoTransport } from './forgejo-transport.js';

interface ForgejoPullRow {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged: boolean;
  body?: string | null;
  updated_at?: string;
  head: { ref: string; repo?: { full_name?: string } | null };
  base: { ref: string };
}

interface ForgejoIssueRow {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  labels?: { name: string }[];
  pull_request?: unknown;
}

/** Forgejo has no draft flag: a title starting with one of its WIP prefixes is a draft. */
const WIP_PREFIX = /^\s*(?:wip\s*:|\[wip\])\s*/iu;

export function withoutWipPrefix(title: string): string {
  let next = title;
  while (WIP_PREFIX.test(next)) next = next.replace(WIP_PREFIX, '');
  return next.trim();
}

function pullView(row: ForgejoPullRow): ForgePullRequestView {
  return {
    number: row.number,
    title: row.title,
    url: row.html_url,
    state: row.merged ? 'merged' : row.state === 'closed' ? 'closed' : 'open',
    draft: WIP_PREFIX.test(row.title),
    head: row.head.ref,
    base: row.base.ref,
    body: row.body ?? '',
  };
}

/** Forgejo answers in its own words; agents get the reason without request internals. */
async function forgejo<T>(work: () => Promise<T>, action: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ForgeOperationError) throw error;
    if (error instanceof ForgejoRequestError) {
      if (error.status === 404) throw new ForgeOperationError(`${action}: not found`, 404);
      if (error.status === 409) throw new ForgeOperationError(`${action}: conflict`, 409);
      if (error.status === 422 || error.status === 400)
        throw new ForgeOperationError(`${action}: Forgejo rejected the request`, 422);
    }
    throw new ForgeOperationError(`${action}: Forgejo is unavailable`, 502);
  }
}

const notFound = (error: unknown) => error instanceof ForgeOperationError && error.status === 404;

export function createForgejoRepositoryOperations(
  transport: ForgejoTransport,
  project: Pick<ProjectRecord, 'owner' | 'repo'>,
): ForgeRepositoryOperations {
  const repoPath = `/repos/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.repo)}`;
  const fullName = `${project.owner}/${project.repo}`.toLowerCase();
  const pull = (number: number) =>
    forgejo(() => transport.json<ForgejoPullRow>(`${repoPath}/pulls/${number}`), 'pull request');

  return {
    defaultBranch: () =>
      forgejo(async () => {
        const repo = await transport.json<{ default_branch?: string }>(repoPath);
        if (!repo.default_branch)
          throw new ForgeOperationError('repository has no default branch', 409);
        return repo.default_branch;
      }, 'repository'),
    createPullRequest: (input) =>
      forgejo(async () => {
        // Verity never opens drafts; on Forgejo the draft marker lives in the title.
        const title = withoutWipPrefix(input.title);
        if (title === '') throw new ForgeOperationError('a pull request needs a title', 422);
        const row = await transport.json<ForgejoPullRow>(`${repoPath}/pulls`, 'POST', {
          head: input.head,
          base: input.base,
          title,
          body: input.body,
        });
        return pullView(row);
      }, 'create pull request'),
    findPullRequest: async (selector) => {
      if ('number' in selector) {
        try {
          return pullView(await pull(selector.number));
        } catch (error) {
          if (notFound(error)) return null;
          throw error;
        }
      }
      return forgejo(async () => {
        const rows: ForgejoPullRow[] = [];
        for (let page = 1; page <= 100; page++) {
          const batch = await transport.json<ForgejoPullRow[]>(
            `${repoPath}/pulls?state=all&sort=recentupdate&limit=50&page=${page}`,
          );
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.push(...batch);
        }
        // A fork's branch of the same name is not this repository's pull request.
        const match = rows
          .filter(
            (row) =>
              row.head.ref === selector.head &&
              (row.head.repo?.full_name ?? fullName).toLowerCase() === fullName,
          )
          .sort(
            (a, b) =>
              Number(a.state !== 'open') - Number(b.state !== 'open') ||
              (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
          )[0];
        return match ? pullView(match) : null;
      }, 'pull request');
    },
    markPullRequestReady: async (number) => {
      const current = pullView(await pull(number));
      if (!current.draft) return current;
      return forgejo(async () => {
        const row = await transport.json<ForgejoPullRow>(`${repoPath}/pulls/${number}`, 'PATCH', {
          title: withoutWipPrefix(current.title),
        });
        return pullView(row);
      }, 'mark pull request ready');
    },
    viewIssue: async (number) => {
      try {
        const row = await forgejo(
          () => transport.json<ForgejoIssueRow>(`${repoPath}/issues/${number}`),
          'issue',
        );
        // Forgejo serves pull requests on the issues endpoint too.
        if (row.pull_request) return null;
        const view: ForgeIssueView = {
          number: row.number,
          title: row.title,
          url: row.html_url,
          state: row.state === 'closed' ? 'closed' : 'open',
          body: row.body ?? '',
          labels: (row.labels ?? []).map((label) => label.name),
        };
        return view;
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    commentOnIssue: (number, body) =>
      forgejo(async () => {
        const row = await transport.json<{ html_url: string }>(
          `${repoPath}/issues/${number}/comments`,
          'POST',
          { body },
        );
        return { url: row.html_url };
      }, 'comment'),
  };
}
