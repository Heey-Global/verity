import type { ProjectRecord } from '@verity/store';
import type { GitOutput } from './branches.js';
import type { ForgePrService, ForgeProvider, ForgeRepoRef } from './forge-provider.js';
import type { GitHubProjectTokenMint } from './github-app-token.js';
import {
  createGitHubIdentityResolver,
  createGitHubInstallationService,
  createGitHubPrService,
  createGitHubReleaseService,
  openPullRequest,
  parseGitHubRemote,
  type HttpFetch,
} from './github.js';
import { listProjectGitHubIssues } from './project-github-issues.js';
import { createGitHubRepositoryOperations } from './github-repository-operations.js';

export interface GitHubForgeProviderOptions {
  /** Cached repository-scoped installation token used for PR, release and broker calls. */
  projectTokenMint: GitHubProjectTokenMint;
  discoveryTokenMint?: GitHubProjectTokenMint;
  /** Narrower read-only mint for the issue list. */
  issuesTokenMint: GitHubProjectTokenMint;
  /** Metadata-only installation token for the repository list. Rejections propagate,
   *  so a sealed secret store can surface as such instead of as an empty list. */
  installationToken: () => Promise<string | undefined>;
  /** Per-branch PR status cache TTL in ms; the service default applies when omitted. */
  prStatusTtlMs?: number;
  /** Injected git runner (tests). */
  git?: GitOutput;
  /** Injected fetch (tests). */
  fetch?: HttpFetch;
}

/**
 * The GitHub App-backed {@link ForgeProvider}. It owns the per-checkout PR services
 * and identity resolvers, and the fleet-wide installation and release services.
 */
