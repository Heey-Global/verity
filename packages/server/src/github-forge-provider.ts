import { ForgeObservationError, observationFailure } from './forge-observation-error.js';
import type { ProjectRecord } from '@verity/store';
import type { GitOutput } from './branches.js';
import type { ForgePrService, ForgeProvider, ForgeRepoRef } from './forge-provider.js';
import type { GitHubProjectTokenMint } from './github-app-token.js';
import {
  createGitHubIdentityResolver,
  createGitHubInstallationService,
  createGitHubPrService,
  createGitHubResponseCache,
  createGitHubReleaseService,
  openPullRequest,
  parseGitHubRemote,
  type HttpFetch,
} from './github.js';
import { listProjectGitHubIssues } from './project-github-issues.js';
import { createGitHubRepositoryOperations } from './github-repository-operations.js';
import { GitHubPollCache, type GitHubPollingCooldown } from './github-poll-cache.js';
import {
  trackGitHubFetch,
  type GitHubCallerCategory,
  type GitHubRateBudget,
} from './github-rate-budget.js';

export interface GitHubForgeProviderOptions {
  /** Cached repository-scoped installation token used for PR, release and broker calls. */
  projectTokenMint: GitHubProjectTokenMint;
  discoveryTokenMint?: GitHubProjectTokenMint;
  discoveryPrTokenMint?: GitHubProjectTokenMint;
  repositoryStatusTokenMint?: GitHubProjectTokenMint;
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
  /** Installation-wide rate-limit observer shared with other GitHub readers. */
  rateBudget?: GitHubRateBudget;
}

/**
 * The GitHub App-backed {@link ForgeProvider}. It owns the per-checkout PR services
 * and identity resolvers, and the fleet-wide installation and release services.
 */
