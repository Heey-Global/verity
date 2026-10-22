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

export interface GitHubForgeProviderOptions {
  /** Cached repository-scoped installation token used for PR, release and broker calls. */
  projectTokenMint: GitHubProjectTokenMint;
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

  return {
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
    listRepositories: () => installation.listInstallationRepos(),
    latestRelease: (ref) => releases.latestRelease(ref.owner, ref.repo),
    refreshLatestRelease: (ref) => releases.refreshLatestRelease(ref.owner, ref.repo),
  };
}
