import type { ServerDeps } from './server-deps.js';
import { defaultManifestConvert } from './github-manifest.js';
import { createHash } from 'node:crypto';
import type { EventStore } from '@verity/store';
import { SealedError } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { resolveInstallationListToken } from './embedded-support.js';
import { createGitHubForgeProvider } from './github-forge-provider.js';
import { createGitHubQAAnalysis } from './github-qa-analysis.js';
import { createGitHubRateBudget, trackGitHubFetch } from './github-rate-budget.js';
import {
  createGitHubAppInstallationTokenMint,
  createGitHubAppProjectTokenMint,
  createCachedProjectTokenMint,
  PROJECT_GITHUB_TOKEN_PERMISSIONS,
  type GitHubAppCreds,
  type GitHubAppIdentityResult,
  validateGitHubAppCreds,
  resolveGitHubAppIdentity,
} from './github-app-token.js';

export function createEmbeddedGitHub(
  config: Pick<EmbeddedServerConfig, 'githubProjectTokenMint'>,
  eventStore: EventStore,
) {
  // GitHub App creds resolve from Verity settings only. The App private key lives
  // encrypted in the DB/secret store; deployment env must not pre-configure or
  // override onboarding state.
  const resolveGithubAppCreds = async (): Promise<GitHubAppCreds | undefined> => {
    const s = await eventStore.getVeritySettings();
    if (s?.githubAppId && s.githubAppPrivateKey && s.githubAppInstallationId) {
      return {
        appId: s.githubAppId,
        privateKey: s.githubAppPrivateKey,
        installationId: s.githubAppInstallationId,
      };
    }
    return undefined;
  };
  const baseMintOpts = { resolveCreds: resolveGithubAppCreds };
  // Every server-side reader spends the same App-installation quota; one budget
  // sees all of them, locks them together and keeps credential-free evidence.
  const rateBudget = createGitHubRateBudget({
    onLimit: (event) =>
      console.warn(`verity: GitHub ${event.kind} rate limit reached ${JSON.stringify(event)}`),
  });
  const githubAppAuthorityKey = async (): Promise<string | undefined> => {
    const credentials = await resolveGithubAppCreds();
    if (credentials === undefined) return undefined;
    return createHash('sha256')
      .update(credentials.appId)
      .update('\0')
      .update(credentials.installationId)
      .update('\0')
      .update(credentials.privateKey)
      .digest('hex');
  };
  // The per-project sandbox token — scoped to a LEAST-PRIVILEGE subset (audit M2)
  // instead of inheriting the full installation grant. The subset lives in
  // PROJECT_GITHUB_TOKEN_PERMISSIONS (push branches incl. `.github/workflows/*`,
  // open PRs, manage issues, and inspect/administer Actions runs).
  // Repo scope is still `[project.repo]`.
  // Minting fails closed until the installation has approved this complete set;
  // silently dropping a denied permission would give the sandbox a misleading token.
  const projectTokenMint =
    config.githubProjectTokenMint ??
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: PROJECT_GITHUB_TOKEN_PERMISSIONS,
    });

  const discoveryTokenMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: {
        metadata: 'read',
        actions: 'read',
      },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const discoveryPrTokenMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', pull_requests: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const repositoryStatusTokenMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      // Optional legacy statuses must not prevent minting the shared PR reader.
      // QA analysis uses a separate statuses token and reports missing access.
      permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', actions: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisChecksMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', checks: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisStatusesMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', statuses: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisContentsMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', contents: 'read', actions: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisReleaseMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', contents: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const analysisDeploymentMint = createCachedProjectTokenMint(
    createGitHubAppProjectTokenMint({
      ...baseMintOpts,
      permissions: { metadata: 'read', deployments: 'read' },
    }),
    { authorityKey: githubAppAuthorityKey },
  );
  const githubQAAnalysis = createGitHubQAAnalysis(
    (ref, action) => {
      const mint =
        config.githubProjectTokenMint ??
        (action === 'checks'
          ? analysisChecksMint
          : action === 'statuses'
            ? analysisStatusesMint
            : action === 'pulls' || action === 'pull_status'
              ? discoveryPrTokenMint
              : action === 'releases'
                ? analysisReleaseMint
                : action === 'deployments' || action === 'deployment_statuses'
                  ? analysisDeploymentMint
                  : action === 'workflow'
                    ? analysisContentsMint
                    : discoveryTokenMint);
      return mint(ref);
    },
    trackGitHubFetch(rateBudget, 'qa-analysis', fetch),
  );
  const issuesTokenMint = createGitHubAppProjectTokenMint({
    ...baseMintOpts,
    permissions: { metadata: 'read', issues: 'read' },
  });
  const cachedProjectTokenMint = createCachedProjectTokenMint(projectTokenMint, {
    authorityKey:
      config.githubProjectTokenMint === undefined
        ? githubAppAuthorityKey
        : () => Promise.resolve('test-github-project-token-mint'),
  });
  const installationListTokenMint = createGitHubAppInstallationTokenMint({
    ...baseMintOpts,
    permissions: { metadata: 'read' },
  });
  // The forge behind project sessions, the repository list and the release badge
  // (#1034). Open-PR lookups are built per SESSION WORKTREE, not globally from
  // config.repoDir: project sessions live in their own repos (#125). The per-worktree
  // services keep a short TTL so the visible PR bar updates quickly while repeated
  // app polls still coalesce; the token mint is re-read per lookup.
  //
  // The repository list (concept §19, #174) is the live source of the `projects`
  // cache and mints a dedicated metadata-only installation token. A sealed DB store
  // must propagate as 503 so mobile can prompt for unlock instead of showing an
  // empty repository list.
  //
  // The latest-release lookup for the project overview is non-blocking: `GET
  // /projects` reads it synchronously and it refreshes in the background on a TTL.
  const githubForge = createGitHubForgeProvider({
    discoveryTokenMint: config.githubProjectTokenMint ?? discoveryTokenMint,
    discoveryPrTokenMint: config.githubProjectTokenMint ?? discoveryPrTokenMint,
    repositoryStatusTokenMint: config.githubProjectTokenMint ?? repositoryStatusTokenMint,
    projectTokenMint: cachedProjectTokenMint,
    issuesTokenMint,
    installationToken: async () => {
      try {
        return await resolveInstallationListToken(installationListTokenMint);
      } catch (err) {
        if (err instanceof SealedError) throw err;
        return undefined;
      }
    },
    prStatusTtlMs: 2_000,
    rateBudget,
  });
  return {
    resolveGithubAppCreds,
    baseMintOpts,
    githubAppAuthorityKey,
    projectTokenMint,
    cachedProjectTokenMint,
    githubQAAnalysis,
    githubForge,
  };
}