export function createGitHubForgeProvider(opts: GitHubForgeProviderOptions): ForgeProvider {
  const fetchOpt = opts.fetch !== undefined ? { fetch: opts.fetch } : {};
  const prServices = new Map<string, ForgePrService>();
  // Share cooldowns between session worktrees of the SAME repository without
  // pausing unrelated projects that may use a different GitHub installation.
  const prFailureCooldowns = new Map<string, { until: number; inFlight?: Promise<void> }>();
  const discoveryFailureCooldowns = new Map<string, number>();
  const prFailureCooldownFor = (
    owner: string,
    repo: string,
  ): { until: number; inFlight?: Promise<void> } => {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    let cooldown = prFailureCooldowns.get(key);
    if (cooldown === undefined) {
      cooldown = { until: 0 };
      prFailureCooldowns.set(key, cooldown);
    }
    return cooldown;
  };
  // Owner/repo comes from the `origin` remote and needs no token, so identities stay
  // available on deployments without GitHub App credentials.
  const identities = new Map<string, () => Promise<ForgeRepoRef | null>>();
  const installation = createGitHubInstallationService({
    asyncToken: opts.installationToken,
    ...fetchOpt,
  });
  const releases = createGitHubReleaseService({
    asyncToken: (owner, repo) => opts.projectTokenMint({ owner, repo }),
    ...fetchOpt,
  });

  const repositoryServices = new Map<string, ForgePrService>();
  return {
    async discover(ref, page) {
      const cooldown = prFailureCooldownFor(ref.owner, ref.repo);
      const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
      if (Date.now() < Math.max(cooldown.until, discoveryFailureCooldowns.get(key) ?? 0))
        throw new Error('GitHub discovery is backing off');
      const token = await (opts.discoveryTokenMint ?? opts.projectTokenMint)(ref);
      if (!token) throw new Error('GitHub credentials unavailable');
      const read = async (path: string) => {
        const response = await (opts.fetch ?? fetch)(
          `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${path}`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) {
          const retry = Number(response.headers?.get('retry-after') ?? undefined);
          const reset = Number(response.headers?.get('x-ratelimit-reset') ?? undefined) * 1000;
          const rateLimited =
            response.status === 429 ||
            (response.status === 403 &&
              (response.headers?.get('x-ratelimit-remaining') === '0' || retry > 0));
          const until = Math.max(
            Date.now() + 60_000,
            Number.isFinite(retry) ? Date.now() + Math.min(retry * 1000, 3_600_000) : 0,
            rateLimited && Number.isFinite(reset) ? Math.min(reset, Date.now() + 3_600_000) : 0,
          );
          discoveryFailureCooldowns.set(key, until);
          // Discovery uses a different token and additional endpoints (Actions).
          // An endpoint/permission failure must not erase readable PR status;
          // only rate limiting justifies pausing both readers together.
          if (rateLimited) cooldown.until = Math.max(cooldown.until, until);
          throw new Error(`GitHub discovery unavailable (${response.status})`);
        }
        return response.json();
      };
      const repository = (await read('')) as { default_branch: string };
      const pulls = (await read(`pulls?state=open&per_page=30&page=${page}`)) as {
        number: number;
        head: { ref: string; sha: string; repo?: { full_name?: string } };
      }[];
      const body = (await read(
        `actions/runs?created=${encodeURIComponent('>=' + new Date(Date.now() - 7 * 86400_000).toISOString())}&per_page=30&page=${page}`,
      )) as {
        workflow_runs: {
          id: number;
          workflow_id: number;
          head_sha: string;
          head_branch: string;
          event: string;
          head_repository?: { full_name?: string };
          conclusion: string | null;
          html_url: string;
        }[];
      };
      if (!Array.isArray(pulls) || !Array.isArray(body.workflow_runs))
        throw new Error('Invalid GitHub discovery response');
      return {
        pulls: pulls.map((p) => ({
          number: p.number,
          branch: p.head.ref,
          sha: p.head.sha,
          fork: p.head.repo?.full_name?.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase(),
        })),
        runs: body.workflow_runs
          .filter(
            (r) =>
              r.head_branch === repository.default_branch &&
              ['push', 'schedule', 'workflow_dispatch'].includes(r.event) &&
              r.head_repository?.full_name?.toLowerCase() ===
                `${ref.owner}/${ref.repo}`.toLowerCase(),
          )
          .map((r) => ({
            id: String(r.id),
            workflow: String(r.workflow_id),
            sha: r.head_sha,
            branch: r.head_branch,
            conclusion: r.conclusion,
            url: r.html_url,
          })),
        nextPage: pulls.length === 30 || body.workflow_runs.length === 30 ? page + 1 : null,
        workflowsSupported: true,
      };
    },
    repositoryPrService(ref) {
      const key = JSON.stringify([ref.owner, ref.repo]);
      let service = repositoryServices.get(key);
      if (!service) {
        service = createGitHubPrService({
          repoDir: '',
          // Repository reads are cached by the shared, mutation-invalidated status layer.
          ttlMs: 0,
          identity: () => Promise.resolve(ref),
          asyncToken: (owner, repo) => opts.projectTokenMint({ owner, repo }),
          failureCooldownFor: prFailureCooldownFor,
          ...fetchOpt,
        });
        if (repositoryServices.size >= 200)
          repositoryServices.delete(repositoryServices.keys().next().value!);
        repositoryServices.set(key, service);
      }
      return service;
    },
    id: 'github',
    capabilities: {
      repositoryListing: true,
      issues: true,
      pullRequests: true,
      pullRequestMerge: true,
      checks: true,
      releases: true,
    },
    parseRemote: parseGitHubRemote,
    cloneUrl: (ref) => `https://github.com/${ref.owner}/${ref.repo}`,
    identityFor: (repoDir) => {
      let identity = identities.get(repoDir);
      if (identity === undefined) {
        identity = createGitHubIdentityResolver(repoDir, opts.git);
        identities.set(repoDir, identity);
      }
      return identity;
    },
    mintProjectToken: (ref) => opts.projectTokenMint(ref),
    prServiceFor: (repoDir) => {
      let svc = prServices.get(repoDir);
      if (svc === undefined) {
        svc = createGitHubPrService({
          repoDir,
          asyncToken: (owner, repo) => opts.projectTokenMint({ owner, repo }),
          ...(opts.prStatusTtlMs !== undefined ? { ttlMs: opts.prStatusTtlMs } : {}),
          failureCooldownFor: prFailureCooldownFor,
          ...(opts.git !== undefined ? { git: opts.git } : {}),
          ...fetchOpt,
        });
        prServices.set(repoDir, svc);
      }
      return svc;
    },
    openPullRequest: (target, token, pr) => openPullRequest(target, token, pr, fetchOpt),
    listIssues: (project: ProjectRecord) =>
      listProjectGitHubIssues(project, opts.issuesTokenMint, opts.fetch),
    repositoryOperations: (project) =>
      createGitHubRepositoryOperations({
        project,
        token: () => opts.projectTokenMint({ owner: project.owner, repo: project.repo }),
        ...fetchOpt,
      }),
    listRepositories: () => installation.listInstallationRepos(),
    latestRelease: (ref) => releases.latestRelease(ref.owner, ref.repo),
    refreshLatestRelease: (ref) => releases.refreshLatestRelease(ref.owner, ref.repo),
  };
}