export function createGitHubForgeProvider(opts: GitHubForgeProviderOptions): ForgeProvider {
  const baseFetch: HttpFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  // Every reader reports to the shared budget under its own category, so a limit
  // can be attributed to the polling path that spent the quota.
  const fetchFor = (category: GitHubCallerCategory): { fetch?: HttpFetch } =>
    opts.rateBudget
      ? { fetch: trackGitHubFetch(opts.rateBudget, category, baseFetch) }
      : opts.fetch !== undefined
        ? { fetch: opts.fetch }
        : {};
  const fetchOpt = fetchFor('other');
  const sessionStatusFetch = fetchFor('session-status');
  const repositoryStatusFetch = fetchFor('repository-status');
  const discoveryFetch = fetchFor('discovery').fetch ?? baseFetch;
  const prServices = new GitHubPollCache<string, ForgePrService>(200);
  // One validator store for every PR reader, so scoped services that are rebuilt
  // after an invalidation still revalidate with If-None-Match.
  const responseCache = createGitHubResponseCache();
  // Share cooldowns between session worktrees of the SAME repository without
  // pausing unrelated projects that may use a different GitHub installation.
  const prFailureCooldowns = new GitHubPollCache<string, GitHubPollingCooldown>(
    512,
    (value) => value.inFlight !== undefined || value.tokenRead !== undefined,
  );
  const discoveryFailureCooldowns = new GitHubPollCache<string, number>();
  const prFailureCooldownFor = (
    owner: string,
    repo: string,
    credential?: string,
  ): GitHubPollingCooldown => {
    const key = JSON.stringify([owner.toLowerCase(), repo.toLowerCase(), credential ?? null]);
    let cooldown = prFailureCooldowns.get(key);
    if (cooldown === undefined) {
      cooldown = { until: 0 };
      prFailureCooldowns.set(key, cooldown);
    }
    return cooldown;
  };
  // Owner/repo comes from the `origin` remote and needs no token, so identities stay
  // available on deployments without GitHub App credentials.
  const identities = new GitHubPollCache<string, () => Promise<ForgeRepoRef | null>>(200);
  const installation = createGitHubInstallationService({
    asyncToken: opts.installationToken,
    ...fetchOpt,
  });
  const releases = createGitHubReleaseService({
    asyncToken: (owner, repo) => opts.projectTokenMint({ owner, repo }),
    ...fetchFor('release'),
  });

  const repositoryServices = new GitHubPollCache<string, ForgePrService>(200);
  const scopedRepositoryServices = new WeakMap<
    object,
    { tokenScope: string; services: GitHubPollCache<string, ForgePrService> }
  >();
  let nextObservationScope = 0;
  return {
    async discover(ref, page) {
      const cooldown = prFailureCooldownFor(ref.owner, ref.repo);
      const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
      if (Date.now() < Math.max(cooldown.until, discoveryFailureCooldowns.get(key) ?? 0))
        throw new ForgeObservationError(
          (discoveryFailureCooldowns.get(key) ?? 0) > Date.now() ? 'rate-limit' : 'unavailable',
          'discovery-backoff',
          new Date(Math.max(cooldown.until, discoveryFailureCooldowns.get(key) ?? 0)).toISOString(),
        );
      const read = async (path: string) => {
        const mint = path.startsWith('actions/')
          ? (opts.discoveryTokenMint ?? opts.projectTokenMint)
          : (opts.discoveryPrTokenMint ?? opts.discoveryTokenMint ?? opts.projectTokenMint);
        const token = await mint(ref);
        if (!token)
          throw new ForgeObservationError('credentials', path.split('?')[0] || 'repository');
        if (Date.now() < (discoveryFailureCooldowns.get(key) ?? 0))
          throw new ForgeObservationError('rate-limit', 'discovery-backoff');
        const response = await discoveryFetch(
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
          if (rateLimited) discoveryFailureCooldowns.set(key, until);
          // Discovery uses a different token and additional endpoints (Actions).
          // An endpoint/permission failure must not erase readable PR status;
          // only rate limiting justifies pausing both readers together.
          if (rateLimited) cooldown.until = Math.max(cooldown.until, until);
          throw new ForgeObservationError(
            rateLimited
              ? 'rate-limit'
              : response.status === 403
                ? 'forbidden'
                : response.status === 401
                  ? 'credentials'
                  : 'unavailable',
            path.split('?')[0] || 'repository',
            rateLimited ? new Date(until).toISOString() : undefined,
          );
        }
        return response.json();
      };
      const errors: NonNullable<import('./forge-provider.js').ForgeDiscoveryPage['errors']> = [];
      const repository = (await read('').catch((error) => {
        errors.push(observationFailure(error, 'repository'));
        return { default_branch: null };
      })) as { default_branch: string | null };
      const pulls = (await read(`pulls?state=open&per_page=30&page=${page}`).catch((error) => {
        errors.push(observationFailure(error, 'pulls'));
        return [];
      })) as {
        number: number;
        title?: string;
        html_url?: string;
        user?: { login?: string } | null;
        head: { ref: string; sha: string; repo?: { full_name?: string } };
      }[];
      const body = (await read(
        `actions/runs?created=${encodeURIComponent('>=' + new Date(Date.now() - 7 * 86400_000).toISOString())}&per_page=30&page=${page}`,
      ).catch((error) => {
        errors.push(observationFailure(error, 'actions/runs'));
        return { workflow_runs: [] };
      })) as {
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
        errors,
        pulls: pulls.map((p) => ({
          number: p.number,
          branch: p.head.ref,
          sha: p.head.sha,
          fork: p.head.repo?.full_name?.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase(),
          ...(typeof p.title === 'string' ? { title: p.title } : {}),
          ...(typeof p.user?.login === 'string' ? { author: p.user.login } : {}),
          ...(typeof p.html_url === 'string' ? { url: p.html_url } : {}),
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
    repositoryPrService(ref, observationScope) {
      let services = repositoryServices;
      let tokenScope = 'repository-status';
      if (observationScope) {
        let scoped = scopedRepositoryServices.get(observationScope);
        if (!scoped) {
          scoped = {
            tokenScope: `repository-status:${++nextObservationScope}`,
            services: new GitHubPollCache<string, ForgePrService>(200),
          };
          scopedRepositoryServices.set(observationScope, scoped);
        }
        services = scoped.services;
        tokenScope = scoped.tokenScope;
      }
      const key = JSON.stringify([ref.owner, ref.repo]);
      let service = services.get(key);
      if (!service) {
        service = createGitHubPrService({
          repoDir: '',
          // Repository reads are cached by the shared, mutation-invalidated status layer.
          ttlMs: 0,
          reportObservationErrors: true,
          tokenScope,
          identity: () => Promise.resolve(ref),
          asyncToken: (owner, repo) =>
            (opts.repositoryStatusTokenMint ?? opts.projectTokenMint)({ owner, repo }),
          failureCooldownFor: prFailureCooldownFor,
          responseCache,
          ...repositoryStatusFetch,
        });
        services.set(key, service);
      }
      return service;
    },
    ...(opts.rateBudget
      ? {
          deferBackgroundReads: (ref: ForgeRepoRef) => opts.rateBudget!.deferBackground(ref.owner),
          rateDiagnostics: () => opts.rateBudget!.snapshot(),
        }
      : {}),
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
          tokenScope: 'project',
          asyncToken: (owner, repo) => opts.projectTokenMint({ owner, repo }),
          ...(opts.prStatusTtlMs !== undefined ? { ttlMs: opts.prStatusTtlMs } : {}),
          failureCooldownFor: prFailureCooldownFor,
          responseCache,
          ...(opts.git !== undefined ? { git: opts.git } : {}),
          ...sessionStatusFetch,
        });
        prServices.set(repoDir, svc);
      }
      return svc;
    },
    openPullRequest: (target, token, pr) => openPullRequest(target, token, pr, fetchOpt),
    listIssues: (project: ProjectRecord) =>
      listProjectGitHubIssues(project, opts.issuesTokenMint, fetchOpt.fetch),
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