export function createEmbeddedGitHubOnboardingBindings(
  resolveGithubAppCreds: ReturnType<typeof createEmbeddedGitHub>['resolveGithubAppCreds'],
): Pick<ServerDeps, 'githubAppValidate' | 'resolveGitHubAppIdentity' | 'manifestConvert'> {
  return {
    // Live GitHub-App credential validation for the onboarding wizard (#320). The
    // route reads + decrypts the stored creds itself (unsealed-only) and hands them
    // here; this just performs the redaction-safe test-mint against GitHub.
    githubAppValidate: (creds: GitHubAppCreds) => validateGitHubAppCreds(creds),
    // Derive the git committer identity from the App installation for the
    // signing-key onboarding step. Resolves the (decrypted) creds from settings;
    // undefined when no App is configured yet (nothing to derive).
    resolveGitHubAppIdentity: async (): Promise<GitHubAppIdentityResult | undefined> => {
      const creds = await resolveGithubAppCreds();
      return creds === undefined ? undefined : resolveGitHubAppIdentity(creds);
    },
    // Real code→App conversion for the manifest one-click onboarding routes
    // (#320). Redaction-safe by contract: never logs the PEM / GitHub body. The
    // callback route persists the returned app id + PEM via the sealed store.
    manifestConvert: defaultManifestConvert(),
  };
}
