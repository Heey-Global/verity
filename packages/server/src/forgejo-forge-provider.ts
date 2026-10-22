import type { ProjectRecord } from '@verity/store';
import type {
  ForgeProvider,
  ForgePrService,
  ForgeRepoRef,
  PullRequestStatus,
} from './forge-provider.js';
import { ForgejoRequestError, ForgejoTransport } from './forgejo-transport.js';

interface ForgejoPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged: boolean;
  mergeable?: boolean;
  updated_at?: string;
  head: { ref: string; sha: string; repo?: { full_name?: string } };
  base: { ref: string; sha: string };
  merge_commit_sha?: string;
}
interface ForgejoStatus {
  status: string;
  context: string;
}

/** One provider instance per configured connection; no credentials or PR caches survive rotation. */
export function createForgejoForgeProvider(options: {
  transport: ForgejoTransport;
  token: () => Promise<string | undefined>;
  identityFor: (repoDir: string) => () => Promise<ForgeRepoRef | null>;
}): ForgeProvider {
  const { transport } = options;
  const coordinate = (ref: ForgeRepoRef) =>
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const parseRemote = (remote: string): ForgeRepoRef | null => {
    try {
      const url = new URL(remote);
      const base = new URL(transport.baseUrl);
      if (url.origin !== base.origin || url.username || url.password || url.search || url.hash)
        return null;
      const prefix = `${base.pathname.replace(/\/$/u, '')}/`;
      if (!url.pathname.startsWith(prefix)) return null;
      const parts = url.pathname
        .slice(prefix.length)
        .replace(/\.git$/u, '')
        .split('/');
      if (
        parts.length !== 2 ||
        parts.some((part) => !/^[a-zA-Z0-9_.-]+$/u.test(part) || part === '.' || part === '..')
      )
        return null;
      return { owner: parts[0]!.toLowerCase(), repo: parts[1]!.toLowerCase() };
    } catch {
      return null;
    }
  };
  const capabilities = {
    repositoryListing: true,
    issues: true,
    pullRequests: true,
    pullRequestMerge: true,
    checks: true,
    releases: false,
  };
  const pages = async <T>(path: string): Promise<T[]> => {
    const result: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const rows = await transport.json<T[]>(
        `${path}${path.includes('?') ? '&' : '?'}limit=50&page=${page}`,
      );
      if (!Array.isArray(rows)) throw new Error('Invalid Forgejo list response');
      if (!rows.length) return result;
      result.push(...rows);
    }
    throw new Error('Forgejo pagination limit exceeded');
  };
  const unavailable = (error: unknown) =>
    error instanceof ForgejoRequestError && [404, 405, 501].includes(error.status);
  const status = async (ref: ForgeRepoRef, pull: ForgejoPull): Promise<PullRequestStatus> => {
    let incomplete = false;
    const checks = { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 };
    const sha = pull.merged && pull.merge_commit_sha ? pull.merge_commit_sha : pull.head.sha;
    try {
      const statuses = await pages<ForgejoStatus>(
        `${coordinate(ref)}/statuses/${encodeURIComponent(sha)}`,
      );
      // Status history can contain multiple entries for one context. Forgejo
      // returns newest first, so only the first entry describes the current run.
      const contexts = new Set<string>();
      for (const check of statuses) {
        if (contexts.has(check.context)) continue;
        contexts.add(check.context);
        checks.total++;
        if (check.status === 'success') checks.successful++;
        else if (['failure', 'error'].includes(check.status)) checks.failed++;
        else checks.pending++;
      }
      checks.completed = checks.successful + checks.failed;
    } catch (error) {
      if (unavailable(error)) capabilities.checks = false;
      else incomplete = true;
    }
    let running = false;
    try {
      for (let page = 1; page <= 1000; page++) {
        const result = await transport.json<{
          workflow_runs: { status: string; commit_sha: string }[];
        }>(
          `${coordinate(ref)}/actions/runs?head_sha=${encodeURIComponent(sha)}&limit=50&page=${page}`,
        );
        if (!Array.isArray(result.workflow_runs))
          throw new Error('Invalid Forgejo Actions response');
        if (!result.workflow_runs.length) break;
        for (const run of result.workflow_runs) {
          if (run.commit_sha !== sha) continue;
          checks.total++;
          if (['success', 'skipped'].includes(run.status)) checks.successful++;
          else if (['failure', 'cancelled'].includes(run.status)) checks.failed++;
          else {
            checks.pending++;
            running ||= run.status === 'running';
          }
        }
        if (page === 1000) throw new Error('Forgejo Actions pagination limit exceeded');
      }
    } catch (error) {
      // Unsupported Actions endpoints can coexist with commit statuses. Other
      // failures must never turn a partially observed pipeline green.
      if (!unavailable(error)) incomplete = true;
    }
    checks.completed = checks.successful + checks.failed;
    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      phase: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
      ...(pull.updated_at ? { updatedAt: pull.updated_at } : {}),
      headSha: pull.head.sha,
      ...(pull.merge_commit_sha ? { mergeCommitSha: pull.merge_commit_sha } : {}),
      baseRef: pull.base.ref,
      baseSha: pull.base.sha,
      pipeline: checks.failed
        ? 'failure'
        : running
          ? 'running'
          : checks.pending
            ? 'pending'
            : incomplete
              ? 'unknown'
              : checks.total
                ? 'success'
                : 'unknown',
      checks,
      mergeable: pull.mergeable ?? null,
      mergeState:
        pull.mergeable === false ? 'dirty' : pull.mergeable === true ? 'clean' : 'unknown',
    };
  };
  const service = (repoDir: string): ForgePrService => {
    const lookup = async (branch: string) => {
      try {
        const ref = await options.identityFor(repoDir)();
        if (!ref) return null;
        const pulls = await pages<ForgejoPull>(`${coordinate(ref)}/pulls?state=all`);
        const pull = pulls
          .filter(
            (row) =>
              row.head.ref === branch &&
              row.head.repo?.full_name?.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase(),
          )
          .sort(
            (a, b) =>
              Number(a.state !== 'open') - Number(b.state !== 'open') ||
              (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
          )[0];
        return pull ? await status(ref, pull) : null;
      } catch (error) {
        if (unavailable(error)) capabilities.pullRequests = false;
        return null;
      }
    };
    return {
      prForBranch: async (branch) => {
        const pull = await lookup(branch);
        return pull?.phase === 'open' ? pull.number : null;
      },
      prStatusForBranch: lookup,
      prStatusForBranches: async (branches) => {
        const results = await Promise.all(branches.map(lookup));
        return (
          results
            .filter((row): row is PullRequestStatus => row?.phase === 'open')
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ??
          results.find((row) => row !== null) ??
          null
        );
      },
      mergePr: async (number, expectedHeadSha) => {
        try {
          const ref = await options.identityFor(repoDir)();
          if (!ref) return false;
          // Forgejo verifies head_commit_id atomically with the merge.
          await transport.json(`${coordinate(ref)}/pulls/${number}/merge`, 'POST', {
            Do: 'merge',
            ...(expectedHeadSha ? { head_commit_id: expectedHeadSha } : {}),
          });
          return true;
        } catch (error) {
          if (unavailable(error)) capabilities.pullRequestMerge = false;
          return false;
        }
      },
    };
  };
  return {
    id: 'forgejo',
    capabilities,
    parseRemote,
    cloneUrl: (ref) =>
      `${transport.baseUrl}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}.git`,
    identityFor: options.identityFor,
    mintProjectToken: options.token,
    prServiceFor: service,
    openPullRequest: async (ref, _token, pull) => {
      const row = await transport.json<ForgejoPull>(`${coordinate(ref)}/pulls`, 'POST', pull);
      return { number: row.number, url: row.html_url };
    },
    listRepositories: async () => {
      try {
        return await transport.repositories();
      } catch {
        return [];
      }
    },
    listIssues: async (project: ProjectRecord) => {
      try {
        const rows = await pages<{
          number: number;
          title: string;
          html_url: string;
          labels: { name: string }[];
          assignees?: { login: string }[];
        }>(`${coordinate(project)}/issues?state=open&type=issues`);
        return {
          connected: true,
          viewerLogin: null,
          issues: rows.map((row) => ({
            number: row.number,
            title: row.title,
            url: row.html_url,
            labels: row.labels.map((label) => label.name),
            assignees: (row.assignees ?? []).map((user) => user.login),
          })),
        };
      } catch (error) {
        if (unavailable(error)) capabilities.issues = false;
        return { connected: false, viewerLogin: null, issues: [] };
      }
    },
    latestRelease: () => null,
    refreshLatestRelease: () => Promise.resolve(null),
  };
}
