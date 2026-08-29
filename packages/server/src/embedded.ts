import {
  ALLOWED_PERMISSION_MODES,
  AcpClaudeBackend,
  AcpCodexBackend,
  AcpOpenCodeBackend,
  CODEX_DEFAULT_MODEL,
  FileTailRunnerClient,
  InMemoryEventBus,
  isCodexModel,
  isRunnerSupervisorBackend,
  LoopbackRunnerClient,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  brokeredGrantTarget,
  brokeredGrantToolName,
  encodeCwd,
  type Backend,
  type ConductorDeps,
  type EventBus,
  type RunnerClient,
  type SupervisorRunnerClientOptions,
  type SupervisorRunnerRecoveryOptions,
  type TurnPreparationContext,
  transcriptPath,
} from '@verity/session';
import {
  createPostgresDb,
  createSealableSecretCipher,
  EventStore,
  keyMatchesVerifier,
  migrateToLatest,
  migrationProvider,
  ProjectIdentityClaimConflict,
  SealedError,
  TranscriptStore,
  WorkflowStore,
  type VeritySettingsPatch,
  type Database,
  type ProjectRecord,
} from '@verity/store';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { chmod, chown, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchCodexBundledModels, startCodexModelCatalog } from './codex-model-catalog.js';
import {
  createGitHubWorkflowGate,
  createArgoCdWorkflowGate,
  createApplicationHealthWorkflowGate,
  createOciProvenanceWorkflowGate,
  createWorkflowGateReconciler,
} from './workflow-providers.js';

export async function resolveInstallationListToken(
  dbTokenMint: () => Promise<string | undefined>,
  fallbackToken?: string | (() => string | undefined),
): Promise<string | undefined> {
  const dbToken = await dbTokenMint();
  return dbToken ?? (typeof fallbackToken === 'function' ? fallbackToken() : fallbackToken);
}

export async function resolveRepoWorktreeFetchAuthHeader(
  repoIdentity: () => Promise<RepoIdentity | null>,
  dbTokenMint: GitHubProjectTokenMint,
  fallbackToken?: GitHubTokenSource,
): Promise<string | undefined> {
  const identity = await repoIdentity();
  const dbToken = identity ? await dbTokenMint(identity) : undefined;
  const fallback = typeof fallbackToken === 'function' ? fallbackToken() : fallbackToken;
  const token = dbToken ?? fallback;
  return token ? gitAuthHeader(token) : undefined;
}

import { buildControlPlane } from './app.js';
import type { ServerDeps, ServerUpdateController } from './server.js';
import { createAuthTokenRegistry } from './auth.js';
import { CONTROL_PLANE_PROJECT_ID } from './control-plane-project.js';
import { createMcpGatewayToolExecutor } from './mcp-gateway-tools.js';
import { createControlPlaneDeliveryTool } from './workflow-control-tool.js';
import { createExpoPushTransport, createPushSender } from './push-sender.js';
import {
  createGitWorktreeProvisioner,
  repairAdminGitdirs,
  repairProjectAdminGitdirs,
  type WorktreeProvisioner,
  type GitWorktreeOptions,
} from './worktree.js';
import { createGitBranchService } from './branches.js';
import {
  createGitHubIdentityResolver,
  createGitHubInstallationService,
  createGitHubIssueService,
  createGitHubPrService,
  createGitHubReleaseService,
  openPullRequest,
  type GitHubInstallationService,
  type GitHubTokenSource,
} from './github.js';
import { createGitHubTaskService } from './github-tasks.js';
import { DockerError, createDockerClient, parseUnixBaseUrl, type DockerClient } from './docker.js';
import { startDockerGcScheduler, type DockerGcPolicy } from './docker-gc.js';
import { PreviewShareManager, sweepOrphanedPreviewShares } from './preview-share-manager.js';
import { UplinkControlClient } from './uplink-control-client.js';
import { createDockerGvisorRuntimeVerifier } from './docker-gvisor-runtime-verifier.js';
import { PINNED_RUNSC_ARGS, PINNED_RUNSC_PATH } from './gvisor-runtime-config.js';
import {
  createBrokeredSecretJobExecutor,
  type BrokeredSecretJobExecutor,
} from './brokered-secret-job-executor.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';
import { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { createGatewayRequestMacKeyring, gatewayRequestMac } from './gateway-request-mac.js';
import { createMcpGatewayTokens, type McpGatewayTokens } from './mcp-gateway-tokens.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import {
  createPostgresSecretGrantStore,
  createSecretGrantBroker,
  type SecretResolver,
  type WorkloadAuthorizer,
} from './secret-grant-broker.js';
import {
  createDopplerSecretNameLister,
  createDopplerSecretResolver,
  DopplerSecretResolutionError,
  listDopplerProjectSecretNames,
  resolveDopplerProjectSecret,
  type DopplerSecretResolverOptions,
} from './doppler-secret-resolver.js';
import type { SecretGrantIssuer } from './secret-authorization.js';
import {
  createPostgresSecretJobFrameSpool,
  type SecretJobFrameSpool,
} from './secret-job-frame-spool.js';
import {
  createSecretJobService,
  type SecretJobAuthorization,
  type SecretJobService,
} from './secret-job-service.js';
import { registerSecretJobRoutes } from './secret-job-routes.js';
import { createPostgresSecretJobStore } from './secret-job-store.js';
import { createPostgresSecretProviderCatalog } from './secret-provider-catalog.js';
import { registerSecretProviderRoutes } from './secret-provider-routes.js';
import { createPostgresSecretRevocationStore } from './secret-revocation.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';
import type { RunGrantClaims, StreamingRedactorProfile } from '@verity/secret-contracts';
import {
  createRuntimeReadinessGate,
  validateRuntimeReadinessTtl,
} from './runtime-readiness-gate.js';
import { supervisorSocketReachable } from './runner-supervisor-socket.js';
import { codexRolloutFiles, ServerCodexTranscript, ServerTranscript } from './runner-transcript.js';
import { sweepOrphanArtifacts, type SweepResult } from './session-artifact-sweep.js';
import {
  purgeSessionArtifacts as purgeSessionArtifactFiles,
  type SessionArtifactScope,
} from './session-artifacts.js';
import {
  createGitHubAppInstallationTokenMint,
  createGitHubAppProjectTokenMint,
  createCachedInstallationTokenMint,
  createCachedProjectTokenMint,
  PROJECT_GITHUB_TOKEN_PERMISSIONS,
  REGISTRY_GITHUB_TOKEN_PERMISSIONS,
  validateGitHubAppCreds,
  resolveGitHubAppIdentity,
  type GitHubAppCreds,
  type GitHubAppIdentityResult,
  type GitHubProjectTokenMint,
} from './github-app-token.js';
import { defaultManifestConvert } from './github-manifest.js';
import { createGhTokenCapabilityRegistry } from './github-token-broker.js';
import { createSigningCapabilityRegistry } from './signing-capability.js';
import { validateDopplerToken, listDopplerProjects, listDopplerConfigs } from './doppler-token.js';
import {
  completeLegacyDopplerCutover,
  hasPendingLegacyDopplerCutover,
  quarantineLegacyDopplerContainers,
} from './doppler-legacy-cutover.js';
import { revokeLegacyDopplerToken } from './doppler-token-revoke.js';
import {
  ProvisionerImpl,
  DeprovisionerImpl,
  projectClonePath,
  gitAuthHeader,
  defaultDevcontainerBuildSpawner,
  projectNetworkName,
  type ProjectRelayControl,
  type ProjectImageRefSource,
  type DevcontainerFeatureSource,
} from './provisioner.js';
import { trustedToolkitIdentity } from './runner-boundary-attestation.js';
import { reportToolkitDrift } from './toolkit-drift.js';
import { defaultSshKeygenSpawner } from './signing-key.js';
import { requestArrivedInternally } from './internal-listener.js';
import { containerNameFor } from './canonical.js';
import { DockerExecBackend, dockerHostFor } from './project-backend.js';
import { createSandboxGit } from './sandbox-git.js';
import { projectSettingsEnv, type ProjectEnvironmentSettings } from './project-settings-env.js';
import { createNodeRestrictedHttpJsonTransport } from './restricted-http-json-connector.js';
import { createBrokeredHttpConsumptionStore } from './brokered-http-consumption.js';
import { createBrokeredHttpGrantStore } from './brokered-http-grants.js';
import { createBrokeredHttpTool } from './brokered-http-tool.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';
import { reconcileProjectContainerStates } from './project-state.js';
import { createClaudeOAuthTokenProvider } from './claudeUsage.js';
import type { CodexUsageCredentialProvider } from './codexUsage.js';
import {
  createClaudeEgressIdentityService,
  type ClaudeEgressIdentityService,
} from './claude-egress-identity.js';
import type { ClaudeEgressMtlsMaterial, ClaudeEgressPeerBinding } from './claude-egress-mtls.js';
import {
  claudeEgressAgentEnv,
  claudeEgressRelayHealthy,
  claudeEgressRouteEnabled,
  claudeProjectEgressRefusal,
  claudeTransportRefusal,
} from './claude-egress-agent-env.js';
import { CONTAINER_GENERATION_LABEL } from './project-relay-migration.js';
import { projectRelayContainerName } from './project-relay-docker.js';
import { createProjectRelayRuntime } from './project-relay-runtime.js';
import type { ProjectRelayLifecycle } from './project-relay-lifecycle.js';
import {
  readCodexAccessToken,
  type AgentGatewayConfiguration,
  type CodexCredentialUpdate,
} from './agent-gateway-control.js';
import {
  startAgentGatewaySynchronizer,
  type AgentGatewaySynchronizer,
} from './agent-gateway-sync.js';
import { validateAgentGatewayRoutingConfig } from './agent-gateway-url.js';

type RepoIdentity = { owner: string; repo: string };

interface ProjectSettingsReader {
  getProjectSettings(projectId: string): Promise<ProjectEnvironmentSettings | undefined>;
}

function isProjectSettingsReader(value: unknown): value is ProjectSettingsReader {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getProjectSettings' in value &&
    typeof value.getProjectSettings === 'function'
  );
}

export async function materializeControlPlaneAgentEnv(
  secretRoot: string,
  /** Environment the agent will inherit; only read, to append to any git config
   *  entries it already carries. Defaults to this process's. */
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  const claudeDir = join(secretRoot, 'claude');
  const credentialsPath = join(claudeDir, '.credentials.json');
  // Always isolate Claude from the server user's default ~/.claude, including
  // while logged out. Authentication is injected separately as an access token.
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  env.CLAUDE_CONFIG_DIR = claudeDir;
  if (existsSync(credentialsPath)) {
    // Remove legacy refresh credentials from the runtime projection. Claude
    // children authenticate only with the centrally refreshed access-token env.
    // Truncate rather than unlink so any old bind mount loses the secret too.
    await writeFile(credentialsPath, '', { mode: 0o600 });
  }

  const codexDir = join(secretRoot, 'codex');
  const authPath = join(codexDir, 'auth.json');
  mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  env.CODEX_HOME = codexDir;
  if (existsSync(authPath)) {
    // Legacy control-plane credentials must disappear before any child can
    // inspect this isolated home. Routed Codex runs only in the dedicated Runner.
    await writeFile(authPath, '', { mode: 0o600 });
  }

  Object.assign(env, await materializeControlPlaneGitSigner(secretRoot, inherited));
  return env;
}

/**
 * Point a control-plane agent's git at a signer that explains itself.
 *
 * The control-plane container is not a place Verity provisions for committing.
 * Broker signing needs four things a project sandbox is given at creation — the
 * `verity-git-sign` wrapper, `curl` and `jq` for its HTTP call, the broker URL,
 * and a capability token file — and the container has none of them. The token
 * could not simply be added either: a signing capability is bound to a project
 * AND a container generation, and the control plane has no sandbox generation to
 * bind to. Repo work belongs in a project session, which has all of it.
 *
 * Without this, that lands as a puzzle rather than an answer. The repo's own
 * config asks for signed commits, no wrapper is reachable, so git falls back to
 * plain `ssh-keygen` and reports `No private key found for public key …` — which
 * reads as a lost or misconfigured key, and invites exactly the improvisations
 * the project forbids: hunting for another key, or committing through the API.
 *
 * So the failure is made to say what is actually true. Only `-Y sign` is
 * intercepted; every other invocation is handed to the real `ssh-keygen`, so
 * signature VERIFICATION keeps working in a control-plane session — git uses the
 * same program for both, and refusing wholesale would break reading history.
 */
async function materializeControlPlaneGitSigner(
  secretRoot: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const gitDir = join(secretRoot, 'git');
  mkdirSync(gitDir, { recursive: true, mode: 0o700 });
  const signerPath = join(gitDir, 'control-plane-git-sign');
  // Write beside it and rename into place. Every control-plane session
  // materializes this same path, and `writeFile` truncates before it writes — a
  // session starting while another one is mid-write would otherwise execute an
  // empty or half-written script, turning a deterministic refusal into a random
  // one and breaking signature verification with it. Rename within one directory
  // is atomic, so a concurrent exec sees either the old file or the new one.
  const stagedPath = `${signerPath}.${randomUUID()}`;
  await writeFile(
    stagedPath,
    `#!/bin/sh
# Generated by Verity. The control-plane container does not sign commits.
if [ "\${1:-}" = "-Y" ] && [ "\${2:-}" = "sign" ]; then
  echo "verity: the control-plane container cannot sign commits — it has no signing broker token," >&2
  echo "and a signing capability is bound to a project sandbox generation, which it does not have." >&2
  echo "Do repo work in a project session for this repository: commit, review and push from there." >&2
  exit 1
fi
exec ssh-keygen "$@"
`,
    { mode: 0o700 },
  );
  await chmod(stagedPath, 0o700);
  await rename(stagedPath, signerPath);
  // APPEND rather than claim index 0: `GIT_CONFIG_COUNT` addresses one shared
  // list, so overwriting the count would silently drop every entry already in the
  // environment — a credential helper, a proxy setting, anything a deployment
  // passes in. Appending also puts this last, and git lets the last entry for a
  // key win, so the refusal still takes precedence.
  const inheritedCount = Number.parseInt(inherited.GIT_CONFIG_COUNT ?? '', 10);
  const index = Number.isInteger(inheritedCount) && inheritedCount > 0 ? inheritedCount : 0;
  // Env-level git config outranks the repo's own, so this also neutralizes a
  // stale `gpg.ssh.program` left in a checkout — the failure stays the explained
  // one no matter which repo a control-plane session is standing in.
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${String(index)}`]: 'gpg.ssh.program',
    [`GIT_CONFIG_VALUE_${String(index)}`]: signerPath,
  };
}

interface ClaudeCredentialStore {
  getVeritySettings(): Promise<
    | {
        claudeCodeOauthCredentialsJson?: string | null;
        codexAuthJson?: string | null;
      }
    | undefined
  >;
  updateVeritySettings(patch: VeritySettingsPatch): Promise<unknown>;
}

export function startClaudeCredentialSync(
  store: ClaudeCredentialStore,
  secretRoot: string,
  onError: (error: unknown) => void = () => undefined,
): {
  close: () => Promise<void>;
  persistCredentials: (patch: VeritySettingsPatch, persist: () => Promise<void>) => Promise<void>;
  getAccessToken: () => Promise<string | undefined>;
  persistCodexCredentialUpdate: (update: CodexCredentialUpdate) => Promise<boolean>;
  onCredentialsChanged: (listener: () => void) => () => void;
} {
  const claudeDir = join(secretRoot, 'claude');
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  let closed = false;
  let tail = Promise.resolve();
  const credentialListeners = new Set<() => void>();
  const notifyCredentialListeners = (): void => {
    for (const listener of credentialListeners) {
      queueMicrotask(() => {
        try {
          listener();
        } catch {
          // Notifications are advisory; periodic reconciliation remains the fallback.
        }
      });
    }
  };

  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const persistCredentials = (
    patch: VeritySettingsPatch,
    persist: () => Promise<void>,
  ): Promise<void> =>
    exclusive(async () => {
      if (closed) throw new Error('Claude credential synchronization is closed');
      // All explicit server writers participate in this lock. DB is committed
      // first; runtime directories and Codex auth are projected afterwards.
      await persist();
      if (patch.claudeCodeOauthCredentialsJson !== undefined) {
        // An explicit login/logout is newer operator intent than a rotated bundle
        // retained after a failed DB write. Never let that old retry win later.
        tokenProvider.discardPendingCredentials?.();
      }
      await materializeControlPlaneAgentEnv(secretRoot);
      notifyCredentialListeners();
    });
  const syncFromDatabase = (): Promise<void> =>
    exclusive(async () => {
      if (closed) return;
      await materializeControlPlaneAgentEnv(secretRoot);
    });
  const tokenProvider = createClaudeOAuthTokenProvider({
    credentialsPath: '/dev/null',
    // A child may run for several minutes after spawn and cannot receive an
    // updated environment. Refresh early enough that normal long turns do not
    // cross the access-token expiry boundary.
    expirySkewMs: 10 * 60_000,
    credentialsJsonProvider: async () => {
      const value = (await store.getVeritySettings())?.claudeCodeOauthCredentialsJson;
      return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    },
    credentialsJsonUpdater: async (credentialsJson) => {
      await store.updateVeritySettings({
        claudeCodeOauthCredentialsJson: credentialsJson,
      });
      await materializeControlPlaneAgentEnv(secretRoot);
      notifyCredentialListeners();
    },
  });
  const getAccessToken = (): Promise<string | undefined> =>
    exclusive(async () => {
      if (closed) return undefined;
      // Only this queue is allowed to consume the rotating refresh token. Claude
      // children receive the resulting access token through their environment and
      // therefore never race each other at the provider refresh endpoint.
      return tokenProvider();
    });
  const persistCodexCredentialUpdate = (update: CodexCredentialUpdate): Promise<boolean> =>
    exclusive(async () => {
      if (closed) return false;
      const current = (await store.getVeritySettings())?.codexAuthJson;
      if (
        typeof current !== 'string' ||
        createHash('sha256').update(current).digest('hex') !== update.sourceRevision
      ) {
        return false;
      }
      if (createHash('sha256').update(update.authJson).digest('hex') !== update.updatedRevision) {
        throw new Error('Codex gateway credential update revision mismatch');
      }
      await store.updateVeritySettings({ codexAuthJson: update.authJson });
      notifyCredentialListeners();
      return true;
    });
  // The encrypted DB is the sole durable source. Claude children receive an
  // access token via env and never own the rotating refresh token.
  void syncFromDatabase().catch(onError);

  return {
    close: async () => {
      if (closed) {
        await tail;
        return;
      }
      closed = true;
      await tail;
      credentialListeners.clear();
    },
    persistCredentials,
    getAccessToken,
    persistCodexCredentialUpdate,
    onCredentialsChanged(listener): () => void {
      credentialListeners.add(listener);
      return () => credentialListeners.delete(listener);
    },
  };
}

export function withControlPlaneAgentCredentials(
  selected: Backend,
  /** Receives the environment the agent would otherwise inherit, so anything it
   *  produces can be computed against it rather than against `process.env` alone
   *  — the per-call `env` sits in between, and a git config list must be appended
   *  to the EFFECTIVE one or it silently drops entries. */
  loadEnv: (inherited: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>,
): Backend {
  const withoutClaudeEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('CLAUDE_')));
  const mergeEnv = async (env: NodeJS.ProcessEnv | undefined): Promise<NodeJS.ProcessEnv> => {
    const inherited = {
      ...withoutClaudeEnv(process.env),
      ...withoutClaudeEnv(env ?? {}),
    };
    return { ...inherited, ...(await loadEnv(inherited)) };
  };
  return {
    ...(selected.runnerSupervisorBackend !== undefined
      ? { runnerSupervisorBackend: selected.runnerSupervisorBackend }
      : {}),
    run: async (opts) => selected.run({ ...opts, env: await mergeEnv(opts.env) }),
    ...(selected.query !== undefined
      ? { query: async (input) => selected.query?.({ ...input, env: await mergeEnv(input.env) }) }
      : {}),
    ...(selected.closeSession !== undefined
      ? { closeSession: (sessionId: string) => selected.closeSession?.(sessionId) }
      : {}),
  };
}
import { DockerProjectRuntime } from './project-runtime.js';
import { createSandboxUpdateChecker, type SandboxVersionSource } from './sandbox-updates.js';
import { adoptHandedOffSecretKey } from './self-update/secret-key-adopter.js';
import { SERVER_COMPAT } from './self-update/compat.js';
import type { ReleaseChannelResolver } from './self-update/release-channel.js';

export interface EmbeddedServerConfig {
  /** Verified official release channel supplied by the managed deployment bootstrap. */
  serverUpdateResolver?: ReleaseChannelResolver | undefined;
  /** Control boundary to the managed Updater, supplied by the same bootstrap. */
  serverUpdateController?: ServerUpdateController | undefined;
  /** Where the release notifier remembers what it last announced. Absent = no
   *  notification; see the same field on `ServerDeps` for why that is the default. */
  serverUpdateNotifierStatePath?: string | undefined;
  /** A real Postgres connection string. Postgres is the only runtime database,
   * so the production entrypoint (main.ts) always sets this and
   * {@link buildEmbeddedServer} refuses to start without it — unless the caller
   * injects {@link EmbeddedServerConfig.openDatabase}. */
  databaseUrl?: string | undefined;
  /**
   * The data key handed over by the Server this one replaces (ADR 0008 D8).
   *
   * Set only by the self-update path, and only after this process has won the
   * control-plane generation. It is checked against the stored verifier before
   * it unlocks anything, so a key from elsewhere leaves the store sealed rather
   * than encrypting new secrets under something the operator's password cannot
   * reproduce.
   */
  adoptedSecretKeyMaterial?: string | undefined;
  /** Production-only generation expected by every pooled PostgreSQL connection. */
  controlPlaneFence?: {
    readonly generation: number;
    readonly holderId: string;
    readonly operationId: string;
  };
  /**
   * TEST-ONLY seam for opening the store, taking precedence over
   * `databaseUrl`. The hermetic test harness injects the pglite dialect from
   * `@verity/store/testing` here, which is what keeps pglite a devDependency:
   * no production code path imports WASM Postgres, so `npm ci --omit=dev` does
   * not ship it. Production leaves this undefined and `databaseUrl` decides.
   */
  openDatabase?: ((config: EmbeddedServerConfig) => Kysely<Database>) | undefined;
  /** Root for on-disk server state. Today only the runtime secrets directory
   * reads it; the test harness also uses it as the pglite data directory via
   * `openDatabase`. Omit for ephemeral state. */
  dataDir?: string | undefined;
  /** Google Drive OAuth iOS client id (ADR 0009), from `GOOGLE_AUTH_ID`. Baked
   *  into the server env at image build (no runtime Doppler). Non-secret; the app
   *  reads it via `/settings` to build the PKCE request. */
  googleDriveClientId?: string | undefined;
  /** HMAC secret for authenticated GitHub workflow webhooks. */
  workflowGithubWebhookSecret?: string | undefined;
  /** Explicit deployment policy for consequential cross-project workflow actions. */
  authorizeWorkflowAction?: ServerDeps['authorizeWorkflowAction'];
  workflowArgoCdBaseUrl?: string | undefined;
  workflowArgoCdToken?: string | undefined;
  /** Deployment-owned signed-provenance verifier. Omitted means OCI gates stay blocked. */
  workflowOciVerifier?:
    | ((input: {
        imageRepository: string;
        digest: string;
        sourceRepository: string;
        sourceCommit: string;
      }) => Promise<{ issuer: string; subject: string; provenanceUrl?: string } | null>)
    | undefined;
  /** Service-specific verification beyond generic Argo CD sync and health. */
  workflowApplicationHealthVerifier?:
    | ((input: {
        application: string;
        desiredRevision: string;
      }) => Promise<{ healthy: boolean; evidence?: Record<string, unknown>; reason?: string }>)
    | undefined;
  /** Host-visible root for runtime-materialized files that spawned sibling
   * Docker containers bind-mount (gateway config, Git signing metadata). When
   * Verity talks to the host Docker daemon from inside a container, this path
   * must be mounted into Verity at the identical host path; a named /data volume
   * is not visible to sibling containers. */
  secretMaterializationRoot?: string | undefined;
  /** Default permission mode for conductor turns (defaults to the runner's).
   * Validated against {@link ALLOWED_PERMISSION_MODES} — an unknown value throws
   * at build time rather than failing the first turn's spawn in the background. */
  permissionMode?: string | undefined;
  /** Root dir under which `POST /sessions` provisions a spawn worktree per agent
   * (defaults to `<tmpdir>/verity-sessions`). */
  workspacesDir?: string | undefined;
  /** The project git repository a spawned agent branches from (e.g. `/work` —
   * the Verity repo). When set, `POST /sessions` provisions a REAL git worktree
   * on a fresh branch (§8); omit to fall back to an empty scratch dir. */
  repoDir?: string | undefined;

  /** GitHub token — a string OR a provider fn re-consulted per lookup — for the
   * open-PR lookup that adds `PR #N` to the header (#125). Resolved at the entrypoint
   * (never here); the provider form lets the server track the fleet's rotating
   * `~/.gh-token` without a restart (#131). When set together with `repoDir`, the
   * branches endpoint reports the current branch's open PR; omit to disable the lookup
   * (the header then shows only the branch-derived issue chip). */
  githubToken?: string | (() => string | undefined) | undefined;
  /** Enable the OpenCode backend (ADR 0001 / #143, ADR 0012 Amendment 4). When set,
   * turns whose model is provider-qualified (`providerID/modelID`, e.g.
   * `deepinfra/zai-org/GLM-5`) route to `opencode-acp` in the project Sandbox; omit to
   * run Claude only. The models offered for it are {@link EmbeddedServerConfig.extraModels}:
   * unlike the retired HTTP transport there is no long-lived server to enumerate
   * providers from, and spawning an agent per picker refresh would be a poor trade. */
  openCodeEnabled?: boolean | undefined;
  /** Enable the Codex CLI backend and discover its visible model ids daily. */
  codexEnabled?: boolean | undefined;
  /** Explicit Codex model allow-list. When omitted, the bundled Codex CLI catalog is used. */
  codexModels?: readonly string[] | undefined;
  /** Test seam for the bundled Codex catalog (the sealed-boot seed). Production uses
   *  `codex debug models --bundled`, which needs neither an unlock nor a CODEX_HOME. */
  codexBundledModelLoader?: (() => Promise<string[]>) | undefined;
  /** The provider-qualified model ids (`providerID/modelID`) the picker offers for
   *  OpenCode. Read only when {@link EmbeddedServerConfig.openCodeEnabled} is set. */
  extraModels?: readonly string[] | undefined;
  /** The GitHub Projects v2 board number (under the `repoDir` origin's owner) that
   *  backs task management — the `/tasks` routes (ADR 0007). Set together with `repoDir`
   *  to wire the GraphQL task service; omit either to disable it (the `/tasks` routes
   *  then return 503 and the mobile Plan tab hides). A token source is resolved at
   *  REQUEST time (the shared `githubToken`, or App creds — env or DB-configured — for
   *  the dedicated least-privilege mint); with none, the board simply reads inert. */
  tasksProjectNumber?: number | undefined;
  /** Enable Expo push-token registration + sender (ADR 0008). */
  pushEnabled?: boolean | undefined;
  /** Optional Expo push-security access token. Never logged or persisted. */
  expoAccessToken?: string | undefined;
  /** Enable Fastify request/error logging. Off by default. */
  logger?: boolean | undefined;
  /** Docker API base URL. Two forms are supported (ADR 0003 R2):
   *  - HTTP socket-proxy (§17 fleet), e.g. `http://127.0.0.1:9234/v1.41`.
   *  - Mounted host unix socket, e.g. `unix:///var/run/docker.sock` (optionally
   *    `unix:///var/run/docker.sock:/v1.41`) for a standalone Server started
   *    with `-v /var/run/docker.sock:/var/run/docker.sock` — no proxy sidecar.
   *  When set together with `githubToken`, the multi-repo fleet-registry
   *  provisioner and deprovisioner are wired — `POST /sessions { project }` and
   *  `POST /projects/:id/deprovision` become operational. Omit → those routes
   *  return 503 (multi-repo fleet registry not configured). */
  dockerBaseUrl?: string | undefined;
  /** Enable fail-closed Docker/runsc readiness for the production Secret Job Executor path. */
  secretJobRuntimeRequired?: boolean | undefined;
  /** Test seam; production derives this checker from dockerBaseUrl and the pinned runtime config. */
  secretJobRuntimeReadiness?: (() => Promise<void>) | undefined;
  /** Test/deployment tuning for the public health probe's Docker-attestation cache. */
  secretJobRuntimeReadinessTtlMs?: number | undefined;
  /**
   * Enable the durable Brokered Secrets execution core. Provider resolution and current-policy
   * checks remain explicit collaborators until the first restricted provider/profile lands; every
   * persistence, crypto, Docker, audit, revocation, redaction, and key-binding seam is composed here.
   */
  secretJobs?:
    | {
        /** Transitional/test resolver seam. Production should configure `doppler` instead. */
        resolveSecrets?: SecretResolver;
        /** Real provider resolver. Production defaults to the durable server-owned catalog. */
        doppler?: Omit<DopplerSecretResolverOptions, 'catalog' | 'readCredential'>;
        authorizeWorkload: WorkloadAuthorizer;
        authorizeCurrentClaims: (claims: RunGrantClaims) => Promise<boolean>;
        /** Project-scoped administration boundary for provider credentials and catalog records. */
        authorizeProviderAdministration?: (
          actorId: string,
          projectId: string,
        ) => boolean | Promise<boolean>;
        redactorProfile: StreamingRedactorProfile;
        executorImageRepository: string;
        /** Build the approval/policy boundary around this exact durable grant issuer. */
        createAuthorization: (grants: SecretGrantIssuer) => SecretJobAuthorization;
        authorizeInvocation: (
          actor: import('./secret-authorization.js').AuthenticatedApprovalActor,
          invocation: import('@verity/secret-contracts').SecretToolInvocation,
        ) => Promise<boolean>;
        /**
         * Resolve the authenticated approval principal for a privately attested model tool call.
         * Omit to keep native dispatch disabled while the authenticated HTTP path remains active.
         */
      }
    | undefined;
  /** Optional `X-Registry-Auth` value for base-image pulls (ADR 0003 R6 / #299)
   *  — base64-encoded JSON `{username,password}` or an identity token, for a
   *  private registry. Default unset: the product base image is public on ghcr,
   *  so no auth is sent. Sourced from `VERITY_REGISTRY_AUTH`. Never logged. */
  registryAuth?: string | undefined;
  /** Default image ref for project containers (centrally pinned, §19.5). When
   * `dockerBaseUrl` is set but this is absent, a built-in default is used. */
  defaultProjectImage?: ProjectImageRefSource | undefined;
  /** Display version for the resolved default image. This may be a semver tag
   * while `defaultProjectImage` remains pinned by digest for reproducibility. */
  defaultProjectImageVersion?: SandboxVersionSource | undefined;
  /** Explicit published verity-sandbox-toolkit Feature ref for project
   * devcontainer builds. Production resolves `:latest` lazily with a short
   * cache so the build input is pinned but not stale. */
  devcontainerFeatureRef?: (string | (() => Promise<string | undefined>)) | undefined;
  /** Whether {@link devcontainerFeatureRef} is CONFIGURATION rather than a ref
   *  this deployment resolved for itself — only configuration may outrank the
   *  Feature baked into the Server image (see
   *  {@link toolkitFeatureRefIsConfigured}). `main.ts` passes a resolver
   *  function either way, so its presence cannot answer this; the answer has to
   *  travel with it. Omitted → read from the environment, which is what a
   *  caller that sets neither is relying on anyway. */
  devcontainerFeatureRefConfigured?: boolean | undefined;
  claudeConfigVolume?: string | undefined;
  codexConfigVolume?: string | undefined;
  opencodeConfigVolume?: string | undefined;
  piConfigVolume?: string | undefined;
  /** Path to the host-side gh-token file (e.g. `~/.gh-token`) — mounted
   * read-only in project containers so agent processes inside can `git push`.
   * Required when `dockerBaseUrl` is set. */
  ghTokenFilePath?: string | undefined;
  /** Origin allowlist for the WebSocket upgrade (anti-CSWSH, audit C1). Only
   *  enforced when non-empty; native mobile clients (no Origin) always pass. */
  wsAllowedOrigins?: readonly string[] | undefined;
  /** Unix socket owned by the standalone agent-gateway process. When set, the
   * server mirrors current TLS material and peer bindings over this control-only
   * channel. */
  agentGatewayControlSocket?: string | undefined;
  /** Ephemeral key used to unseal the standalone gateway's encrypted spill.
   * Delivered to the gateway only over its private Unix control socket. */
  agentGatewayUnsealKey?: string | undefined;
  /** Stable agent-gateway HTTPS origin. Every project is routed through it;
   *  required for every Docker-backed server. */
  agentGatewayUrl?: string | undefined;
  /** Standalone Claude listener port; must match the stable gateway URL. */
  agentGatewayClaudePort?: number | undefined;
  /** Claude-egress gateway activation (ADR 0006 D10). The internal HTTPS origin a
   *  project relay forwards Claude traffic to, e.g. `https://verity:9443`.
   *  When set (with {@link claudeConnectorPort}), the server mints a per-project
   *  client identity, projects it read-only into each sandbox, and runs ONE
   *  multi-tenant mTLS gateway that injects the real OAuth token server-side — so no
   *  OAuth token or CA private key is ever at rest in a sandbox. Omit → dormant
   *  (today's behaviour). Opt-in. */
  claudeEgressGatewayUrl?: string | undefined;
  codexEgressGatewayUrl?: string | undefined;
  /** Loopback port the sandbox's Claude connector listens on. Required together
   *  with {@link claudeEgressGatewayUrl}. */
  claudeConnectorPort?: number | undefined;
  /** Gateway certificate CN/SAN and the SNI the connector pins. Defaults to the
   *  hostname of {@link claudeEgressGatewayUrl}. */
  claudeEgressServerName?: string | undefined;
  /** Recreate sandboxes that carry only PART of an env block the provisioner writes
   *  whole — a sandbox built before the Codex egress leg existed, for instance, which
   *  answers every Codex request with a 502 until it is rebuilt. Default true.
   *  `VERITY_RECREATE_ENV_DRIFTED_SANDBOXES=off` turns it off for a deployment that
   *  would rather keep serving those 502s than have containers rebuilt under it. */
  recreateEnvDriftedSandboxes?: boolean | undefined;
  /** Bind host for the gateway listener. Defaults to `0.0.0.0` so project relays
   *  reach it over the control-plane network. The listener mandates mTLS
   *  (client cert required, TLS 1.3), so unauthenticated peers are rejected at the
   *  handshake — but the gateway port must NEVER be host-published (`docker -p`):
   *  keep it on the internal sandbox network only. */
  claudeEgressGatewayHost?: string | undefined;
  /** Digest-pinned hardened relay image. Required for every Docker-backed server. */
  projectRelayImage?: string | undefined;
  /** Supplementary group shared by the non-root server and relay. */
  projectRelayGid?: number | undefined;
  /** Complete public-preview runtime. The subscription key is deliberately not
   * part of config: it is loaded from encrypted Verity settings. */
  publicPreviews?:
    | {
        resolveConnectorImage: () => Promise<string | undefined>;
        uplinkUrl: string;
        serverVersion: string;
      }
    | undefined;
  /** Sandbox runtime hardening (security review C1). The provisioner always drops
   *  all capabilities, blocks privilege escalation, and caps PIDs by default; these
   *  tune it. See main.ts for the `VERITY_SANDBOX_*` env mapping. */
  sandboxPidsLimit?: number | undefined;
  sandboxMemoryBytes?: number | undefined;
  sandboxNanoCpus?: number | undefined;
  sandboxCapAdd?: string[] | undefined;
  sandboxAllowPrivilegeEscalation?: boolean | undefined;
  /** Port for a SECOND, non-published HTTP listener that serves the `/internal/*`
   *  routes (audit H1 follow-up). When set, `/internal/*` (the commit-signing
   *  broker) is reachable ONLY on this listener — the public API port 404s it — so
   *  the broker is off the host/LAN surface entirely. Project sandboxes use
   *  generation-bound UDS listeners through their relay, never this TCP listener. */
  internalPort?: number | undefined;
  /** Root for project clones (e.g. `<VERITY_ROOT>/workspaces`). Required when
   * `dockerBaseUrl` is set. */
  hostCloneRoot?: string | undefined;
  /** Named data volume + its in-server mount root (security review, M16). When set,
   *  per-project mounts (the `/work` clone + materialized secrets, all under
   *  `dataVolumeRoot`) are emitted as named-volume subpaths so sibling sandboxes
   *  resolve them by volume name — no host path / chown. `dataVolumeRoot` is where
   *  the server has the volume mounted (i.e. `VERITY_ROOT`). */
  dataVolume?: string | undefined;
  dataVolumeRoot?: string | undefined;
  /** Host-disk garbage collection (`docker-gc.ts`). Enabled by default wherever a
   *  Docker client exists: both caches it sweeps — superseded `verity-devc-*`
   *  image generations and orphaned anonymous volumes — are created by Verity
   *  itself and grow without bound otherwise. Set to `false` only when an external
   *  janitor owns the host's Docker disk. */
  dockerGc?: boolean | undefined;
  /** Overrides for {@link DEFAULT_DOCKER_GC_POLICY}. */
  dockerGcPolicy?: Partial<DockerGcPolicy> | undefined;
  /** Host-visible agent-seed directory mounted into project containers. */
  agentSeedHostPath?: string | undefined;
  /** Explicitly enable the unauthenticated dev-server runtime endpoint. */
  enableProjectRuntime?: boolean | undefined;
  /**
   * Opt-in (ADR 0006 Stage 2.2-prep): route conductor turns through the proven
   * event-file + control-socket transport (a {@link FileTailRunnerClient}) instead
   * of the default in-process loopback. The RunnerServer still runs IN-PROCESS —
   * only the turn's event stream + control now ride the real file/socket wire, the
   * exact wiring that stays when the RunnerServer later moves into the Sandbox.
   *
   * DEFAULT OFF: absent/false ⇒ the conductor keeps its byte-for-byte loopback
   * dispatch path (no behavior change). Sourced from `VERITY_RUNNER_TRANSPORT === '1'`.
   */
  runnerTransport?: boolean | undefined;
  /** Opt-in ADR 0006 Stage 3 supervisor mount/start. Turns remain on the existing
   * RunnerClient until the later remote-attach and production-routing stages. */
  runnerSupervisor?: boolean | undefined;
  /** Route Claude control-plane turns through the dedicated supervisor service. */
  controlPlaneRunner?: boolean | undefined;
  /**
   * Escape hatch for the startup sweep of orphaned backend transcripts
   * (`session-artifact-sweep.ts`), which deletes conversation files. `'on'` (the
   * default) sweeps; `'dry'` reports what it would remove and touches nothing; `'off'`
   * skips it entirely. Sourced from `VERITY_TRANSCRIPT_SWEEP`.
   *
   * Present because the sweep re-runs on every boot and its failure mode — a false
   * orphan — is unrecoverable. An operator who suspects one must be able to stop it
   * from the deployment, not by waiting for a rebuilt image.
   */
  transcriptSweep?: 'on' | 'dry' | 'off' | undefined;
  /** Server-side mount of the private identity volume shared only with the
   * dedicated control-plane runner. */
  controlPlaneRunnerIdentityDir?: string | undefined;
  /** Group shared by the Server and supervised Runner runtime volumes. */
  runnerRuntimeGid?: number | undefined;
  /** Assert that the configured default image is Verity's managed sandbox. */
  runnerSupervisorTrustedDefaultImage?: boolean | undefined;
  /** Test/deployment tuning for the external supervisor watchdog. */
  runnerSupervisorReconcileIntervalMs?: number | undefined;
}

export interface EmbeddedServer {
  app: FastifyInstance;
  /** Present only when the complete Secret Job collaborator set was configured atomically. */
  secretJobs?: EmbeddedSecretJobs;
  /** The self-update secret-key handoff seam (ADR 0008 D8). */
  secretKeyHandoff: EmbeddedSecretKeyHandoff;
  /**
   * The STORE-READ phase of the startup transcript sweep. Absent when the deployment has
   * no data volume or set `VERITY_TRANSCRIPT_SWEEP=off`.
   *
   * Resolves once the sweep has read the live session ids and worktrees, which is
   * everything it wants from the database; the directory walk behind it runs on. The
   * split is the point — the reads must not be in flight when {@link close} destroys the
   * connection, while a close that waited out a walk of a large volume would turn a
   * SIGTERM into a SIGKILL. Never rejects.
   */
  transcriptSweep?: Promise<void> | undefined;
  /**
   * The same sweep including its directory walk, resolving to what it did — or to
   * `undefined` if it failed (the failure is logged either way). Absent under the same
   * conditions as {@link transcriptSweep}.
   *
   * {@link close} does wait on this, but only after aborting it: the walk stops between
   * files, so the wait is one in-flight `fs` call rather than the volume. What it did not
   * reach, the next boot reaches — while a walk still deleting after `close()` resolved
   * would be deleting under a caller that believes the server is down. It is also here so
   * a caller that wants the outcome — a test pinning the wiring, a one-shot run that
   * reports it — can read the counts rather than poll the filesystem and guess when the
   * walk is done. Never rejects.
   */
  transcriptSweepWalk?: Promise<SweepResult | undefined> | undefined;
  /** Stop the server and close the database. Idempotent — repeat/concurrent
   * calls coalesce onto the first teardown (a double SIGINT/SIGTERM is safe). */
  close: (options?: { preserveProjectRelays?: boolean }) => Promise<void>;
}

/**
 * How the entrypoint reaches the in-memory data key for an update.
 *
 * Kept to the narrowest surface that ADR 0008 D8 needs, and off the Fastify
 * app entirely: the key travels between two Verity processes over the Updater's
 * control socket, and never over a route a device could reach.
 */
export interface EmbeddedSecretKeyHandoff {
  /** Key material to seal for the successor, or undefined while sealed. */
  exportKeyMaterial(): string | undefined;
}

export interface EmbeddedSecretJobs {
  broker: ReturnType<typeof createSecretGrantBroker>;
  executor: BrokeredSecretJobExecutor;
  frames: SecretJobFrameSpool;
  service: SecretJobService;
}

function isUntaggedImageRepository(repository: string): boolean {
  if (repository.includes('@')) return false;
  const components = repository.split('/');
  if (components.some((component) => component.length === 0)) return false;

  const imageName = components.at(-1);
  if (imageName === undefined || imageName.includes(':')) return false;

  const repositoryComponent = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
  if (components.length === 1) return repositoryComponent.test(imageName);

  const [registry, ...path] = components;
  if (registry === undefined) return false;
  const registryMatch = /^(?<host>[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::(?<port>[0-9]+))?$/.exec(
    registry,
  );
  if (registryMatch === null) return false;
  const port = registryMatch.groups?.port;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return false;
  return path.every((component) => repositoryComponent.test(component));
}

/**
 * Run an external, non-overlapping watchdog for Sandbox-local supervisors.
 * Identity selection happens in Docker Exec, so this does not rely on setuid
 * inside a `no-new-privileges` Sandbox.
 */
export function startRunnerSupervisorReconciler(
  reconcile: () => Promise<void>,
  intervalMs = 5_000,
  onError: (error: unknown) => void = () => undefined,
  errorReportIntervalMs = 60_000,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let lastErrorReportAt = Number.NEGATIVE_INFINITY;
  const timer = setInterval(
    () => {
      if (inFlight !== undefined || stopped) return;
      inFlight = reconcile()
        .catch((error: unknown) => {
          const now = Date.now();
          if (now - lastErrorReportAt >= errorReportIntervalMs) {
            lastErrorReportAt = now;
            onError(error);
          }
        })
        .finally(() => {
          inFlight = undefined;
        });
    },
    Math.max(1, intervalMs),
  );
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

/**
 * Build the runner-related Conductor wiring (ADR 0006). Three mutually exclusive
 * postures, selected by the deployment flags:
 *
 *  - `runnerSupervisor` (Stage 5c, opt-in): each PROJECT turn runs through a
 *    {@link SupervisorRunnerClient} bound to that project's runner-supervisor socket
 *    under `<dataVolumeRoot>/runners/<projectId>`, so an in-flight turn survives a
 *    Server restart on the Sandbox. The Server owns verbatim transcript render+tail
 *    over the shared runner-runtime mount ({@link ServerTranscript}), so
 *    `serverManagedTranscript` omits the per-turn `opts.transcript` (keeping the
 *    supervisor launch guard fail-closed and the server-side tail the single writer),
 *    and {@link SupervisorRunnerRecovery} lets startup recovery REATTACH a still-live
 *    turn (D7) instead of settling it `interrupted`. Project-less Claude ACP and Codex
 *    control-plane sessions (e.g. the concierge) use the dedicated `verity-control`
 *    supervisor so their approval-gated tools retain the same boundary.
 *  - `runnerTransport` (Stage 2.2-prep, opt-in): the proven in-process
 *    {@link FileTailRunnerClient} event-file/control-socket transport, unchanged.
 *  - neither (DEFAULT): no `runner` override ⇒ the Conductor's in-process loopback,
 *    byte-for-byte the current path, and no `serverManagedTranscript`/`runnerRecovery`.
 *
 * The supervisor posture additionally requires `dataVolumeRoot` (where the provisioner
 * roots each project's runner runtime); absent it there is no socket to bind, so the
 * wiring degrades to the `runnerTransport`/default posture rather than build a broken
 * client.
 */
export function buildRunnerConductorWiring(deps: {
  runnerSupervisor: boolean;
  runnerTransport: boolean;
  dataVolumeRoot: string | undefined;
  /** Fixed project identity used by the separately supervised control-plane runner.
   *  When absent, project-less sessions retain the legacy loopback behavior. */
  controlPlaneProjectId?: string | undefined;
  isControlPlaneProject?: ((projectId: string) => Promise<boolean>) | undefined;
  hostCloneRoot?: string | undefined;
  containerProjectRoot?: string | undefined;
  store: SupervisorRunnerClientOptions['store'];
  bus: EventBus;
  transcript: TranscriptStore;
  allocateEventFile: () => string;
  allocateControlSocket: () => string;
  getSession: SupervisorRunnerRecoveryOptions['getSession'];
  onMissingSupervisorSocket?:
    ((input: { projectId: string; socketPath: string; reason: string }) => void) | undefined;
  /** ADR 0014 D1: per-turn bearer registry for the loopback MCP gateway. Only ACP
   *  turns are issued one; the supervisor client decides that from its own backend. */
  mcpGatewayTokens?: McpGatewayTokens | undefined;
  /** ADR 0011 D2: resolve a standing grant before a prompt becomes a card + push.
   *  `channel` is supplied by the runner client from its own backend (ADR 0014 D3). */
  autoApprovePermission?:
    | ((
        sessionId: string,
        request: import('@verity/adapter-claude').PermissionRequest,
        channel: import('@verity/session').BrokeredGrantChannel,
      ) => Promise<boolean>)
    | undefined;
}): Pick<ConductorDeps, 'runner' | 'runnerRecovery' | 'serverManagedTranscript'> {
  if (deps.runnerSupervisor && deps.dataVolumeRoot !== undefined) {
    const dataVolumeRoot = deps.dataVolumeRoot;
    const sandboxPath = (path: string): string =>
      runnerSandboxPath(path, deps.hostCloneRoot, deps.containerProjectRoot);
    return {
      serverManagedTranscript: true,
      runnerRecovery: new SupervisorRunnerRecovery({
        dataVolumeRoot,
        getSession: async (sessionId) => {
          const session = await deps.getSession(sessionId);
          if (
            session?.projectId !== null &&
            session?.projectId !== undefined &&
            deps.controlPlaneProjectId !== undefined &&
            deps.isControlPlaneProject !== undefined &&
            (await deps.isControlPlaneProject(session.projectId))
          ) {
            return { projectId: deps.controlPlaneProjectId };
          }
          return session;
        },
        ...(deps.controlPlaneProjectId === undefined
          ? {}
          : { controlPlaneProjectId: deps.controlPlaneProjectId }),
      }),
      runner: async (backend, context) => {
        // Every supervised backend is an ACP one and vice versa (see
        // `RUNNER_SUPERVISOR_BACKENDS`), so ask the closed set rather than restating
        // its members here — a third and fourth agent were exactly the drift this
        // hand-rolled disjunction was waiting for.
        const isAcpBackend = isRunnerSupervisorBackend(backend.runnerSupervisorBackend);
        const controlPlaneTurn =
          isAcpBackend &&
          (context.projectId === null ||
            (deps.isControlPlaneProject !== undefined &&
              (await deps.isControlPlaneProject(context.projectId))));
        // …but being routable there is not the same as being runnable there. The
        // control-plane Runner is a single fixed container built and launched by the
        // deployment (`deploy/bin/verity-control-plane-runner-start`), not a Sandbox
        // the provisioner composes per project: it mounts no OpenCode config volume,
        // sets no `XDG_CONFIG_HOME`, and its egress client certificates address the
        // Claude and Codex gateways only. An `opencode-acp` turn started there would
        // spawn an agent with no provider configured and fail somewhere inside the
        // first prompt. Refuse it here instead, where the reason can be named — the
        // loopback fallback is not available either (ACP must never start in this
        // credential-bearing process), so a control-plane session stays on Claude or
        // Codex until that container is given OpenCode's configuration too.
        //
        // Two session shapes reach this, and the message has to fit both: one with no
        // project at all, and one whose project IS the control plane. Neither runs in a
        // provisioner-composed project Sandbox, which is where OpenCode's config volume
        // is mounted — so that, rather than "no project", is what the refusal names. A
        // project-less session on a deployment with no control-plane container at all
        // would be caught by the refusal a few lines down anyway; it gets the better
        // message here, and the wording still holds because the reason is the same.
        if (controlPlaneTurn && backend.runnerSupervisorBackend === 'opencode-acp') {
          throw new Error(
            'OpenCode is not available for control-plane sessions: they run outside the project Sandbox that carries OpenCode’s provider configuration. Choose a Claude or Codex model for this session.',
          );
        }
        const useControlPlaneRunner = controlPlaneTurn;
        const runnerProjectId = useControlPlaneRunner
          ? deps.controlPlaneProjectId
          : (context.projectId ?? undefined);
        // A deployment without the dedicated control-plane runner retains the
        // legacy loopback only for non-ACP backends. ACP must never start in
        // the credential-bearing Server process.
        if (runnerProjectId === undefined) {
          if (isAcpBackend) {
            throw new Error('ACP control-plane turns require the dedicated control-plane runner.');
          }
          return new LoopbackRunnerClient(backend);
        }
        // Only backends with a native worker adapter may cross this process boundary.
        // Nothing Verity ships lands here any more — OpenCode was the last backend
        // without one and now declares `opencode-acp` — so this is the fallback for a
        // backend that declares no supervisor protocol, including a test double.
        if (backend.runnerSupervisorBackend === undefined) {
          return new LoopbackRunnerClient(backend);
        }
        const runtimeDir = join(dataVolumeRoot, 'runners', runnerProjectId);
        // Provisioning can deliberately disable the Sandbox supervisor for a project
        // when its container boundary is not safe for Stage 5c. Native backends may
        // still use the legacy in-process loopback, but ACP must never do so:
        // its adapter belongs behind the Sandbox spawn broker and its MCP gateway
        // capability is minted for that boundary. Starting it in the credential-bearing
        // Server would silently undo the transport migration's isolation guarantee.
        //
        // The question is whether a turn can be STARTED through the socket, so ask
        // that — a presence check answers a different one. A retired generation leaves
        // its socket inode behind on the shared runtime volume, and the Server cannot
        // remove it: the runtime directory belongs to the Runner runtime GID and the
        // Server holds only traverse on it (that asymmetry is the ADR 0006 boundary,
        // not an oversight). A leftover inode passed `existsSync`, so every turn in
        // such a project died with `connect ECONNREFUSED` — the loopback fallback
        // right here never ran, for the exact condition it was written for.
        const supervisorSocket = join(runtimeDir, 'supervisor.sock');
        if (!(await supervisorSocketReachable(supervisorSocket))) {
          const reason = existsSync(supervisorSocket)
            ? 'the project supervisor socket is not accepting connections; its Sandbox generation was retired or its supervisor was disabled after a boundary attestation warning, leaving the socket behind'
            : 'the project supervisor socket is missing; provisioning may have disabled the supervisor after a Sandbox boundary attestation warning';
          deps.onMissingSupervisorSocket?.({
            projectId: runnerProjectId,
            socketPath: supervisorSocket,
            reason,
          });
          if (isAcpBackend) {
            throw new Error(
              `ACP requires a reachable project supervisor; ${reason}. Repair the project before sending another message.`,
            );
          }
          return new LoopbackRunnerClient(
            backend,
            `## Native Verity tools unavailable\n\nThis project is running through the loopback runner because ${reason}. Native brokered tools such as \`verity_http_request\` and \`verity_secret_run\` are unavailable for this session. Report this reason when a request needs one of those tools; do not silently claim only that the tool is absent. Check the project's provision warning for the attestation detail.`,
          );
        }
        const ephemeral = context.ephemeralEventSink !== undefined;
        const gatewayToolContext =
          !ephemeral && context.sessionId !== null
            ? {
                // Runtime selection and authorization identity are different for a
                // persisted control-plane project: it executes on the fixed
                // `verity-control` sidecar, but grants/audit/secret bindings belong
                // to the real persisted project record.
                projectId: runnerAuthorizationProjectId(context.projectId, runnerProjectId),
                sessionId: context.sessionId,
              }
            : undefined;
        // A gateway-eligible ACP turn that has a session to attribute to must also have
        // the registry that mints its bearer. Its absence is a misassembled Server, not
        // a runtime condition the turn can recover from. Ephemeral and meta-query turns
        // legitimately have no gateway context, while `opencode-acp` is deliberately
        // outside the named brokered-tool backend set.
        if (
          gatewayToolContext !== undefined &&
          deps.mcpGatewayTokens === undefined &&
          (backend.runnerSupervisorBackend === 'claude-acp' ||
            backend.runnerSupervisorBackend === 'codex-acp')
        ) {
          throw new Error(
            'the Server was composed without mcpGatewayTokens; a brokered-tool ACP turn cannot start without the per-turn gateway bearer registry',
          );
        }
        let ephemeralSeq = 0;
        const ephemeralFrames = new Set<string>();
        const supervisorClient: SupervisorRunnerClient = new SupervisorRunnerClient(backend, {
          runtimeDir,
          // This construction used to pass no budget at all and silently inherited the
          // client's old one-second default — which is how a `start-turn` on a busy
          // host became `runner supervisor request timed out: start-turn` while the
          // worker it started was alive and well. Starts have their own two-phase
          // budget now; this governs the short control requests (`get-turn`, `cancel`,
          // `steer`) and matches the other production call sites.
          timeoutMs: 15_000,
          onTelemetry: (telemetry) => {
            // One line per start, only when it is worth reading: a start that had to be
            // reconciled or retried, one that failed, or one slow enough that the next
            // report of a "hanging" turn should be able to point at a number. A prompt
            // `terminal` is as routine as a prompt `created` — it is what a turn
            // cancelled before its worker existed looks like — so both are quiet.
            if (
              (telemetry.outcome === 'created' || telemetry.outcome === 'terminal') &&
              telemetry.startMs < 5_000 &&
              telemetry.reconciled === undefined
            ) {
              return;
            }
            console.warn(
              `verity: runner start ${telemetry.outcome} ${JSON.stringify({
                projectId: runnerProjectId,
                turnId: telemetry.turnId,
                acceptMs: telemetry.acceptMs,
                startMs: telemetry.startMs,
                artifactMs: telemetry.artifactMs,
                activeStarts: telemetry.activeStarts,
                eventLoopDelayMs: telemetry.eventLoopDelayMs,
                outcome: telemetry.outcome,
                reconciled: telemetry.reconciled,
                // The one field that says WHICH failure this was. Without it a
                // `failed` line is the same log the incident started from: a
                // timestamp and a turn id, and nothing to act on.
                error: telemetry.error,
              })}`,
            );
          },
          store: ephemeral
            ? {
                ingestRunnerFrame: (_sessionId, frame) => {
                  const key = `${frame.runnerInstanceId}\0${frame.turnId}\0${frame.frameSeq}`;
                  if (ephemeralFrames.has(key)) {
                    return Promise.resolve({ outcome: 'duplicate' as const });
                  }
                  ephemeralFrames.add(key);
                  if (frame.event !== undefined) context.ephemeralEventSink!(frame.event);
                  ephemeralSeq += 1;
                  return Promise.resolve({
                    outcome: 'accepted' as const,
                    seq: ephemeralSeq,
                    ts: Date.now(),
                  });
                },
              }
            : deps.store,
          bus: ephemeral ? new InMemoryEventBus() : deps.bus,
          transcript: ephemeral
            ? undefined
            : backend.runnerSupervisorBackend === 'claude-acp'
              ? new ServerTranscript({ runtimeDir, transcript: deps.transcript })
              : backend.runnerSupervisorBackend === 'codex-acp'
                ? new ServerCodexTranscript({ runtimeDir, transcript: deps.transcript })
                : undefined,
          mapTurnOptions: (opts) => ({
            ...opts,
            worktree: sandboxPath(opts.worktree),
            cwd: sandboxPath(opts.cwd),
          }),
          ...(ephemeral || deps.autoApprovePermission === undefined
            ? {}
            : { autoApprovePermission: deps.autoApprovePermission }),
          ...(deps.mcpGatewayTokens === undefined || gatewayToolContext === undefined
            ? {}
            : {
                mcpGatewayTokens: {
                  issue: (turnId: string) =>
                    deps.mcpGatewayTokens!.issue({
                      projectId: gatewayToolContext.projectId,
                      sessionId: gatewayToolContext.sessionId,
                      turnId,
                    }),
                  release: (token: string) =>
                    deps.mcpGatewayTokens!.release({
                      projectId: gatewayToolContext.projectId,
                      token,
                    }),
                },
              }),
        });
        if (!ephemeral) return supervisorClient;
        const ephemeralClient: RunnerClient = {
          startTurn: (opts, hooks) => {
            let backendSessionId: string | undefined;
            const turn = supervisorClient.startTurn(opts, {
              ...hooks,
              onSession: async (id) => {
                backendSessionId = id;
                await hooks.onSession?.(id);
              },
            });
            const cleanup = async (): Promise<void> => {
              const paths: string[] = [];
              if (opts.turnId !== undefined) paths.push(join(runtimeDir, 'turns', opts.turnId));
              if (backendSessionId !== undefined) {
                if (backend.runnerSupervisorBackend === 'claude-acp') {
                  paths.push(
                    transcriptPath({
                      cwd: sandboxPath(opts.cwd),
                      sessionId: backendSessionId,
                      claudeHome: join(runtimeDir, 'claude'),
                    }),
                  );
                } else if (backend.runnerSupervisorBackend === 'codex-acp') {
                  paths.push(...(await codexRolloutFiles(runtimeDir, backendSessionId)));
                }
              }
              await Promise.all(
                paths.map(async (path) => await rm(path, { recursive: true, force: true })),
              );
            };
            return {
              ...turn,
              result: turn.result.then(
                async (result) => {
                  await cleanup();
                  return result;
                },
                async (error: unknown) => {
                  await cleanup();
                  throw error;
                },
              ),
            };
          },
        };
        return ephemeralClient;
      },
    };
  }
  if (deps.runnerTransport) {
    return {
      runner: (backend) =>
        new FileTailRunnerClient(backend, {
          store: deps.store,
          bus: deps.bus,
          allocateEventFile: deps.allocateEventFile,
          allocateControlSocket: deps.allocateControlSocket,
          ...(deps.autoApprovePermission === undefined
            ? {}
            : { autoApprovePermission: deps.autoApprovePermission }),
        }),
    };
  }
  return {};
}

/**
 * Where a project's clone is mounted inside its Sandbox, and so the root of every path a
 * session's backend sees.
 *
 * A named constant rather than two `'/work'` literals because two different callers map
 * the same worktree through {@link runnerSandboxPath}: the runner wiring, when it launches
 * a turn, and the transcript purge plus the startup sweep, when they look for — or spare —
 * the files that turn wrote. A second literal that drifted from this one would leave the
 * sweep's live-worktree guard matching nothing, and that guard is the only thing keeping a
 * switched-away session's unreproducible `subagents/` tree from being collected.
 */
export const RUNNER_CONTAINER_PROJECT_ROOT = '/work';

/** Map a Server-visible project worktree into the single-project Runner mount.
 * The first relative component is the repository directory itself; the Runner
 * mounts that directory at `containerProjectRoot`, including for the persisted
 * `verity-control` project. Paths outside the clone root are already expressed
 * in a shared namespace (for example `/srv/verity/sessions`) and stay unchanged —
 * as is every path when there is no clone root at all, which is the same answer the
 * runner itself gets from this function, so the two cannot disagree. */
export function runnerSandboxPath(
  path: string,
  hostCloneRoot: string | undefined,
  containerProjectRoot = RUNNER_CONTAINER_PROJECT_ROOT,
): string {
  if (hostCloneRoot === undefined) return path;
  const rel = relative(hostCloneRoot, path);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return path;
  const [, ...rest] = rel.split(sep);
  return join(containerProjectRoot, ...rest);
}

/**
 * The synthetic project id of the dedicated control-plane runner (ADR 0006 Amendment 1).
 *
 * Not a row in `projects`: it names the shared runtime directory that control-plane ACP
 * turns are routed to, and therefore the directory their transcripts land in. Shared
 * with {@link candidateRunnerProjectIds} so that a purge searching for those transcripts
 * and the factory that put them there cannot disagree about where they are.
 */
export const CONTROL_PLANE_RUNNER_PROJECT_ID = CONTROL_PLANE_PROJECT_ID;

/** How long {@link EmbeddedServer.close} waits for the transcript sweep's two boot
 * queries before destroying the database under them. Generous for a query that has
 * normally finished long before any close, short enough that a stuck one cannot hold a
 * SIGTERM past its grace period. */
const SWEEP_SHUTDOWN_WAIT_MS = 5_000;

/**
 * Every runner runtime a session's backend transcripts could be sitting in.
 *
 * WHICH runtime holds them is decided by the backend, not by the project alone: the
 * `runner` factory above routes supervisor-backed Claude ACP and Codex turns of a
 * control-plane project to the shared `verity-control` runtime. Mirroring that condition
 * in the purge would re-break it the next
 * time it moves, so the purge searches every candidate instead — safe because each path
 * it builds is derived from the session's own backend session ids, which are globally
 * unique. A hit under either runtime is this session's file, never a stranger's.
 *
 * An empty result means the session left nothing on any runner runtime: a project-less
 * session on a non-ACP backend gets `LoopbackRunnerClient` (see the `runnerProjectId ===
 * undefined` branch above), which writes no runtime files at all.
 */
export function candidateRunnerProjectIds(input: {
  projectId: string | null;
  /** Whether {@link input.projectId} names a `control_plane` project. */
  isControlPlaneProject: boolean;
  /** Whether this deployment runs the dedicated control-plane runner. */
  controlPlaneRunner: boolean;
}): string[] {
  const ids: string[] = [];
  if (input.projectId !== null) ids.push(input.projectId);
  if (input.controlPlaneRunner && (input.projectId === null || input.isControlPlaneProject)) {
    ids.push(CONTROL_PLANE_RUNNER_PROJECT_ID);
  }
  return ids;
}

/** Keep authorization bound to a persisted project even when execution is
 * multiplexed through a synthetic dedicated Runner identity. */
export function runnerAuthorizationProjectId(
  projectId: string | null,
  runnerProjectId: string,
): string {
  return projectId ?? runnerProjectId;
}

/** Parse a port from an env string, defaulting when unset. Rejects non-integer /
 * out-of-range values loudly — otherwise `Number('foo')` → NaN → Node coerces
 * the port to 0 and silently binds a random ephemeral port (unreachable server). */
export function parsePort(value: string | undefined, fallback = 8787): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT "${value}": expected an integer in 0-65535`);
  }
  return port;
}

/** Parse a non-negative integer env value (e.g. `VERITY_SANDBOX_PIDS_LIMIT`).
 *  Unset/empty → `undefined` (the caller's default applies). Set-but-invalid
 *  THROWS rather than silently disabling a resource limit. */
export function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid value "${value}": expected a non-negative integer`);
  }
  return n;
}

/** A default-on deployment flag: unset and empty stay on, the established false
 * spellings are an explicit opt-out, and anything else is a typo worth failing on
 * rather than silently reading as one or the other. `name` only shapes the error. */
export function parseDefaultOnFlag(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || ['1', 'true', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'off'].includes(normalized)) return false;
  throw new Error(`invalid ${name} (expected 1/true/on or 0/false/off)`);
}

/** Push is available without an Expo server credential. Treat the established
 * deployment false spellings as an explicit opt-out; unset and empty stay on. */
export function parsePushEnabled(value: string | undefined): boolean {
  return parseDefaultOnFlag(value, 'VERITY_PUSH_ENABLED');
}

/**
 * Parse the startup transcript sweep mode (`VERITY_TRANSCRIPT_SWEEP`). Unset or empty
 * is `'on'`: the sweep is the thing that keeps deleted sessions' conversations from
 * accumulating, so it has to be the behaviour a deployment gets without asking.
 *
 * A set-but-unrecognised value THROWS rather than falling back to `'on'`. An operator
 * types this variable for exactly one reason — to stop the sweep from deleting
 * something — and a typo that silently kept deleting would defeat the one purpose the
 * switch has.
 *
 * The boolean spellings {@link parsePushEnabled} accepts are taken too, and mean what
 * they say there: this is the same deployment's env file, and someone reaching for an
 * off switch under pressure writes the one the neighbouring variable taught them. Failing
 * a boot over `false` would be the crash-loop version of the same mistake the throw is
 * meant to prevent, so only a value that is neither a mode nor a boolean is rejected.
 */
export function parseTranscriptSweep(value: string | undefined): 'on' | 'dry' | 'off' {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || ['on', '1', 'true'].includes(normalized)) {
    return 'on';
  }
  if (normalized === 'dry') return 'dry';
  if (['off', '0', 'false'].includes(normalized)) return 'off';
  throw new Error('invalid VERITY_TRANSCRIPT_SWEEP (expected on, dry, or off)');
}

const OPENCODE_FLAG_ON = ['1', 'true', 'yes', 'on'];
const OPENCODE_FLAG_OFF = ['0', 'false', 'no', 'off'];

/**
 * `VERITY_OPENCODE_ENABLED`, with a hard stop for the configuration the ACP
 * migration retired.
 *
 * `OPENCODE_BASE_URL` used to be the whole of OpenCode's configuration: it named the
 * shared `opencode serve` the Server talked to, and its presence was what turned the
 * route on. Nothing reads it now (ADR 0012 Amendment 4). Left to default, a
 * deployment that still sets only that variable would boot looking healthy while
 * every stored `provider/model` id routes to Claude and fails there on an unknown
 * model — a silent, per-turn failure discovered one confusing session at a time.
 *
 * So refuse the boot instead. The variable cannot be honoured, an upgrade is exactly
 * when it is still set, and the fix is two variables named in the message. Setting
 * `VERITY_OPENCODE_ENABLED` — to EITHER value — is the operator's statement that
 * they have read it, after which the stale variable is merely ignored and only
 * worth a warning. An explicit `0` is as much an answer as an explicit `1`: it says
 * "yes, OpenCode is going away here", which is one of the two outcomes the refusal
 * asks for, and refusing it anyway would hold a deployment hostage over a variable
 * it has already declared dead. Only silence leaves the question unanswered, and only
 * that stops the boot — where silence includes a flag DECLARED EMPTY, because that is
 * the shape env plumbing produces when the value it meant to pass is missing
 * (`VERITY_OPENCODE_ENABLED=${SOMETHING_UNSET}`), not a decision anyone typed. The
 * refusal says so, so an operator who did mean "off" knows which spelling to use.
 *
 * The flag itself takes the usual spellings and, like {@link parseTranscriptSweep},
 * throws on anything else. A typo silently reading as "off" is the same failure this
 * function exists to prevent, one variable over: the deployment sets the flag, boots
 * clean, and finds out at the first OpenCode turn.
 *
 * Both messages name what turning OpenCode off costs, because the refusal recommends
 * it as one of two remedies and it is not free: the conductor routes by model format,
 * and with no OpenCode backend configured a provider-qualified id falls through to
 * Claude (`backendKey` in `conductor.ts`), which does not know it. Sessions already
 * holding such a model therefore fail their next turn until a different model is
 * picked for them. Routing them to a refusal that says so instead would read better,
 * but it is a change to the model-routing contract of ADR 0001 rather than to this
 * migration, and the same fallthrough predates it.
 */
export function parseOpenCodeEnabled(
  input: { enabled: string | undefined; legacyBaseUrl: string | undefined },
  warn?: (message: string) => void,
): boolean {
  const flag = (input.enabled ?? '').trim().toLowerCase();
  if (flag !== '' && !OPENCODE_FLAG_ON.includes(flag) && !OPENCODE_FLAG_OFF.includes(flag)) {
    throw new Error(
      `invalid VERITY_OPENCODE_ENABLED (expected ${OPENCODE_FLAG_ON.join('/')} or ` +
        `${OPENCODE_FLAG_OFF.join('/')})`,
    );
  }
  const enabled = OPENCODE_FLAG_ON.includes(flag);
  const legacy = (input.legacyBaseUrl ?? '').trim().length > 0;
  if (!legacy) return enabled;
  if (flag === '') {
    throw new Error(
      'OPENCODE_BASE_URL is set but no longer does anything: OpenCode runs over ACP in the ' +
        'project Sandbox and has no shared server to point at (ADR 0012 Amendment 4). Set ' +
        'VERITY_OPENCODE_ENABLED=1 and list the models in VERITY_EXTRA_MODELS to keep ' +
        'OpenCode, then unset OPENCODE_BASE_URL; unset it alone to drop OpenCode. ' +
        'VERITY_OPENCODE_ENABLED=0 also clears this — but declaring it empty does not, ' +
        'because an empty value is what unset plumbing produces, not an answer. ' +
        'Dropping OpenCode leaves sessions whose stored model is a provider-qualified ' +
        'id without a backend: their next turn fails until another model is picked.',
    );
  }
  if (!enabled) {
    warn?.(
      'verity: OPENCODE_BASE_URL is ignored and OpenCode is off — sessions whose stored ' +
        'model is a provider-qualified id fail their next turn until another model is ' +
        'picked. Unset OPENCODE_BASE_URL.',
    );
    return enabled;
  }
  warn?.(
    'verity: OPENCODE_BASE_URL is ignored — OpenCode runs over ACP in the project Sandbox. ' +
      'Unset it.',
  );
  return enabled;
}

/** ACP adapters must only run behind the supervised sandbox boundary. */
export function acpSupervisorWiringRefusal(input: {
  runnerSupervisorBackend: string | undefined;
  runnerSupervisor: boolean;
  dataVolumeRootAvailable: boolean;
  dockerAvailable: boolean;
  cloneRootAvailable: boolean;
}): string | undefined {
  if (!isRunnerSupervisorBackend(input.runnerSupervisorBackend)) return undefined;
  return input.runnerSupervisor &&
    input.dataVolumeRootAvailable &&
    input.dockerAvailable &&
    input.cloneRootAvailable
    ? undefined
    : 'ACP requires complete runner supervisor wiring. Enable the project supervisor before sending another message.';
}

/** Parse a memory size (`VERITY_SANDBOX_MEMORY`) into bytes. Accepts a plain byte
 *  count or a `k`/`m`/`g`/`t` (optionally `b`) suffix, e.g. `512m`, `4g`, `2gb`.
 *  Unset/empty → `undefined` (unlimited). Set-but-invalid THROWS. */
export function parseByteSize(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i.exec(value.trim());
  if (m === null) {
    throw new Error(`invalid byte size "${value}": expected e.g. 512m, 4g, or a byte count`);
  }
  const unit = m[2]?.toLowerCase();
  const scale =
    unit === 'k'
      ? 1024
      : unit === 'm'
        ? 1024 ** 2
        : unit === 'g'
          ? 1024 ** 3
          : unit === 't'
            ? 1024 ** 4
            : 1;
  return Math.floor(Number(m[1]) * scale);
}

/** Parse a CPU-core count (`VERITY_SANDBOX_CPUS`, e.g. `1.5`) into Docker
 *  nano-CPUs (1 core = 1e9). Unset/empty → `undefined` (unlimited). Invalid THROWS. */
export function parseCpuCores(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid CPU count "${value}": expected a positive number of cores`);
  }
  return Math.floor(n * 1e9);
}

/**
 * Parse the optional GitHub Projects v2 board number that backs task management
 * (ADR 0007) from `VERITY_TASKS_PROJECT_NUMBER`. Unset/empty → `undefined`: the
 * feature stays off and the `/tasks` routes 503 (the mobile Plan tab hides).
 * Set-but-invalid THROWS (fail loud rather than silently disabling) — a board
 * number is a positive integer (`github.com/orgs/<owner>/projects/<number>`).
 */
export function parseTasksProjectNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid VERITY_TASKS_PROJECT_NUMBER "${value}": expected a positive integer`);
  }
  return n;
}

export function devcontainerBuildOptionsForDockerBaseUrl(dockerBaseUrl: string): {
  devcontainerBuild: typeof defaultDevcontainerBuildSpawner;
  dockerHostForBuild: string;
} {
  return {
    devcontainerBuild: defaultDevcontainerBuildSpawner,
    dockerHostForBuild: dockerHostFor(dockerBaseUrl),
  };
}

const SANDBOX_TOOLKIT_FEATURE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit';
const DEFAULT_SANDBOX_TOOLKIT_FEATURE_REF = `${SANDBOX_TOOLKIT_FEATURE_REPO}:1.14.1`;

function rejectLatestImageRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (trimmed.endsWith(':latest')) {
    throw new Error(`${label} must be pinned to a version or digest, not :latest`);
  }
  return trimmed;
}

/**
 * The toolkit Feature is published to GHCR under BARE semver tags (`…:1.14.0`).
 * The `v`-prefixed tags (`…:v1.14.0`) are visible-version image indexes, NOT
 * resolvable devcontainer Feature manifests — the devcontainer CLI fails with
 * "could not resolve Feature manifest" on them. Auto-detect and strip a leading
 * `v` from the tag so a ref pinned either way resolves. Digest pins (`@sha256:…`)
 * and tagless refs are returned untouched.
 */
export function normalizeFeatureTag(ref: string): string {
  if (ref.includes('@')) return ref;
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', lastSlash + 1);
  if (colon === -1) return ref;
  const tag = ref.slice(colon + 1);
  return /^v\d/.test(tag) ? `${ref.slice(0, colon)}:${tag.slice(1)}` : ref;
}

/** The repository portion of an OCI ref (drops any `:tag` and `@digest`). */
function featureRepoFromRef(ref: string): string {
  const at = ref.indexOf('@');
  const noDigest = at === -1 ? ref : ref.slice(0, at);
  const lastSlash = noDigest.lastIndexOf('/');
  const colon = noDigest.indexOf(':', lastSlash + 1);
  return colon === -1 ? noDigest : noDigest.slice(0, colon);
}

export function publishedDevcontainerFeatureRef(
  ref = process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF ?? DEFAULT_SANDBOX_TOOLKIT_FEATURE_REF,
): { ref: string; version: string; identity: string } | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return undefined;
  const pinned = normalizeFeatureTag(
    rejectLatestImageRef(trimmed, 'VERITY_SANDBOX_TOOLKIT_FEATURE_REF'),
  );
  return { ref: pinned, version: 'published', identity: pinned };
}

/**
 * Whether the toolkit Feature ref is operator CONFIGURATION rather than a ref
 * this Server resolved for itself.
 *
 * The distinction cannot be read off the ref, and getting it wrong is how the
 * bundle stopped mattering in production. A digest pin used to win outright —
 * written for the case where an operator names one exact Feature artifact. But
 * `main.ts` resolves the published default through `createPublishedDefaultResolver`,
 * which hands this function a DIGEST too, walked back from the `:latest` channel
 * tag. The two are indistinguishable by shape, so on every deployed Server the
 * auto-resolved digest silently outranked the bundle — and that bundle is the
 * trust root the runner-boundary attestation compares each Sandbox against.
 * Between a toolkit publish and the Server release that follows it, `:latest` is
 * a NEWER toolkit than this Server can vouch for, so every devcontainer project
 * built in that window got a Sandbox whose attestation was guaranteed to fail
 * and whose Runner supervisor was therefore switched off.
 *
 * Reading the env var directly settles it: only an operator names a ref there.
 * Blank is NOT configuration — `deploy/docker-compose.yml` passes the variable
 * through as `${VERITY_SANDBOX_TOOLKIT_FEATURE_REF:-}`, so every stock
 * deployment sets it empty, and `main.ts` maps empty to the release default it
 * resolves for itself. That is exactly the ref the bundle has to outrank.
 */
export function toolkitFeatureRefIsConfigured(
  raw = process.env.VERITY_SANDBOX_TOOLKIT_FEATURE_REF,
): boolean {
  return raw !== undefined && raw.trim().length > 0;
}

/**
 * Resolve the toolkit Feature to inject into project devcontainer builds.
 *
 * On a real Server host the Feature is BAKED into the image; we read its exact
 * `version` from that bundle and pin the GHCR Feature to it (bare semver tag) so
 * the sandbox toolkit always matches what this server ships. We reference GHCR —
 * NOT the local bundle path — because the devcontainer CLI rejects absolute
 * local Feature paths ("An Absolute path to a local feature is not allowed"); the
 * bundle is the version-of-record, GHCR is the resolvable source.
 *
 * Off-server (dev/test), the bundle is absent → fall back to the published ref.
 * A blank `VERITY_SANDBOX_TOOLKIT_FEATURE_REF` disables the Feature entirely —
 * but only on this default env-reading path, which a deployed Server never
 * takes: `main.ts` passes a resolver whose empty value means "the ref this
 * release was published with", not "no Feature" (see `deploy/README.md`).
 *
 * A digest-pinned published ref outranks the bundle only when an operator
 * CONFIGURED it — see {@link toolkitFeatureRefIsConfigured} for why the digest
 * alone cannot decide that.
 */
export function resolveToolkitFeatureRef(
  bundled = readBundledDevcontainerFeature(),
  published = publishedDevcontainerFeatureRef(),
  configured = toolkitFeatureRefIsConfigured(),
): { ref: string; version: string; identity: string } | undefined {
  if (bundled === undefined) return published;
  if (published === undefined) return undefined;
  if (configured && published.ref.includes('@')) return published;
  // semantic-release owns the published artifact version; the source tree keeps
  // the bundled devcontainer Feature at this placeholder, which is not a GHCR
  // tag. Fall back to the configured published ref instead of injecting an
  // unresolvable `:0.0.0-managed` Feature into project devcontainer builds.
  if (bundled.version === '0.0.0-managed') return published;
  const repo = featureRepoFromRef(published.ref);
  return {
    ref: `${repo}:${bundled.version.replace(/^v/, '')}`,
    version: bundled.version,
    identity: bundled.identity,
  };
}

export function devcontainerProvisionerOptionsForDockerBaseUrl(
  dockerBaseUrl: string,
  devcontainerFeature: DevcontainerFeatureSource | undefined = publishedDevcontainerFeatureRef(),
): {
  devcontainerBuild: typeof defaultDevcontainerBuildSpawner;
  dockerHostForBuild: string;
  devcontainerFeature?: DevcontainerFeatureSource;
} {
  const buildOptions = devcontainerBuildOptionsForDockerBaseUrl(dockerBaseUrl);
  return devcontainerFeature !== undefined
    ? { ...buildOptions, devcontainerFeature }
    : buildOptions;
}

/**
 * Whether the auto-derived branch name may be applied to this session's worktree.
 * Control-plane sessions run in a plain host directory rather than a git worktree,
 * so there is no branch to rename — and `autoRename`'s opening `git rev-parse
 * --abbrev-ref HEAD` fails outright there, which used to surface to the operator as
 * a failed turn. Mirrors the server's `branchesForSession`, which withholds the
 * branch service from control-plane projects for the same reason. A session with no
 * project keeps the old behavior (the branch service decides).
 */
export async function branchRenameAppliesToSession(
  session: { projectId: string | null },
  getProject: (projectId: string) => Promise<Pick<ProjectRecord, 'kind'> | undefined>,
): Promise<boolean> {
  if (session.projectId === null) return true;
  const project = await getProject(session.projectId);
  return project?.kind !== 'control_plane';
}

/** Project-scoped admission used by embedded session backends. It serializes
 * foreground preparation, exposes the live waiter set to repair ownership, releases
 * the queue on every failure path, and keeps background resolutions fail-fast. */
export function createProjectTurnPreparationSerializer(deps: {
  waitForRepair: (projectId: string, sessionId: string) => Promise<void>;
  repairInFlight: (projectId: string) => boolean;
  wrapBackground: (projectId: string, backend: Backend) => Backend;
}): (
  projectId: string,
  sessionId: string,
  canWait: boolean,
  prepare: (queuedSessionIds: ReadonlySet<string>) => Promise<Backend | undefined>,
) => Promise<Backend | undefined> {
  const tails = new Map<string, Promise<void>>();
  const waitersByProject = new Map<string, Set<string>>();
  return async (projectId, sessionId, canWait, prepare) => {
    if (!canWait) {
      if (tails.has(projectId) || deps.repairInFlight(projectId)) {
        throw new Error('project Sandbox preparation is already in progress');
      }
      const backend = await prepare(new Set([sessionId]));
      return backend === undefined ? undefined : deps.wrapBackground(projectId, backend);
    }
    const previous = tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(projectId, current);
    const waiters = waitersByProject.get(projectId) ?? new Set<string>();
    waitersByProject.set(projectId, waiters);
    waiters.add(sessionId);
    try {
      await deps.waitForRepair(projectId, sessionId);
      await previous;
      return await prepare(waiters);
    } finally {
      waiters.delete(sessionId);
      if (waiters.size === 0) waitersByProject.delete(projectId);
      release();
      if (tails.get(projectId) === current) tails.delete(projectId);
    }
  };
}

/**
 * Compose the control-plane server for a single-host deployment: a real Postgres
 * store via `databaseUrl` (the production entrypoint always sets it), the
 * in-memory event bus, and the conductor over the runner's local `claude`. A
 * store is mandatory — the hermetic test harness supplies its TEST-ONLY pglite
 * through {@link EmbeddedServerConfig.openDatabase} rather than through an
 * implicit fallback, so production can only ever open Postgres. The caller
 * `listen()`s and calls {@link EmbeddedServer.close} on shutdown. This is the
 * testable wiring behind the `main.ts` entrypoint.
 */
export async function buildEmbeddedServer(
  config: EmbeddedServerConfig = {},
): Promise<EmbeddedServer> {
  const untypedConfig = config as EmbeddedServerConfig & Record<string, unknown>;
  for (const removed of [
    'signingBrokerUrl',
    'sandboxNetwork',
    'perProjectNetwork',
    'selfContainerName',
  ]) {
    if (untypedConfig[removed] !== undefined) {
      throw new Error(`${removed} was removed; project relay wiring is mandatory`);
    }
  }
  if (
    config.permissionMode !== undefined &&
    !(ALLOWED_PERMISSION_MODES as readonly string[]).includes(config.permissionMode)
  ) {
    throw new Error(
      `invalid permissionMode "${config.permissionMode}": expected one of ${ALLOWED_PERMISSION_MODES.join(', ')}`,
    );
  }
  if (
    config.secretJobRuntimeRequired === true &&
    config.secretJobRuntimeReadiness === undefined &&
    config.dockerBaseUrl === undefined
  ) {
    throw new Error('dockerBaseUrl is required when the Secret Job runtime is required');
  }
  validateRuntimeReadinessTtl(config.secretJobRuntimeReadinessTtlMs);
  if (config.secretJobs !== undefined) {
    if (
      (config.secretJobs.resolveSecrets === undefined) ===
      (config.secretJobs.doppler === undefined)
    ) {
      throw new Error('Secret Jobs require exactly one of resolveSecrets or doppler');
    }
    if (
      config.secretJobs.doppler !== undefined &&
      config.secretJobs.authorizeProviderAdministration === undefined
    ) {
      throw new Error('Doppler Secret Jobs require provider administration authorization');
    }
    if (config.dockerBaseUrl === undefined) {
      throw new Error('dockerBaseUrl is required when Secret Jobs are configured');
    }
    if (!config.dockerBaseUrl.startsWith('unix://')) {
      throw new Error('Secret Jobs require a unix Docker socket for authenticated attach');
    }
    const { socketPath } = parseUnixBaseUrl(config.dockerBaseUrl);
    if (!socketPath.startsWith('/') || socketPath === '/') {
      throw new Error('Secret Jobs require an absolute, non-empty unix Docker socket path');
    }
    if (!isUntaggedImageRepository(config.secretJobs.executorImageRepository)) {
      throw new Error('Secret Job executor image repository must be an untagged repository');
    }
  }

  // Fail closed rather than silently opening an ephemeral store: a deployment
  // that lost its DATABASE_URL must not come up looking healthy on an empty
  // database. main.ts checks this earlier and with a friendlier message; this is
  // the guard for every other caller of the wiring.
  let db: Kysely<Database>;
  if (config.openDatabase !== undefined) {
    db = config.openDatabase(config);
  } else if (config.databaseUrl !== undefined) {
    db = createPostgresDb(config.databaseUrl, config.controlPlaneFence);
  } else {
    throw new Error('buildEmbeddedServer: databaseUrl is required (Verity runs on PostgreSQL)');
  }
  // The same release-controlled promise `main.ts` gives the control-plane
  // migration, and it has to be given here too: a Server start runs both, so a
  // bridge build tolerated at the first call and refused at this one is not
  // tolerated at all — it is the identical crash one stack frame later.
  await migrateToLatest(db, migrationProvider, { forwardMax: SERVER_COMPAT.schema.max });
  // At-rest secret encryption (ADR 0002 D3). A sealable cipher holds the key in
  // memory only; secret columns are AES-256-GCM encrypted before they touch the
  // DB. The key normally arrives ONE way: the operator sets/enters a master
  // password via POST /secret/init | /secret/unlock (onboarding through the app),
  // which derives the key (scrypt). There is no headless/env-key auto-unlock —
  // the one other way in is `adoptedSecretKeyMaterial`, the key the Server this
  // process replaces held in memory and sealed to it during a self-update
  // (ADR 0008 D8). That path never touches disk or the environment and still
  // checks the stored verifier, so it carries an already-entered password across
  // an update rather than adding a second way to obtain one. While sealed,
  // non-secret settings still work; writing/reading a secret fails with a clear
  // 503 until unlock.
  const secretCipher = createSealableSecretCipher();
  const eventStore = new EventStore(db, secretCipher);
  let finishLegacyDopplerCutover = (): Promise<number> => Promise.resolve(0);
  const readStoredBrokerDopplerCredential = (): Promise<Buffer | undefined> =>
    eventStore.getDopplerServiceTokenBytes();
  const readBrokerDopplerCredential = async (): Promise<Buffer | undefined> => {
    if (await hasPendingLegacyDopplerCutover(db)) {
      if (!secretCipher.isSealed()) await finishLegacyDopplerCutover();
      if (await hasPendingLegacyDopplerCutover(db)) {
        throw new Error('legacy Doppler credential cutover is still pending');
      }
    }
    return readStoredBrokerDopplerCredential();
  };
  const workflowStore = new WorkflowStore(db);
  const createDeliveryFromControlPlane = createControlPlaneDeliveryTool({
    controlProjectId: CONTROL_PLANE_RUNNER_PROJECT_ID,
    workflowStore,
    getSession: (sessionId) => eventStore.getSession(sessionId),
    listProjects: () => eventStore.listProjects(),
  });
  const brokeredHttpConsumptions = createBrokeredHttpConsumptionStore(db);
  const brokeredHttpGrants = createBrokeredHttpGrantStore(db);
  const restrictedHttpTransport = createNodeRestrictedHttpJsonTransport();
  const getBrokeredProjectBinding = async (projectId: string) => {
    const settings = await eventStore.getProjectSettings(projectId);
    const dopplerProject = settings?.dopplerProject?.trim();
    const dopplerConfig = settings?.dopplerConfig?.trim();
    return dopplerProject === undefined || dopplerConfig === undefined
      ? undefined
      : { dopplerProject, dopplerConfig };
  };
  const resolveBrokerDopplerSecret = async (
    input: Omit<Parameters<typeof resolveDopplerProjectSecret>[0], 'token'>,
  ): Promise<Uint8Array> => {
    const token = await readBrokerDopplerCredential();
    if (token === undefined) {
      throw new DopplerSecretResolutionError(
        'Secret resolution failed during Doppler authentication. No secret value was exposed.',
        'Doppler authentication',
      );
    }
    try {
      return await resolveDopplerProjectSecret({ ...input, token });
    } finally {
      token.fill(0);
    }
  };
  const brokeredHttpTool = createBrokeredHttpTool({
    getProjectBinding: getBrokeredProjectBinding,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
    transport: restrictedHttpTransport,
  });
  const trustedCliTool = createTrustedCliTool({
    getProjectBinding: getBrokeredProjectBinding,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
  });
  // ── Loopback MCP gateway (ADR 0014) ───────────────────────────────────────
  // An ACP session has no model-specific tool relay, so the brokered tools reach it as an MCP
  // server on the project's own internal socket. Everything here is the half that lives
  // outside the Sandbox: the per-turn bearer, the keyed request MAC, the audit append and
  // the tool invocation. The approval seam is bound in `buildServer`, to the conductor that
  // owns the session's permission cards — see `ServerDeps.mcpGateway`.
  const secretAuditLog = createPostgresSecretAuditLog(db);
  const gatewayRequestMacKeys = createGatewayRequestMacKeyring(db, secretCipher);
  const mcpGatewayTokens = createMcpGatewayTokens();
  const mcpGateway: Omit<McpGatewayDeps, 'requestApproval'> = {
    // Trusted CLI needs the project supervisor: it is the authority that proves this bearer
    // still names a live turn whose start request enabled execution. Deployments without the
    // supervisor omit the tool completely rather than advertising a permanently failing call.
    servedTools:
      config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
        ? ['verity_http_request', 'verity_secret_run']
        : ['verity_http_request'],
    // Control-plane-only tools. `verity_create_delivery` is served from the executor below;
    // the two session tools are intercepted in `buildServer`, which owns the conductor they
    // dispatch through — advertising them is still decided here, with the rest of the served
    // set, so one place says what the control-plane gateway offers.
    extraToolsForProject: (projectId) =>
      projectId === CONTROL_PLANE_RUNNER_PROJECT_ID
        ? ['verity_create_delivery', 'verity_list_sessions', 'verity_session_handoff']
        : [],
    resolveCaller: (input) => Promise.resolve(mcpGatewayTokens.resolve(input)),
    // Both tools reuse the brokered execution implementations, including their at-most-once
    // approval fence. The gateway bearer supplies the project/session/turn identity; its
    // fresh call id makes consumption exact for this approved invocation.
    invokeTool: createMcpGatewayToolExecutor({
      brokeredHttpTool: brokeredHttpTool,
      trustedCliTool,
      ...(config.runnerSupervisor === true && config.dataVolumeRoot !== undefined
        ? { runnerRoot: join(config.dataVolumeRoot, 'runners') }
        : {}),
      createDelivery: createDeliveryFromControlPlane,
    }),
    recordCall: async ({ projectId, kind, ...gateway }) => {
      await secretAuditLog.append({
        projectId,
        kind,
        aliases: [],
        providerBindings: [],
        gateway,
        recordedAt: new Date().toISOString(),
      });
    },
    requestMac: async ({ projectId, request }) => {
      const key = await gatewayRequestMacKeys.active();
      try {
        return { requestMac: gatewayRequestMac(key, projectId, request), macKeyId: key.keyId };
      } finally {
        key.material.fill(0);
      }
    },
  };

  const brokeredGrantBindingId = async (projectId: string): Promise<string | undefined> => {
    const binding = await getBrokeredProjectBinding(projectId);
    if (binding === undefined) return undefined;
    return `project-doppler:${createHash('sha256')
      .update(binding.dopplerProject)
      .update('\0')
      .update(binding.dopplerConfig)
      .digest('hex')}`;
  };
  // ADR 0011 D3: secret NAMES (never values) for the turn context, so the agent
  // stops guessing aliases. Briefly cached; every failure degrades to "no list".
  const brokeredAliasCache = new Map<string, { names: readonly string[]; expiresAt: number }>();
  const brokeredSecretAliases = async (projectId: string): Promise<readonly string[]> => {
    const cached = brokeredAliasCache.get(projectId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.names;
    if (cached !== undefined) brokeredAliasCache.delete(projectId);
    const binding = await getBrokeredProjectBinding(projectId);
    if (binding === undefined) return [];
    let names: readonly string[];
    let ttlMs = 60_000;
    let token: Uint8Array | undefined;
    try {
      token = await readBrokerDopplerCredential();
      if (token === undefined) throw new Error('broker Doppler identity is unavailable');
      names = await listDopplerProjectSecretNames({
        dopplerProject: binding.dopplerProject,
        dopplerConfig: binding.dopplerConfig,
        token,
      });
    } catch {
      // Keep provider outages best-effort without paying the same network timeout
      // at the start of every turn. Retry soon enough to recover automatically.
      names = [];
      ttlMs = 10_000;
    } finally {
      token?.fill(0);
    }
    if (brokeredAliasCache.size >= 256) {
      const oldestProjectId = brokeredAliasCache.keys().next().value;
      if (oldestProjectId !== undefined) brokeredAliasCache.delete(oldestProjectId);
    }
    brokeredAliasCache.set(projectId, { names, expiresAt: Date.now() + ttlMs });
    return names;
  };
  await eventStore.reconcileDevServerHostPorts();
  const secretKeyMeta = await eventStore.getSecretKeyMeta();
  const hasMasterPassword = secretKeyMeta !== undefined;
  // The one non-interactive way in (ADR 0008 D8): a Server promoted by a
  // self-update carries the key its predecessor already held in memory, so an
  // update the operator asked for once does not end at a password prompt. It is
  // only checked here — a key that does not match the stored verifier would
  // encrypt new secrets under a divergent one, so it is dropped rather than
  // used. Applying it is deliberately left until the build is finished: see the
  // adoption below.
  let handedOffKeyMaterial: string | undefined;
  if (config.adoptedSecretKeyMaterial !== undefined) {
    if (
      secretKeyMeta !== undefined &&
      keyMatchesVerifier(config.adoptedSecretKeyMaterial, secretKeyMeta.verifier)
    ) {
      handedOffKeyMaterial = config.adoptedSecretKeyMaterial;
    } else {
      console.warn(
        'verity: the key handed over by the previous Server does not match this store — staying sealed',
      );
    }
  }
  // A usable handed-off key says nothing here, because the store is still sealed
  // at this point by design and about to be unlocked below. Either outcome of
  // that adoption is reported when it is known, so this must not first announce
  // a store it is neither describing nor going to leave alone.
  if (secretCipher.isSealed() && handedOffKeyMaterial === undefined) {
    console.warn(
      hasMasterPassword
        ? 'verity: secret store is SEALED — a master password is set but not entered. ' +
            'Unlock via POST /secret/unlock before secrets (GitHub App key, signing key, Doppler) are available.'
        : 'verity: secret store is UNINITIALIZED and SEALED — set a master password via ' +
            'POST /secret/init before storing secrets.',
    );
  }
  // Control-plane API auth gate (audit C1). Master-password only: it flips on the
  // moment /secret/init sets the first password. Before that the store is
  // uninitialized and the gate is open so onboarding can reach /secret/init — the
  // deployment must sit behind a trusted network/firewall until then (documented
  // first-run behaviour).
  const authRegistry = await createAuthTokenRegistry(eventStore, {
    enabled: hasMasterPassword,
  });
  // Git committer identity and all onboarding state (GitHub App credentials,
  // signing key, Doppler) come exclusively from DB/secret-store writes made
  // through the app — never from deployment env or mounted files. The identity in
  // particular is derived from the GitHub App installation during signing-key
  // onboarding (resolveGitHubAppIdentity), so there is nothing to seed here.
  // One-time heal: worktrees whose admin `gitdir` git cannot follow — left
  // relative by an earlier version, or absolute with a container-side `/work`
  // prefix — are `prunable`, so a `prune`/gc silently deregisters a still-live
  // session. Rewrite those to the path git expects at startup. Best-effort: a
  // heal failure must never block server boot.
  //
  // The multi-project runner deliberately leaves `repoDir` EMPTY (see the branch
  // switcher below) and keeps one clone per project under `hostCloneRoot`, so
  // gating the heal on `repoDir` alone silently disabled it for every project on
  // exactly the deployment that spawns the most sessions. Heal per project clone
  // there too — deliberately a second `if`, not an `else`: a deployment that
  // configures both a server repo AND project clones must heal both.
  if (config.repoDir) {
    try {
      repairAdminGitdirs(config.repoDir);
    } catch {
      // ignore — new spawns are unaffected; only pre-existing landmines stay
    }
  }
  if (config.hostCloneRoot) {
    try {
      repairProjectAdminGitdirs(config.hostCloneRoot);
    } catch {
      // ignore — new spawns are unaffected; only pre-existing landmines stay
    }
  }
  // Branch switcher for each session's worktree (#91). A dev checkout may provide
  // one global repo root; the multi-project runner deliberately sets VERITY_REPO_DIR=''
  // and instead resolves repo-wide git operations through each session worktree.
  const branches =
    config.repoDir || config.hostCloneRoot
      ? createGitBranchService({
          ...(config.repoDir ? { repoDir: config.repoDir } : {}),
          baseBranch: 'main',
        })
      : undefined;
  // Open-PR lookup for the header/PR strip (#125): built per SESSION WORKTREE, not
  // globally from config.repoDir. Project sessions live in their own repos, so using
  // the Verity repo here would miss PRs like deep-ocr-web. The per-worktree services
  // keep their own short GitHub TTL caches so the visible PR bar updates quickly
  // while still coalescing repeated app polls; the token provider is re-read per lookup.
  const prStatusTtlMs = 2_000;
  const prServices = new Map<string, ReturnType<typeof createGitHubPrService>>();
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
  const prTokenSource = config.githubToken;
  const prServiceFor = (repoDir: string): ReturnType<typeof createGitHubPrService> => {
    let svc = prServices.get(repoDir);
    if (svc === undefined) {
      svc = createGitHubPrService({
        repoDir,
        ...(prTokenSource !== undefined
          ? { token: createProjectAwareGitHubTokenSource(repoDir, prTokenSource) }
          : {}),
        asyncToken: (owner, repo) => cachedProjectTokenMint({ owner, repo }),
        ttlMs: prStatusTtlMs,
        failureCooldownFor: prFailureCooldownFor,
      });
      prServices.set(repoDir, svc);
    }
    return svc;
  };
  // Open-issues list for the overview backlog (#137): same precondition as the PR
  // lookup (a repo + a token source). Inert until a token resolves; omit `listIssues`
  // entirely when there's no token source (the overview then hides the Issues section).
  const issueService =
    config.repoDir && config.githubToken
      ? createGitHubIssueService({ repoDir: config.repoDir, token: config.githubToken })
      : undefined;
  // Repo identity (owner/repo) for the header's tappable Issue/PR chips (#161). Needs
  // only the repo — owner/repo comes from the `origin` remote, no token required — so
  // it's available even on token-less deployments. Resolves to null (chips stay
  // non-tappable) when the repo has no GitHub origin.
  const repoIdentities = new Map<string, ReturnType<typeof createGitHubIdentityResolver>>();
  const repoIdentityFor = (repoDir: string): ReturnType<typeof createGitHubIdentityResolver> => {
    let identity = repoIdentities.get(repoDir);
    if (identity === undefined) {
      identity = createGitHubIdentityResolver(repoDir);
      repoIdentities.set(repoDir, identity);
    }
    return identity;
  };

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
  // The per-project sandbox token — scoped to a LEAST-PRIVILEGE subset (audit M2)
  // instead of inheriting the full installation grant. The subset lives in
  // PROJECT_GITHUB_TOKEN_PERMISSIONS (push branches incl. `.github/workflows/*` +
  // open PRs, read own CI status and Actions runs/logs for `gh run view/watch`);
  // board writes go through the
  // dedicated task mints below, so a compromised sandbox cannot tamper with the
  // org's Projects v2 board. Repo scope is still `[project.repo]`.
  const projectTokenMint = createGitHubAppProjectTokenMint({
    ...baseMintOpts,
    permissions: PROJECT_GITHUB_TOKEN_PERMISSIONS,
  });

  // Task-management board over Projects v2 (ADR 0007) — the `/tasks` routes. Constructed
  // on the explicit opt-in (a `repoDir` whose origin owns the board + a configured board
  // number); omit either and the routes 503 (task management not configured). GraphQL, so
  // it's user-initiated + on-demand only — never polled (AGENTS.md).
  //
  // Deliberately NOT gated on a token being present at build time — like `releaseService`
  // below, it's wired whenever opted-in and degrades to an inert board (getBoard → null)
  // when no token resolves at request time. That's what lets an App configured purely via
  // the app UI (ADR 0002 — creds in the encrypted DB store, no `githubToken`/`githubAppId`
  // env config) still serve `/tasks`: the mint reads those DB creds first.
  //
  // Token: a DEDICATED least-privilege mint scoped to only what the task engine needs —
  // `organization_projects` (board read/write + rank) + `issues` (draft→issue) — instead
  // of the broad shared `~/.gh-token` that carries the full installation permission set.
  // Minted for the repo each task operation needs (origin for board reads, the chosen
  // target repo for repo-picker create/convert), memoized ~50min (tokens live 1h) so
  // a Plan-tab refresh doesn't re-mint per call. Falls back to the shared
  // `config.githubToken` inside the service when the mint yields nothing (App creds
  // absent/sealed store).
  const taskTokenMint = createGitHubAppProjectTokenMint({
    ...baseMintOpts,
    permissions: { organization_projects: 'write', issues: 'write' },
  });
  const taskBoardTokenMint = createGitHubAppInstallationTokenMint({
    ...baseMintOpts,
    permissions: { organization_projects: 'write', issues: 'write' },
  });
  // TTL memo + single-flight for REUSE consumers: release lookup uses per-repo
  // installation tokens, task issue operations use per-target-repo task tokens, and
  // task board operations use one installation-wide task token. The provisioner /
  // worktree paths keep the raw `projectTokenMint` — they write the token into a
  // `.gh-token` file that must stay valid ~1h, so they need a fresh mint each time.
  const cachedProjectTokenMint = createCachedProjectTokenMint(projectTokenMint);
  const cachedTaskTokenMint = createCachedProjectTokenMint(taskTokenMint);
  const cachedTaskBoardTokenMint = createCachedInstallationTokenMint(taskBoardTokenMint);
  // GitHub-token broker (security review): the sandbox holds an opaque per-project
  // capability and redeems it at POST /internal/github/token instead of carrying a
  // gh-token file. The provisioner issues capabilities into this SAME registry; the
  // endpoint resolves them and mints a repo-scoped token via the cached mint (so a
  // frequently-called credential helper doesn't hammer GitHub).
  const ghTokenCapabilities = createGhTokenCapabilityRegistry(db);
  const signingCapabilities = createSigningCapabilityRegistry(db);
  // Real git worktrees only when a project repo is configured; else the server's
  // scratch-dir default (spawned agents start on an empty dir, no repo).
  // Concierge/default Verity sessions branch from `/work`, so their refresh fetch
  // must authenticate through the DB-backed GitHub App too. DB-only onboarding
  // deployments intentionally do not carry a broad `.gh-token`; without this header
  // `git fetch origin main` fails before the Concierge session can be created.
  const worktrees = config.repoDir
    ? createGitWorktreeProvisioner({
        repoDir: config.repoDir,
        worktreeRoot: config.workspacesDir ?? join(tmpdir(), 'verity-sessions'),
        baseBranch: 'main',
        // Fetch `main` from origin before branching so each spawn starts from
        // the latest integration tip, not the clone's last-synced `main`.
        refreshBase: true,
        fetchAuthHeader: () =>
          resolveRepoWorktreeFetchAuthHeader(
            () => repoIdentityFor(config.repoDir as string)(),
            cachedProjectTokenMint,
            config.githubToken,
          ),
      })
    : undefined;
  const installationListTokenMint = createGitHubAppInstallationTokenMint({
    ...baseMintOpts,
    permissions: { metadata: 'read' },
  });
  const taskService =
    config.repoDir && config.tasksProjectNumber !== undefined
      ? createGitHubTaskService({
          repoDir: config.repoDir,
          projectNumber: config.tasksProjectNumber,
          token: config.githubToken,
          asyncToken: async (repo) => {
            const id = repo ?? (await repoIdentityFor(config.repoDir as string)());
            return id ? cachedTaskTokenMint({ owner: id.owner, repo: id.repo }) : undefined;
          },
          asyncBoardToken: () => cachedTaskBoardTokenMint(),
        })
      : undefined;

  // GitHub-App-installation repo list (concept §19, #174) — the live source of the
  // `projects` cache, fetched fresh per `GET /projects` (with a per-call TTL cached by
  // the service so a polled picker doesn't burn rate limit). The DB-backed App path
  // mints a dedicated metadata-only installation token; static fleet tokens remain
  // a fallback for legacy deployments. A sealed DB store must propagate as 503 so
  // mobile can prompt for unlock instead of showing an empty repository list.
  const installationService = createGitHubInstallationService({
    asyncToken: async () => {
      try {
        return await resolveInstallationListToken(installationListTokenMint, config.githubToken);
      } catch (err) {
        if (err instanceof SealedError) throw err;
        return undefined;
      }
    },
  });

  // Latest-release lookup for the project overview: same precondition as the
  // installation service (an App-installation token). Fleet-wide (keyed by
  // (owner, repo) per call), non-blocking — `GET /projects` reads it synchronously
  // and it refreshes in the background on a TTL. Absent → the overview shows no
  // release version (the field is simply null on the wire).
  const releaseService = createGitHubReleaseService({
    token: config.githubToken,
    asyncToken: (owner, repo) => cachedProjectTokenMint({ owner, repo }),
  });

  const secretRoot =
    config.secretMaterializationRoot ??
    join(config.dataDir ?? config.workspacesDir ?? join(tmpdir(), 'verity'), 'secrets');
  const configuredCodexModels =
    config.codexEnabled === true ? (config.codexModels ?? [CODEX_DEFAULT_MODEL]) : [];
  const codexModelCatalog =
    config.codexEnabled === true && config.codexModels === undefined
      ? startCodexModelCatalog({
          fallback: configuredCodexModels,
          // The Server has no project mTLS identity and must never materialize the
          // subscription login merely to enumerate models. The binary's bundled
          // catalog is credential-free and is refreshed after upgrades.
          load: () => (config.codexBundledModelLoader ?? fetchCodexBundledModels)(),
          onError: (error) =>
            console.warn(
              'verity: Codex model catalog refresh failed; keeping cached models',
              error,
            ),
        })
      : undefined;
  if (codexModelCatalog !== undefined) await codexModelCatalog.refresh();
  // Model picker source for OpenCode (#143). The retired HTTP transport enumerated a
  // running `opencode serve` over `GET /config/providers`; ACP has no such server to
  // ask, and the only ACP route to the catalogue is `session/new`'s config options —
  // which means spawning an agent process in a project Sandbox for every picker
  // refresh, on behalf of no session. The operator's pinned list is the better trade
  // until a session-scoped catalogue is worth building.
  const openCodeModels = config.openCodeEnabled === true ? (config.extraModels ?? []) : [];

  // Multi-repo fleet-registry provisioning (concept §19.3/#19.8, #174):
  // Docker client + ProvisionerImpl + DeprovisionerImpl — wired when a
  // dockerBaseUrl and hostCloneRoot are configured. Git auth comes from the
  // DB-backed GitHub App mint first, with the static ~/.gh-token provider only as
  // a legacy fallback.
  const projectDocker =
    config.dockerBaseUrl && config.hostCloneRoot
      ? createDockerClient({
          baseUrl: config.dockerBaseUrl,
          ...(config.registryAuth !== undefined ? { registryAuth: config.registryAuth } : {}),
        })
      : undefined;
  const runtimeDocker = config.dockerBaseUrl
    ? (projectDocker ??
      createDockerClient({
        baseUrl: config.dockerBaseUrl,
        ...(config.registryAuth !== undefined ? { registryAuth: config.registryAuth } : {}),
      }))
    : undefined;
  let previewShareManager: PreviewShareManager | undefined;
  const uplinkControl =
    config.publicPreviews !== undefined && projectDocker !== undefined
      ? new UplinkControlClient({
          url: config.publicPreviews.uplinkUrl,
          store: eventStore,
          serverVersion: config.publicPreviews.serverVersion,
          onFeaturesDisabled: (reason) =>
            previewShareManager?.disableAll(reason) ?? Promise.resolve(),
          onShareExpired: (shareId) =>
            previewShareManager?.finishExpiredByUplink(shareId) ?? Promise.resolve(),
        })
      : undefined;
  if (
    uplinkControl !== undefined &&
    projectDocker !== undefined &&
    config.publicPreviews !== undefined
  ) {
    previewShareManager = new PreviewShareManager({
      store: eventStore,
      docker: projectDocker,
      resolveConnectorImage: config.publicPreviews.resolveConnectorImage,
      ...(config.dataVolume ? { dataVolume: config.dataVolume } : {}),
      ...(config.dataVolumeRoot ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
      ...(config.hostCloneRoot ? { hostCloneRoot: config.hostCloneRoot } : {}),
      isDevServerRunning: async ({ project, devServer }) => {
        const status = await new DockerProjectRuntime({
          dockerBaseUrl: config.dockerBaseUrl,
        }).devServerStatus(project, {
          defaultBranch: null,
          defaultModel: null,
          devServerId: devServer.id,
          devServerCommand: devServer.command,
          devServerUrl: devServer.url,
          devServerWorkdir: devServer.workdir,
          devServerHostPort: devServer.hostPort,
          devServerContainerPort: devServer.containerPort,
        });
        return status.running;
      },
      edge: uplinkControl,
    });
    uplinkControl.start();
  }
  let secretJobRuntimeReadiness = config.secretJobRuntimeReadiness;
  if (config.secretJobRuntimeRequired === true && secretJobRuntimeReadiness === undefined) {
    // Validated before opening the DB above; retain the local narrowing for TypeScript.
    const dockerBaseUrl = config.dockerBaseUrl;
    if (dockerBaseUrl === undefined) throw new Error('unreachable: missing dockerBaseUrl');
    if (runtimeDocker === undefined) throw new Error('unreachable: missing runtime Docker client');
    const verifier = createDockerGvisorRuntimeVerifier({
      docker: runtimeDocker,
      expectedPath: PINNED_RUNSC_PATH,
      expectedArgs: PINNED_RUNSC_ARGS,
    });
    secretJobRuntimeReadiness = createRuntimeReadinessGate(() => verifier.verify('runsc'), {
      ...(config.secretJobRuntimeReadinessTtlMs !== undefined
        ? { ttlMs: config.secretJobRuntimeReadinessTtlMs }
        : {}),
    });
  }
  let embeddedSecretJobs: EmbeddedSecretJobs | undefined;
  const secretProviderCatalog =
    config.secretJobs?.doppler !== undefined ? createPostgresSecretProviderCatalog(db) : undefined;
  if (config.secretJobs !== undefined) {
    const secretJobsConfig = config.secretJobs;
    if (runtimeDocker === undefined || config.dockerBaseUrl === undefined) {
      throw new Error('unreachable: missing Secret Job Docker configuration');
    }
    const audit = createSecretAuditRecorder(secretAuditLog, {
      failureMode: 'fail-closed',
    });
    const revocations = createPostgresSecretRevocationStore(db);
    const recipientKeys = createSecretWorkerRecipientKeyRegistry();
    const sealEnvelope = createSecretEnvelopeSealer({
      resolveRecipientPublicKey: (publicKeyId, jobId) => recipientKeys.resolve(publicKeyId, jobId),
    });
    const broker = createSecretGrantBroker({
      store: createPostgresSecretGrantStore(db),
      resolveSecrets:
        secretJobsConfig.doppler !== undefined
          ? createDopplerSecretResolver({
              ...secretJobsConfig.doppler,
              catalog: secretProviderCatalog!,
              readCredential: readBrokerDopplerCredential,
            })
          : secretJobsConfig.resolveSecrets!,
      sealEnvelope,
      authorizeWorkload: secretJobsConfig.authorizeWorkload,
      authorizeCurrentClaims: async (claims) => {
        if (
          !(await revocations.isClaimsActive(claims)) ||
          !(await secretJobsConfig.authorizeCurrentClaims(claims))
        ) {
          return false;
        }
        if (secretJobsConfig.doppler === undefined) return true;
        return secretProviderCatalog!.checkClaimsPermissions(claims);
      },
      ...(secretJobsConfig.doppler === undefined
        ? {}
        : {
            authorizeResolvedClaims: (claims: RunGrantClaims) =>
              secretProviderCatalog!.authorizeClaimsPermissions(claims),
          }),
      recorder: audit,
    });
    const frames = createPostgresSecretJobFrameSpool(db, secretCipher);
    const executor = createBrokeredSecretJobExecutor({
      broker,
      docker: runtimeDocker,
      dockerBaseUrl: config.dockerBaseUrl,
      frames,
      redactorProfile: secretJobsConfig.redactorProfile,
      recipientKeys,
      expectedRuntimePath: PINNED_RUNSC_PATH,
      expectedRuntimeArgs: PINNED_RUNSC_ARGS,
      executorImageRepository: secretJobsConfig.executorImageRepository,
    });
    const service = createSecretJobService({
      authorization: secretJobsConfig.createAuthorization(broker),
      executor,
      frames,
      store: createPostgresSecretJobStore(db),
      authorizeInvocation: secretJobsConfig.authorizeInvocation,
      onExecutorError: (jobId, error) =>
        console.error(`verity: Secret Job ${jobId} executor failed`, error),
    });
    // Container cleanup and output retention are deliberately independent. Completed frames remain
    // replayable until an explicit retention/acknowledgement reaper calls frames.deleteJob/purge.
    embeddedSecretJobs = {
      broker,
      executor,
      frames,
      service,
    };
  }
  let docker: DockerClient | undefined;
  let provisioner: ProvisionerImpl | undefined;
  let deprovisioner: DeprovisionerImpl | undefined;
  // Claude-egress identity material is wired into the provisioner/deprovisioner
  // and projected exclusively into the standalone Agent Gateway.
  let claudeEgressIdentity: ClaudeEgressIdentityService | undefined;
  let refreshControlPlaneRunnerIdentity: (() => Promise<void>) | undefined;
  let awaitControlPlaneRunnerIdentity: (() => Promise<void>) | undefined;
  let controlPlaneIdentityRefreshTail: Promise<void> = Promise.resolve();
  /**
   * Publish the control-plane Runner identity where a failure must cost at most a
   * turn. Three callers qualify, and each one learned it the hard way: at boot a
   * throw costs the listener — and with it the `/secret/unlock` needed to repair
   * anything; in the unlock callback it costs the unlock; in the handed-off-key
   * activation it costs the key handover, which is how a promoted Server came up
   * sealed after the 13.2.4 cutover because the identity volume was still missing
   * its setgid bit. None of that is worth a certificate the next turn re-publishes
   * anyway. The two turn paths deliberately do NOT use this: there the caller is a
   * single turn that must fail closed rather than run without egress identity.
   */
  const publishRunnerIdentity = async (occasion: string): Promise<void> => {
    try {
      await refreshControlPlaneRunnerIdentity?.();
    } catch (error) {
      console.warn(
        error instanceof SealedError
          ? `verity: control-plane Runner identity deferred until unlock (${occasion})`
          : `verity: control-plane Runner identity deferred (${occasion}): ${String(error)}`,
      );
    }
  };
  let agentGatewayTls: ClaudeEgressMtlsMaterial | undefined;
  let agentGatewayBindings: readonly ClaudeEgressPeerBinding[] = [];
  let agentGatewayBindingGeneration = 0;
  let agentGatewayBindingProjection: Promise<void> = Promise.resolve();
  let agentGatewayAccessToken: string | null | undefined;
  let agentGatewayCodexAuthJson: string | null | undefined;
  const { url: agentGatewayUrl } = validateAgentGatewayRoutingConfig({
    url: config.agentGatewayUrl,
    controlSocket: config.agentGatewayControlSocket,
    unsealKey: config.agentGatewayUnsealKey,
    legacyGatewayUrl: config.claudeEgressGatewayUrl,
    connectorPort: config.claudeConnectorPort,
    listenerPort: config.agentGatewayClaudePort,
  });
  const agentGatewaySynchronizer: AgentGatewaySynchronizer | undefined =
    config.agentGatewayControlSocket === undefined
      ? undefined
      : startAgentGatewaySynchronizer({
          socketPath: config.agentGatewayControlSocket,
          onError(error): void {
            app.log.warn({ err: error }, 'Standalone agent gateway reconciliation failed');
          },
          persistCodexCredentialUpdate: (update) =>
            claudeCredentialSync.persistCodexCredentialUpdate(update),
        });
  const codexGatewayControlSocket = config.agentGatewayControlSocket;
  // Passed straight through: `readCodexAccessToken` already throws a
  // `CodexSignInUnusableError` subclass when the gateway says the sign-in is what
  // failed, which is exactly the distinction the usage probe acts on. Anything
  // else it throws stays an ordinary failure, because signing in again would not
  // fix a socket that did not answer.
  const codexGatewayCredentialProvider: CodexUsageCredentialProvider | undefined =
    codexGatewayControlSocket === undefined
      ? undefined
      : () => readCodexAccessToken(codexGatewayControlSocket);
  const agentGatewayConfiguration = (): AgentGatewayConfiguration | undefined => {
    if (config.agentGatewayControlSocket === undefined || agentGatewayTls === undefined) {
      return undefined;
    }
    const { ca, cert, key } = agentGatewayTls;
    if (typeof ca !== 'string' || typeof cert !== 'string' || typeof key !== 'string') {
      throw new Error('Agent gateway requires PEM-string TLS material');
    }
    // Every project is routed, so every binding belongs on the gateway.
    const routedBindings = agentGatewayBindings;
    const revision = createHash('sha256')
      .update(cert)
      .update(
        agentGatewayAccessToken === undefined
          ? '\0credential-pending'
          : agentGatewayAccessToken === null
            ? '\0credential-revoked'
            : `\0credential:${agentGatewayAccessToken}`,
      )
      .update(
        agentGatewayCodexAuthJson === undefined
          ? '\0codex-pending'
          : agentGatewayCodexAuthJson === null
            ? '\0codex-revoked'
            : `\0codex:${agentGatewayCodexAuthJson}`,
      )
      .update(
        routedBindings
          .map((binding) => `${binding.projectId}:${binding.fingerprint256}`)
          .sort()
          .join('\n'),
      )
      .digest('hex');
    return {
      revision,
      claude: {
        tls: { ca, cert, key },
        peerBindings: routedBindings,
        ...(config.agentGatewayUnsealKey === undefined || agentGatewayAccessToken === undefined
          ? {}
          : {
              credential: {
                unsealKey: config.agentGatewayUnsealKey,
                accessToken: agentGatewayAccessToken,
              },
            }),
      },
      ...(config.agentGatewayUnsealKey === undefined || agentGatewayCodexAuthJson === undefined
        ? {}
        : {
            codex: {
              credential: {
                unsealKey: config.agentGatewayUnsealKey,
                sourceRevision: createHash('sha256')
                  .update(agentGatewayCodexAuthJson ?? '\0revoked')
                  .digest('hex'),
                authJson: agentGatewayCodexAuthJson,
              },
            },
          }),
    };
  };
  const syncAgentGateway = (): void => {
    const configuration = agentGatewayConfiguration();
    if (configuration === undefined) return;
    agentGatewaySynchronizer?.update(configuration);
  };
  const synchronizeAgentGatewayForTurn = async (): Promise<void> => {
    if (config.agentGatewayControlSocket === undefined) {
      throw new Error('Agent Gateway control socket is not configured');
    }
    for (;;) {
      const bindingGeneration = agentGatewayBindingGeneration;
      await agentGatewayBindingProjection;
      // Identity/container work and token refreshes are asynchronous. Accept the
      // snapshot only if no issuance or revocation began while we waited.
      const accessToken = await claudeCredentialSync.getAccessToken();
      if (bindingGeneration !== agentGatewayBindingGeneration) continue;
      agentGatewayAccessToken = accessToken ?? null;
      const configuration = agentGatewayConfiguration();
      if (configuration === undefined) {
        throw new Error('Agent Gateway identity material is unavailable');
      }
      if (agentGatewaySynchronizer === undefined) {
        throw new Error('Agent Gateway synchronizer is unavailable');
      }
      await agentGatewaySynchronizer.updateAndWait(configuration);
      return;
    }
  };
  const projectRelayControlRef: { current: ProjectRelayControl | undefined } = {
    current: undefined,
  };
  const healthyRelayGeneration = async (
    projectId: string,
    inspected: Awaited<ReturnType<DockerClient['inspectContainer']>>,
  ): Promise<boolean> =>
    claudeEgressRelayHealthy(
      inspected,
      CONTAINER_GENERATION_LABEL,
      async (containerGeneration) =>
        (await projectRelayControlRef.current?.isHealthy?.({
          projectId,
          containerGeneration,
        })) === true,
    );
  /**
   * Last-resort repair for a Claude turn whose Sandbox cannot reach the relay:
   * recreate the Sandbox and report whether the turn may proceed on it.
   *
   * Only for turns that can afford the wait ({@link TurnPreparationContext.canWait});
   * the conductor's background backend resolutions must never trigger a rebuild.
   * The operator sees a transcript note and a `Waiting` badge for the duration, and
   * the turn resumes by itself — the alternative was a terminal error on a state
   * that repairs itself in a minute. Failures are swallowed into `false` so the
   * caller raises the one operator-facing message.
   */
  const repairSandboxForClaudeTurn = async (
    project: ProjectRecord,
    preparation: TurnPreparationContext,
    queuedSessionIds: ReadonlySet<string>,
  ): Promise<boolean> => {
    if (!preparation.canWait || docker === undefined) return false;
    if (provisioner?.repairSandboxForTurn === undefined) return false;
    preparation.waitingOn(
      'The project Sandbox has to be rebuilt before this message can run. Keeping the turn queued while Verity attempts the rebuild; it continues automatically if the Sandbox becomes ready.',
    );
    try {
      if (
        !(await provisioner.repairSandboxForTurn(
          project.id,
          preparation.sessionId,
          queuedSessionIds,
        ))
      )
        return false;
    } catch (error) {
      app.log.warn({ err: error, projectId: project.id }, 'turn-time sandbox repair failed');
      return false;
    }
    // Trust the recreate only as far as the same check that rejected the Sandbox in
    // the first place: a repair that reports success but leaves the relay unhealthy
    // must not let the turn through to fail deeper in.
    try {
      const inspected = await docker.inspectContainer(project.containerName);
      return await healthyRelayGeneration(project.id, inspected);
    } catch (error) {
      app.log.warn(
        { err: error, projectId: project.id },
        'could not verify the Claude relay after a turn-time sandbox repair',
      );
      return false;
    }
  };

  const withProjectSandboxActivity = (projectId: string, backend: Backend): Backend => {
    const use = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (provisioner?.tryBeginProjectSandboxActivity?.(projectId) === false) {
        throw new Error('project Sandbox repair is already in progress');
      }
      try {
        return await operation();
      } finally {
        provisioner?.endProjectSandboxActivity?.(projectId);
      }
    };
    return {
      ...(backend.runnerSupervisorBackend !== undefined
        ? { runnerSupervisorBackend: backend.runnerSupervisorBackend }
        : {}),
      run: (opts) => use(() => backend.run(opts)),
      ...(backend.query !== undefined
        ? { query: (input) => use(() => backend.query!(input)) }
        : {}),
      ...(backend.closeSession !== undefined
        ? { closeSession: (sessionId) => backend.closeSession!(sessionId) }
        : {}),
    };
  };
  const serializeProjectTurnPreparation = createProjectTurnPreparationSerializer({
    waitForRepair: (projectId, sessionId) =>
      provisioner?.waitForTurnSandboxRepair?.(projectId, sessionId) ?? Promise.resolve(),
    repairInFlight: (projectId) => provisioner?.turnSandboxRepairInFlight?.(projectId) === true,
    wrapBackground: withProjectSandboxActivity,
  });
  const routedAgentGatewayBindings = async (
    bindings: readonly ClaudeEgressPeerBinding[],
  ): Promise<readonly ClaudeEgressPeerBinding[]> => {
    if (docker === undefined || agentGatewayUrl === undefined) return [];
    const routed: ClaudeEgressPeerBinding[] = [];
    for (const binding of bindings) {
      // The dedicated control-plane runner is a fixed Compose peer on the private
      // control network, not a project container with a generation relay. Its
      // certificate is projected through a private named volume below, so Docker
      // relay inspection is neither applicable nor a substitute trust check.
      if (
        binding.projectId === CONTROL_PLANE_RUNNER_PROJECT_ID &&
        config.controlPlaneRunner === true
      ) {
        routed.push(binding);
        continue;
      }
      const project = await eventStore.getProject(binding.projectId);
      if (project === undefined || project.kind === 'control_plane') continue;
      try {
        const inspected = await docker.inspectContainer(project.containerName);
        if (await healthyRelayGeneration(project.id, inspected)) {
          routed.push(binding);
        }
      } catch (error) {
        // A transient Docker failure must not permanently deauthorize an already
        // verified certificate. Preserve only the exact cached binding; a new or
        // rotated certificate still fails closed until its container is inspected.
        // Definitive absence and unknown errors are also fail-closed.
        const transient =
          error instanceof DockerError &&
          (error.kind === 'network' || (error.kind === 'other' && (error.status ?? 0) >= 500));
        const previouslyRouted = agentGatewayBindings.some(
          (routed) =>
            routed.projectId === binding.projectId &&
            routed.fingerprint256 === binding.fingerprint256,
        );
        if (transient && previouslyRouted) routed.push(binding);
      }
    }
    return routed;
  };
  let projectRelayLifecycle: ProjectRelayLifecycle | undefined;
  const projectRelayEnabled = (config.projectRelayImage ?? '').trim().length > 0;
  if (
    config.dockerBaseUrl !== undefined &&
    config.hostCloneRoot !== undefined &&
    !projectRelayEnabled
  ) {
    throw new Error('Project Docker provisioning requires a digest-pinned project relay image');
  }
  // Claude traffic has exactly one route. A Docker-backed server without the
  // gateway would have to fall back to injecting the real OAuth token into
  // sandboxes, which this release removes as a possibility.
  if (
    config.dockerBaseUrl !== undefined &&
    config.hostCloneRoot !== undefined &&
    agentGatewayUrl === undefined
  ) {
    throw new Error('Project Docker provisioning requires the Agent Gateway');
  }
  if (projectRelayEnabled) {
    const missing = [
      (config.dockerBaseUrl ?? '').trim() === '' ? 'dockerBaseUrl' : undefined,
      (config.hostCloneRoot ?? '').trim() === '' ? 'hostCloneRoot' : undefined,
      (config.dataVolume ?? '').trim() === '' ? 'dataVolume' : undefined,
      (config.dataVolumeRoot ?? '').trim() === '' ? 'dataVolumeRoot' : undefined,
      (config.claudeEgressGatewayUrl ?? '').trim() === '' ? 'claudeEgressGatewayUrl' : undefined,
      (config.codexEgressGatewayUrl ?? '').trim() === '' ? 'codexEgressGatewayUrl' : undefined,
      config.claudeConnectorPort === undefined ||
      !Number.isInteger(config.claudeConnectorPort) ||
      config.claudeConnectorPort < 1 ||
      config.claudeConnectorPort > 65_535
        ? 'claudeConnectorPort'
        : undefined,
    ].filter((value): value is string => value !== undefined);
    if (missing.length > 0) {
      throw new Error(`project relay requires: ${missing.join(', ')}`);
    }
    if (!/@sha256:[a-f0-9]{64}$/i.test(config.projectRelayImage!)) {
      throw new Error('project relay image must be digest-pinned');
    }
  }
  const projectRelayControl: ProjectRelayControl | undefined = projectRelayEnabled
    ? {
        start: (binding) => {
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          return projectRelayLifecycle.start(binding);
        },
        resume: async (binding) => {
          if (projectRelayLifecycle === undefined)
            throw new Error('project relay runtime is not initialized');
          try {
            await projectRelayLifecycle.resume(binding);
            return true;
          } catch (error) {
            // Absence is an authoritative orphan verdict; daemon/listener failures
            // remain unknown so a transient cannot trigger a destructive rebuild.
            if (error instanceof DockerError && error.kind === 'container_not_found') return false;
            throw error;
          }
        },
        stop: (projectId) => projectRelayLifecycle?.stop(projectId) ?? Promise.resolve(),
        brokerUrl: (activation) => `http://${projectRelayContainerName(activation.identity)}:8080`,
        claudeGatewayUrl: (activation) =>
          `https://${projectRelayContainerName(activation.identity)}:8443`,
        codexGatewayUrl: (activation) =>
          `https://${projectRelayContainerName(activation.identity)}:8444`,
        // Both halves must hold for a sandbox of this generation to reach the
        // broker at all: this process still owning the listeners + capabilities
        // behind the relay, and the generation's relay container still running.
        // A restart empties the first, a relay exit empties the second, and either
        // way the sandbox's baked-in broker hostname or on-disk capability is dead.
        isHealthy: async ({ projectId, containerGeneration }) => {
          if (projectRelayLifecycle?.isActive(projectId, containerGeneration) !== true)
            return false;
          // No project Docker client → we cannot check the container half; the
          // in-memory half already said yes, so report healthy rather than
          // condemning the sandbox on a check we could not run.
          if (projectDocker === undefined) return true;
          try {
            const relay = await projectDocker.inspectContainer(
              projectRelayContainerName({ projectId, containerGeneration }),
            );
            return relay.running;
          } catch (error) {
            // A gone container is the failure this repairs; anything else (daemon
            // hiccup, timeout) rethrows so the caller records health as UNKNOWN
            // and leaves the sandbox alone.
            if (error instanceof DockerError && error.kind === 'container_not_found') return false;
            throw error;
          }
        },
      }
    : undefined;
  projectRelayControlRef.current = projectRelayControl;
  // Gateway TLS server name (CN/SAN) + the SNI the connector pins — derived once
  // from the gateway URL so the identity service and the sandbox projection agree.
  let claudeEgressServerName: string | undefined;
  let stopRunnerSupervisorReconciler = (): Promise<void> => Promise.resolve();
  let refreshProjectToken: ((project: ProjectRecord) => Promise<void>) | undefined;
  let projectWorktrees: ReturnType<typeof createProjectWorktreeFactory> | undefined;
  const defaultProjectImageSource =
    config.defaultProjectImage ??
    'ghcr.io/heey-global/verity/verity-sandbox@sha256:7445ec4d7aa770cb66d238621be6b4f2fc617cdc29db2142c8825f831f84fcfc';
  const defaultProjectImage: ProjectImageRefSource =
    typeof defaultProjectImageSource === 'function'
      ? // Forward `forceRefresh` so the provision/recreate path can pin the CURRENT
        // digest instead of the poll cache's; the zero-arg update poll passes none.
        async (forceRefresh?: boolean) =>
          rejectLatestImageRef(
            await defaultProjectImageSource(forceRefresh),
            'VERITY_DEFAULT_PROJECT_IMAGE',
          )
      : rejectLatestImageRef(defaultProjectImageSource, 'VERITY_DEFAULT_PROJECT_IMAGE');
  // Pin the toolkit Feature to the version BAKED into this server image, resolved
  // from GHCR under its BARE semver tag (never the `v`-prefixed visible-version
  // tag, which is not a resolvable Feature manifest — that was the `…:v1.11.6`
  // build failure). Off-server (dev/test) the bundle is absent → published ref.
  const configuredDevcontainerFeatureRef = config.devcontainerFeatureRef;
  // A ref handed over as a plain STRING is configuration by construction —
  // nothing resolved it, a caller wrote it. Only the resolver-function form is
  // ambiguous (`main.ts` uses it for both the operator's value and its own
  // lookup), and only that form has to fall back to reading the environment.
  const devcontainerFeatureRefConfigured =
    config.devcontainerFeatureRefConfigured ??
    (typeof configuredDevcontainerFeatureRef === 'string'
      ? configuredDevcontainerFeatureRef.trim().length > 0
      : toolkitFeatureRefIsConfigured());
  const devcontainerFeature: DevcontainerFeatureSource | undefined =
    typeof configuredDevcontainerFeatureRef === 'function'
      ? async () =>
          resolveToolkitFeatureRef(
            readBundledDevcontainerFeature(),
            publishedDevcontainerFeatureRef(await configuredDevcontainerFeatureRef()),
            devcontainerFeatureRefConfigured,
          )
      : resolveToolkitFeatureRef(
          readBundledDevcontainerFeature(),
          publishedDevcontainerFeatureRef(configuredDevcontainerFeatureRef),
          devcontainerFeatureRefConfigured,
        );
  if (projectDocker !== undefined && config.hostCloneRoot) {
    if (config.dockerBaseUrl === undefined) {
      throw new Error('dockerBaseUrl is required when project Docker provisioning is configured');
    }
    const dockerBaseUrl = config.dockerBaseUrl;
    docker = projectDocker;
    const fallbackGitHubToken = config.githubToken;
    const tokenSource: GitHubTokenSource =
      typeof fallbackGitHubToken === 'function' ? fallbackGitHubToken : () => fallbackGitHubToken;
    const ghTokenPath = config.ghTokenFilePath ?? join(process.env.HOME ?? '/root', '.gh-token');
    refreshProjectToken = (project: ProjectRecord): Promise<void> =>
      refreshProjectGitHubToken(project, projectTokenMint);
    // Per-project session worktree factory (see {@link createProjectWorktreeFactory}):
    // its `refreshBase` fetch authenticates with the SAME project-scoped token the
    // mint issues for `refreshProjectToken`. Guarded by the same mint + docker/
    // clone-root config; the server's own `/work` worktrees keep no
    // `fetchAuthHeader` (unchanged).
    projectWorktrees = createProjectWorktreeFactory(projectTokenMint);
    // Claude-egress identity material is refreshed on every issue/revoke and
    // projected to the standalone gateway. The provisioner uses the same service
    // to issue per-project client certificates and the deprovisioner revokes them.
    if (
      (config.claudeEgressGatewayUrl !== undefined) !==
      (config.claudeConnectorPort !== undefined)
    ) {
      // Partial config activates nothing (the projection gate needs both). Warn so
      // an operator who set only one gets a diagnostic instead of silent dormancy.
      console.warn(
        'verity: Claude egress needs BOTH the gateway URL and the connector port — set only one, so egress stays off',
      );
    }
    if (config.claudeEgressGatewayUrl !== undefined && config.claudeConnectorPort !== undefined) {
      claudeEgressServerName =
        config.claudeEgressServerName ?? new URL(config.claudeEgressGatewayUrl).hostname;
      claudeEgressIdentity = createClaudeEgressIdentityService({
        store: eventStore,
        serverName: claudeEgressServerName,
        ...(agentGatewayUrl === undefined
          ? {}
          : { additionalServerNames: [agentGatewayUrl.hostname] }),
        async onBindingsChanged(bindings): Promise<void> {
          agentGatewayBindingGeneration += 1;
          const bindingGeneration = agentGatewayBindingGeneration;
          const currentFingerprints = new Set(
            bindings.map((binding) => `${binding.projectId}\0${binding.fingerprint256}`),
          );
          // Denials are synchronous and never depend on Docker: remove revoked
          // fingerprints from the projected cache before inspecting containers
          // to decide whether newly issued bindings may be authorized.
          agentGatewayBindings = agentGatewayBindings.filter((binding) =>
            currentFingerprints.has(`${binding.projectId}\0${binding.fingerprint256}`),
          );
          const denialConfiguration = agentGatewayConfiguration();
          if (denialConfiguration !== undefined && agentGatewaySynchronizer !== undefined) {
            await agentGatewaySynchronizer.updateAndWait(denialConfiguration);
          }
          if (bindingGeneration !== agentGatewayBindingGeneration) return;
          const projection = (async (): Promise<void> => {
            const routedBindings = await routedAgentGatewayBindings(bindings);
            if (bindingGeneration !== agentGatewayBindingGeneration) return;
            agentGatewayBindings = routedBindings;
            syncAgentGateway();
          })();
          agentGatewayBindingProjection = projection;
          await projection;
        },
        onGatewayLeafChanged(material): void {
          agentGatewayTls = material;
          syncAgentGateway();
        },
      });
      if (config.controlPlaneRunner === true) {
        const identityDir = config.controlPlaneRunnerIdentityDir;
        const runnerRuntimeGid = config.runnerRuntimeGid ?? 1101;
        if (identityDir === undefined || identityDir.trim() === '') {
          throw new Error('VERITY_CONTROL_PLANE_RUNNER requires its private identity volume.');
        }
        const identityStats = await lstat(identityDir);
        if (
          !identityStats.isDirectory() ||
          identityStats.isSymbolicLink() ||
          identityStats.uid !== 0 ||
          identityStats.gid !== runnerRuntimeGid ||
          (identityStats.mode & 0o777) !== 0o770
        ) {
          throw new Error('control-plane Runner identity volume has unsafe ownership');
        }
        // Publishing hands each file to the Runner through the volume's setgid bit,
        // because chown() cannot (see `publish` below). Say so at boot, where an
        // operator can still act on it — but deliberately do NOT make it fatal. This
        // Server is created by the Updater from the sealed spec while the bit is set
        // by control-runner-init through compose, so the two are not ordered, and a
        // Server that refuses to boot over state its own init container repairs a
        // moment later is precisely the outage this path just came out of. A missing
        // bit surfaces again, non-fatally and with the same wording, at publish time.
        if ((identityStats.mode & 0o2000) === 0) {
          console.warn(
            'verity: control-plane Runner identity volume is missing the setgid bit (chmod 2770) — published identity will not reach the Runner group',
          );
        }
        const publish = async (name: string, value: string, mode: number): Promise<void> => {
          const target = join(identityDir, name);
          const temporary = `${target}.${randomUUID()}.tmp`;
          await writeFile(temporary, value, { mode });
          await chmod(temporary, mode);
          // The Runner reads this material as the configured Runner runtime GID,
          // and it gets that group from the identity volume's setgid bit (`chmod 2770`, control-runner-init): a
          // file created here inherits the directory's group, so no ownership change
          // is needed. Handing it over with chown() only works for a Server running
          // as root — `capAdd: ['CHOWN']` cannot grant it otherwise, because Docker
          // puts an added capability in the BOUNDING set only and a non-root process
          // never receives it into permitted/effective. Attempt it for the root case,
          // tolerate the EPERM, then assert what actually matters: that the Runner's
          // group can read the file. Failing here beats publishing material the
          // Runner cannot open, which surfaces only as its start-up timeout.
          await chown(temporary, 1101, runnerRuntimeGid).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          });
          const handedOver = await lstat(temporary);
          if (handedOver.gid !== runnerRuntimeGid) {
            await rm(temporary, { force: true });
            throw new Error(
              `control-plane Runner identity volume does not hand ${name} to the Runner group — it needs the setgid bit (chmod 2770)`,
            );
          }
          await rename(temporary, target);
        };
        const refreshIdentityOnce = async (): Promise<void> => {
          const material = await claudeEgressIdentity!.sandboxMaterial(
            CONTROL_PLANE_RUNNER_PROJECT_ID,
          );
          // The private key is deliberately NOT read back. It goes out group-readable
          // only (see below), so this process — which owns it — cannot open it, and a
          // read that always fails would make the comparison always stale and
          // republish on every turn, bumping the generation the Runner acknowledges.
          // Currency is decided on the two public files, which is sound because the
          // certificate and the key are issued as one pair: the key never changes
          // without the certificate changing with it.
          const desired = [material.caCertPem, material.clientCertPem];
          const current = await Promise.all(
            ['ca.crt', 'client.crt'].map((name) =>
              readFile(join(identityDir, name), 'utf8').catch(() => undefined),
            ),
          );
          const generation = await readFile(join(identityDir, 'generation'), 'utf8').catch(
            () => undefined,
          );
          // Metadata, not contents — the point is that this process cannot read the
          // key. An installation upgraded from the previous 0640 carries a key that is
          // CURRENT in content but still owner-readable, and the Runner refuses it. On
          // content alone nothing would ever rewrite that file, so the deployment would
          // stay broken until the certificate happened to rotate. A missing key lands
          // here too, and is republished for the same reason.
          const keyMode = await lstat(join(identityDir, 'client.key'))
            .then((stats) => stats.mode & 0o777)
            .catch(() => undefined);
          // The key's own contents can no longer be compared, so its fingerprint is
          // published beside it — AFTER the key, so an interruption between the two
          // leaves a stale fingerprint and the next pass republishes. Without it a
          // crash between `client.crt` and `client.key` would leave a mismatched pair
          // that looks current forever: the certificates agree, the mode is right, and
          // the generation from the previous pass is merely non-empty.
          const keyFingerprint = createHash('sha256').update(material.clientKeyPem).digest('hex');
          const publishedFingerprint = await readFile(
            join(identityDir, 'client.key.sha256'),
            'utf8',
          ).catch(() => undefined);
          const keyCurrent = keyMode === 0o040 && publishedFingerprint?.trim() === keyFingerprint;
          const pemCurrent = desired.every((value, index) => value === current[index]);
          if (pemCurrent && keyCurrent && generation !== undefined && generation.trim() !== '')
            return;
          if (!pemCurrent || !keyCurrent) {
            await publish('ca.crt', material.caCertPem, 0o640);
            await publish('client.crt', material.clientCertPem, 0o640);
            // Group read ONLY. The Runner refuses a private key whose owner can
            // still read it ("must not be owner-readable unless owned by Runner or
            // root") — and it is right to: handing the key over by ownership is
            // impossible here, because chown() to the Runner needs a capability an
            // unprivileged process cannot hold. Clearing the owner bits is what makes
            // the file private to the Runner group despite being owned by the Server.
            await publish('client.key', material.clientKeyPem, 0o040);
            await publish('client.key.sha256', keyFingerprint, 0o640);
          }
          // Published last: the sidecar reconciler never observes a half-rotated
          // certificate/key pair merely because the three PEM renames are separate.
          await publish('generation', randomUUID(), 0o640);
        };
        refreshControlPlaneRunnerIdentity = (): Promise<void> => {
          const refresh = controlPlaneIdentityRefreshTail.then(
            refreshIdentityOnce,
            refreshIdentityOnce,
          );
          controlPlaneIdentityRefreshTail = refresh.catch(() => undefined);
          return refresh;
        };
        awaitControlPlaneRunnerIdentity = async (): Promise<void> => {
          if (config.dataVolumeRoot === undefined) {
            throw new Error('control-plane Runner runtime is unavailable');
          }
          const expected = (await readFile(join(identityDir, 'generation'), 'utf8')).trim();
          const acknowledgment = join(
            config.dataVolumeRoot,
            'runners',
            CONTROL_PLANE_RUNNER_PROJECT_ID,
            'claude-egress-generation',
          );
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const actual = await readFile(acknowledgment, 'utf8').catch(() => undefined);
            if (actual?.trim() === expected) return;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Claude control-plane Runner did not acknowledge its egress identity.');
        };
        // The identity material is encrypted at rest, so publishing it needs an
        // OPEN store — and an interactive deployment always boots sealed. Failing
        // the boot here is unrecoverable in a way no other sealed-boot path is:
        // the Server dies before it binds a listener, so `/secret/unlock` is
        // unreachable and the operator cannot unseal it from the app. A plain
        // host restart is enough to trigger it, and the only way back out is to
        // disable the Runner. Defer to the unlock callback instead, exactly like
        // the Agent Gateway identity projection below.
        await publishRunnerIdentity('startup');
      }
    }
    if (config.controlPlaneRunner === true && refreshControlPlaneRunnerIdentity === undefined) {
      throw new Error('Claude control-plane Runner requires complete egress identity wiring.');
    }
    provisioner = new ProvisionerImpl({
      store: eventStore,
      db,
      docker,
      token: tokenSource,
      defaultImageRef: defaultProjectImage,
      ghTokenFilePath: ghTokenPath,
      projectTokenMint,
      veritySettings: () => eventStore.getVeritySettings(),
      // Linking a local project to a repository that already has history publishes an
      // import branch and opens the pull request that carries it onto the default
      // branch — the token is the one-shot, target-scoped mint the link route made.
      openPullRequest: (target, token, pr) => openPullRequest(target, token, pr),
      gitSecretRoot: secretRoot,
      // GitHub-token broker: the SAME registry the /internal/github/token endpoint
      // resolves against. The provisioner issues a per-container capability into it
      // instead of writing a gh-token file, so the sandbox mints tokens on demand.
      ghTokenCapabilities,
      projectRelay: projectRelayControl!,
      claudeEgressGatewayUrl: config.claudeEgressGatewayUrl!,
      codexEgressGatewayUrl: config.codexEgressGatewayUrl!,
      claudeEgressGatewayConnectHost:
        config.claudeEgressGatewayHost === undefined ||
        config.claudeEgressGatewayHost === '0.0.0.0' ||
        config.claudeEgressGatewayHost === '::'
          ? '127.0.0.1'
          : config.claudeEgressGatewayHost,
      // Claude-egress projection (opt-in): when the identity service is wired, the
      // provisioner issues this project's client cert and projects the public CA +
      // client cert/key + the connector's coordinates into the sandbox. All four
      // must be present together for the connector's all-or-nothing gate.
      ...(claudeEgressIdentity !== undefined &&
      config.claudeEgressGatewayUrl !== undefined &&
      config.claudeConnectorPort !== undefined
        ? {
            claudeEgressIdentity,
            claudeConnectorPort: config.claudeConnectorPort,
            ...(claudeEgressServerName !== undefined ? { claudeEgressServerName } : {}),
            ...(agentGatewayUrl === undefined
              ? {}
              : {
                  claudeEgressGatewayForProject: () => ({
                    url: agentGatewayUrl.href,
                    serverName: agentGatewayUrl.hostname,
                  }),
                }),
          }
        : {}),
      recreateEnvDriftedSandboxes: config.recreateEnvDriftedSandboxes ?? true,
      onContainerStarted: async () => {
        await projectAgentGatewayIdentity(true);
      },
      ...(previewShareManager !== undefined
        ? {
            withContainerReplace: <T>(project: ProjectRecord, mutation: () => Promise<T>) =>
              previewShareManager.withProjectMutation(project.id, mutation),
          }
        : {}),
      // Named data volume (M16): per-project mounts become volume subpaths instead
      // of host binds, so sibling sandboxes need no host-path knowledge.
      ...(config.dataVolume !== undefined ? { dataVolume: config.dataVolume } : {}),
      ...(config.dataVolumeRoot !== undefined ? { dataVolumeRoot: config.dataVolumeRoot } : {}),
      ...(config.runnerSupervisor !== undefined
        ? { runnerSupervisor: config.runnerSupervisor }
        : {}),
      ...(config.runnerRuntimeGid !== undefined
        ? { runnerRuntimeGid: config.runnerRuntimeGid }
        : {}),
      ...(config.runnerSupervisorTrustedDefaultImage !== undefined
        ? { runnerSupervisorTrustedDefaultImage: config.runnerSupervisorTrustedDefaultImage }
        : {}),
      // Sandbox runtime hardening (security review C1). Pass-through of the tunables;
      // the provisioner applies the hardened defaults (CapDrop ALL, no-new-privileges,
      // PidsLimit) whether or not these are set.
      ...(config.sandboxPidsLimit !== undefined
        ? { sandboxPidsLimit: config.sandboxPidsLimit }
        : {}),
      ...(config.sandboxMemoryBytes !== undefined
        ? { sandboxMemoryBytes: config.sandboxMemoryBytes }
        : {}),
      ...(config.sandboxNanoCpus !== undefined ? { sandboxNanoCpus: config.sandboxNanoCpus } : {}),
      ...(config.sandboxCapAdd !== undefined ? { sandboxCapAdd: config.sandboxCapAdd } : {}),
      ...(config.sandboxAllowPrivilegeEscalation !== undefined
        ? { sandboxAllowPrivilegeEscalation: config.sandboxAllowPrivilegeEscalation }
        : {}),
      hostCloneRoot: config.hostCloneRoot,
      ...(config.agentSeedHostPath !== undefined
        ? { agentSeedHostPath: config.agentSeedHostPath }
        : {}),
      claudeConfigVolume: config.claudeConfigVolume ?? 'claude-config-verity',
      codexConfigVolume: config.codexConfigVolume ?? 'codex-config-verity',
      opencodeConfigVolume: config.opencodeConfigVolume ?? 'opencode-config-verity',
      piConfigVolume: config.piConfigVolume ?? 'pi-config-verity',
      // ghcr auth for devcontainer builds: mint a `packages:read` installation token
      // so the build resolves the PRIVATE verity-sandbox-toolkit Feature + pulls the
      // base image AS THE APP — no operator PAT or persistent docker login needed.
      registryTokenMint: createGitHubAppInstallationTokenMint({
        ...baseMintOpts,
        permissions: REGISTRY_GITHUB_TOKEN_PERMISSIONS,
      }),
      // Live devcontainer support (R3.1/#299): when a cloned repo has
      // `.devcontainer/`, build a derived image on the same Docker daemon and
      // inject the published Verity toolkit Feature on top. Repos without a
      // devcontainer keep using the default sandbox image.
      ...devcontainerProvisionerOptionsForDockerBaseUrl(dockerBaseUrl, devcontainerFeature),
    });
    deprovisioner = new DeprovisionerImpl(
      eventStore,
      db,
      docker,
      config.hostCloneRoot,
      // Defaults for the isDir / removeDir seams; the registry is the real addition
      // so teardown revokes the project's token-broker capability.
      undefined,
      undefined,
      ghTokenCapabilities,
      config.dataVolumeRoot === undefined ? undefined : join(config.dataVolumeRoot, 'runners'),
      // Revoke the project's Claude-egress client cert on teardown (opt-in).
      claudeEgressIdentity,
      projectRelayControl,
      previewShareManager === undefined
        ? undefined
        : (project: ProjectRecord, mutation: () => Promise<ProjectRecord>) =>
            previewShareManager.withProjectMutation(project.id, mutation),
      // Resource cleanup never blocks the deprovision, so the log is where a
      // leftover container, clone directory, or relay socket becomes visible.
      (project: ProjectRecord, step: string, cause: unknown) =>
        app.log.warn(
          { projectId: project.id, step, err: cause },
          'verity: project teardown step failed — deprovision continued',
        ),
      // Revoked fail-closed on teardown: `relay.stop` above is best-effort, so
      // its capability revocation is repeated here where a failure is fatal.
      signingCapabilities,
    );
  }

  // Migration 0084 records every project whose running container may still
  // carry a legacy credential. Remove those containers before any listener is
  // exposed; after unlock, the central broker revokes scoped tokens and only
  // then recreates clean broker-only containers.
  await quarantineLegacyDopplerContainers(db, docker);
  finishLegacyDopplerCutover = (): Promise<number> =>
    completeLegacyDopplerCutover({
      db,
      provisioner,
      readCredential: readStoredBrokerDopplerCredential,
      revoke: revokeLegacyDopplerToken,
      validateBinding: async ({ project, config: dopplerConfig, credential }) => {
        const token = credential.toString('utf8').trim();
        const configs = await listDopplerConfigs(token, project);
        if (!configs.some((candidate) => candidate.name === dopplerConfig)) {
          throw new Error('central Doppler broker identity cannot access a legacy project mapping');
        }
      },
    });

  // Hoisted so the runner-transport factory (ADR 0006 Stage 2.2-prep) can close
  // over the SAME bus instance the control plane's WS subscribers/Conductor use —
  // events the FileTailRunnerClient republishes off the tailed event file must
  // reach the exact bus the live stream reads from, not a second instance.
  const bus = new InMemoryEventBus();

  // Per-turn transport path allocators (ADR 0006 Stage 2.2-prep). Only exercised
  // when `config.runnerTransport` is on; cheap to build unconditionally.
  //
  // CRITICAL: a unix-domain socket path has a ~108-char OS limit, so the socket
  // dir MUST be short — `<tmpdir>/verity-runner` with a bare `<uuid>.sock` name
  // (NOT a deep workspaces/worktree path, which would overrun the limit and fail
  // the bind with EINVAL/ENAMETOOLONG). The event file has no such limit but reuses
  // the same short base for locality. Each allocator returns a fresh unique path.
  const runnerTransportDir = join(tmpdir(), 'verity-runner');
  if (config.runnerTransport === true) {
    // Create the base dir once (idempotent) so the per-turn allocators don't each
    // race a mkdir; the RunnerServer still mkdir's the event file's own parent.
    mkdirSync(runnerTransportDir, { recursive: true });
  }
  const allocateEventFile = (): string => join(runnerTransportDir, `${randomUUID()}.events.jsonl`);
  const allocateControlSocket = (): string => join(runnerTransportDir, `${randomUUID()}.sock`);

  // One verbatim transcript store shared by the Conductor (restore-before-resume +
  // in-process tail) and, on the runner-supervisor path, the server-side {@link
  // ServerTranscript} sink — both are stateless handles over the same `db`.
  const transcriptStore = new TranscriptStore(db);

  const claudeCredentialSync = startClaudeCredentialSync(eventStore, secretRoot, (error) => {
    if (error instanceof SealedError) return;
    // Never include credential contents in this diagnostic.
    console.warn(`verity: failed to synchronize rotated Claude credentials: ${String(error)}`);
  });
  let stopAgentGatewayCredentialProjection = (): Promise<void> => Promise.resolve();
  // Resolve the Claude credential on demand. A sealed boot cannot read it, and
  // the identity projection below has no configuration to send without it, so
  // whoever unlocks the store has to ask for it again rather than wait out the
  // 60s reconciler. Assigned only when credential projection is wired up at all.
  let refreshAgentGatewayCredential = (): Promise<void> => Promise.resolve();
  if (
    config.agentGatewayControlSocket !== undefined &&
    config.agentGatewayUnsealKey !== undefined
  ) {
    const projectCredential = async (): Promise<void> => {
      // A confirmed missing credential is an explicit revocation. Errors retain
      // the last valid projection and are retried by the periodic reconciler.
      const token = await claudeCredentialSync.getAccessToken();
      const projected = token ?? null;
      const settings = await eventStore.getVeritySettings();
      const codexAuth = settings?.codexAuthJson;
      const projectedCodex =
        typeof codexAuth === 'string' && codexAuth.trim().length > 0 ? codexAuth : null;
      if (projected === agentGatewayAccessToken && projectedCodex === agentGatewayCodexAuthJson)
        return;
      agentGatewayAccessToken = projected;
      agentGatewayCodexAuthJson = projectedCodex;
      syncAgentGateway();
    };
    let projection: Promise<void> | undefined;
    let projectionRequested = false;
    let projectionClosed = false;
    const projectCredentialSafely = (): void => {
      if (projectionClosed) return;
      projectionRequested = true;
      if (projection !== undefined) return;
      projection = (async () => {
        while (!projectionClosed && projectionRequested) {
          projectionRequested = false;
          await projectCredential().catch((error) => {
            // Runs during control-plane construction, before `app` exists, so it
            // must not reference the Fastify logger (doing so threw a TDZ
            // ReferenceError that crash-looped the server on every sealed boot).
            // A sealed store is the expected boot state — stay quiet and let the
            // periodic reconciler retry once the store is unlocked.
            if (error instanceof SealedError) return;
            console.warn(`verity: agent gateway credential projection failed: ${String(error)}`);
          });
        }
      })().finally(() => {
        projection = undefined;
        if (!projectionClosed && projectionRequested) projectCredentialSafely();
      });
    };
    // Awaiting the in-flight cycle lets the unlock path establish the credential
    // before it returns, so a caller that unlocks and then inspects the gateway
    // sees a projected configuration rather than a race.
    refreshAgentGatewayCredential = async (): Promise<void> => {
      projectCredentialSafely();
      await projection;
    };
    projectCredentialSafely();
    const unsubscribe = claudeCredentialSync.onCredentialsChanged(projectCredentialSafely);
    const timer = setInterval(projectCredentialSafely, 60_000);
    timer.unref();
    stopAgentGatewayCredentialProjection = async (): Promise<void> => {
      clearInterval(timer);
      unsubscribe();
      projectionClosed = true;
      await projection;
    };
  }

  const projectAgentGatewayIdentity = async (confirm = false): Promise<void> => {
    if (claudeEgressIdentity === undefined) return;
    // A sealed boot cannot read the Claude credential, so it stays `undefined`
    // and the projection below sends nothing at all — the synchronizer has no
    // snapshot, and its reconciler is a no-op until the 60s credential timer.
    // That hole is wide enough for a self-update to replace the gateway with an
    // empty container and give up waiting for a health it cannot reach yet, so
    // resolve the credential here, before the generation-guarded loop. Once it
    // is resolved this is skipped, which keeps the per-container-start path free.
    if (agentGatewayAccessToken === undefined) await refreshAgentGatewayCredential();
    for (;;) {
      const bindingGeneration = agentGatewayBindingGeneration;
      const material = await claudeEgressIdentity.gatewayMaterial();
      const routedBindings = await routedAgentGatewayBindings(material.peerBindings);
      // Issuance/revocation callbacks advance the generation before doing their
      // own asynchronous Docker inspection. Never let an older snapshot overtake
      // one of those mutations and re-authorize a revoked certificate.
      if (bindingGeneration !== agentGatewayBindingGeneration) continue;
      agentGatewayTls = material.tls;
      agentGatewayBindings = routedBindings;
      // An omitted credential means revocation to the gateway. Preserve its
      // encrypted recovery spill until credential synchronization has resolved to
      // either a current token or an explicit null.
      if (agentGatewayAccessToken !== undefined) {
        const configuration = agentGatewayConfiguration();
        if (configuration !== undefined && agentGatewaySynchronizer !== undefined && confirm) {
          await agentGatewaySynchronizer.updateAndWait(configuration);
        } else {
          syncAgentGateway();
        }
      }
      return;
    }
  };
  try {
    await projectAgentGatewayIdentity();
  } catch (error) {
    // Interactive deployments boot sealed. The successful init/unlock callback
    // below retries the standalone-gateway projection.
    if (error instanceof SealedError) {
      console.warn('verity: Agent Gateway identity projection deferred until unlock');
    } else throw error;
  }

  // Deploy-time toolkit drift (see `toolkit-drift.ts`). The runner-boundary
  // attestation already catches a stale Sandbox image — but per project, only at
  // its next provision, and as a denial that silently removes the native tool
  // channel. The moment the fleet goes stale is a Server deploy, and until now
  // nothing said so at that moment.
  await reportToolkitDrift({
    listProjects: () => eventStore.listProjects(),
    trustedIdentity: () => trustedToolkitIdentity(),
    warn: (line) => {
      console.warn(line);
    },
  });

  /**
   * Remove the transcript files these bindings name on the runner runtime.
   *
   * A backend transcript is reachable only through a `session_backend_state` row, so it
   * has to be deleted at the moment such a row does — whether that is the session being
   * deleted (`purgeSessionArtifacts` below) or the session switching to another backend
   * (`purgeBackendArtifacts` on the Conductor, where the displaced rows are the last
   * thing that can still name the files). Both routes land here so the two cannot drift.
   *
   * Lossless in either case: the files are derivatives of the durable store (see
   * `session-artifacts.ts`) and are materialized back out of it on resume. Leaving them
   * — which is what Verity did until now — meant every session ever deleted was still
   * readable on disk, verbatim prompts and replies included.
   *
   * Undefined without `dataVolumeRoot`: there is no runner runtime then, and the
   * loopback backends (OpenCode, Pi) keep their state inside the Sandbox container's own
   * overlay, which dies with the container.
   */
  const dataVolumeRoot = config.dataVolumeRoot;
  /**
   * A session's cwd as the SANDBOX saw it, which is what claude encodes into its
   * `projects/` directory name.
   *
   * One definition on purpose. The purge resolves a session's transcript through it, and
   * the startup sweep derives from it the set of directories a live session still owns —
   * the guard that keeps a switched-away session's unreproducible `subagents/` tree from
   * being collected. If the two derived that name differently the sweep's guard would
   * match nothing and silently degrade to deleting those trees, so they may not be two
   * expressions that merely happen to agree — hence the shared function and the shared
   * {@link RUNNER_CONTAINER_PROJECT_ROOT}, rather than a second `'/work'` here.
   *
   * A worktree the mapping does not rewrite — outside the clone root, or a deployment
   * with no clone root at all — keeps its host path, and the runner's own call gets that
   * same answer from the same function. The two still agree; they just agree on the
   * unmapped path.
   */
  const sessionSandboxCwd = (worktree: string): string =>
    runnerSandboxPath(worktree, config.hostCloneRoot, RUNNER_CONTAINER_PROJECT_ROOT);
  const purgeRunnerArtifacts =
    dataVolumeRoot === undefined
      ? undefined
      : async (
          sessionId: string,
          bindings: readonly { backend: string; backendSessionId: string }[],
          scope: SessionArtifactScope,
        ): Promise<void> => {
          try {
            // A delete runs even with no bindings at all: a cold-started claude thread
            // writes `<veritySessionId>.jsonl` before the binding row naming it lands, so
            // a session deleted in that window has a transcript nothing points at. A
            // switch, by contrast, is only ever called with the rows it displaced.
            if (bindings.length === 0 && scope !== 'session-delete') return;
            const session = await eventStore.getSession(sessionId);
            if (session === undefined) {
              // The row is what names the worktree, and without it there is no directory
              // to look in. Reachable rather than defensive: a delete that gave up on a
              // slow purge (`SESSION_ARTIFACT_PURGE_TIMEOUT_MS`) removes the row while
              // this call is still in flight, and the files it was going to take are then
              // left for the startup sweep. Logged because a leak nobody hears about is
              // how the whole class of bug this module fixes went unnoticed for months.
              app.log.warn(
                { sessionId, scope },
                'verity: transcript purge found no session row — leaving its files to the startup sweep',
              );
              return;
            }
            const controlPlaneRunner = config.controlPlaneRunner === true;
            // Only asked when it can change the answer — this runs once per session in the
            // project-delete loop, and the lookup is pure overhead in every deployment
            // without the dedicated control-plane runner.
            const isControlPlaneProject =
              controlPlaneRunner && session.projectId !== null
                ? (await eventStore.getProject(session.projectId))?.kind === 'control_plane'
                : false;
            const runnerProjectIds = new Set(
              candidateRunnerProjectIds({
                projectId: session.projectId,
                isControlPlaneProject,
                controlPlaneRunner,
              }),
            );
            if (runnerProjectIds.size === 0) return;

            const sandboxCwd = sessionSandboxCwd(session.worktree);
            const removed: string[] = [];
            const absent: string[] = [];
            const absentBound: string[] = [];
            const failed: string[] = [];
            const outsideRuntime: string[] = [];
            const unresolved: string[] = [];
            const unknownBackends = new Set<string>();
            let runtimeSeen = false;
            for (const runnerProjectId of runnerProjectIds) {
              const runtimeDir = join(dataVolumeRoot, 'runners', runnerProjectId);
              const purge = await purgeSessionArtifactFiles({
                runtimeDir,
                sandboxCwd,
                bindings,
                sessionId,
                scope,
              });
              removed.push(...purge.removed);
              absent.push(...purge.absent);
              absentBound.push(...purge.absentBound);
              failed.push(...purge.failed);
              outsideRuntime.push(...purge.outsideRuntime);
              if (!purge.runtimeMissing) runtimeSeen = true;
              if (purge.unresolved) unresolved.push(runtimeDir);
              for (const backend of purge.unknownBackends) unknownBackends.add(backend);
            }
            // A path that resolved OUT of the runtime means something planted a symlink in
            // a directory the Sandbox can write. Nothing was deleted — but this is not a
            // cleanup problem, so it gets its own message rather than being read as one.
            if (outsideRuntime.length > 0) {
              app.log.error(
                { sessionId, scope, outsideRuntime },
                'verity: refused a transcript path that resolved outside the runner runtime',
              );
            }
            // All three mean a transcript outlived the row naming it, which is the exact
            // failure this code was written to end — so say so rather than counting a
            // partial purge as a clean one. `unresolved` is the runtime whose file list
            // could not even be built, which returns the same empty result as a session
            // that had nothing there. `absent` rides along for context and does not gate:
            // a session that never ran a claude subagent legitimately produces one, and
            // searching a second candidate runtime produces a full set. It is only worth
            // reading when NOTHING was removed, which is what a wrong `sandboxCwd` or a
            // wrong runtime looks like.
            if (failed.length > 0 || unknownBackends.size > 0 || unresolved.length > 0) {
              app.log.warn(
                {
                  sessionId,
                  scope,
                  runnerProjectIds: [...runnerProjectIds],
                  removed: removed.length,
                  absent: absent.length,
                  failed,
                  unresolved,
                  unknownBackends: [...unknownBackends],
                },
                'verity: backend transcripts outlived the session state naming them',
              );
            }
            // Nothing removed, nothing failed, and every path a BINDING named came back
            // absent — from a runtime that is actually there. That is the shape of a
            // `sandboxCwd` or a runtime directory derived wrongly: it deletes nothing,
            // reports no error, and would otherwise be indistinguishable from a clean
            // purge. It is also the shape of a session whose files an earlier sweep already
            // collected, which is why it warns rather than errors — but without it the most
            // likely systemic failure in this path is silent.
            //
            // `absentBound`, not `absent`, and only with a runtime present: a delete always
            // resolves the two speculative claude paths, and a project delete tears the
            // runtime down before purging its sessions. Gating on the wider signal would put
            // this line on every OpenCode session delete and every session in a project
            // delete — routine events, both — and a warning that fires on the routine case
            // is not read when the real one arrives.
            if (
              runtimeSeen &&
              absentBound.length > 0 &&
              removed.length === 0 &&
              failed.length === 0
            ) {
              app.log.warn(
                {
                  sessionId,
                  scope,
                  runnerProjectIds: [...runnerProjectIds],
                  sandboxCwd,
                  absent: absentBound.length,
                },
                'verity: found none of a session’s backend transcripts where they should be',
              );
            }
          } catch (error) {
            // Both call sites — the session delete in `server.ts` and the backend switch
            // on the Conductor — swallow a rejection here on the grounds that it is
            // "logged by the implementation". This is what makes that true. The store
            // reads above happen BEFORE the per-file loop that reports its own outcome,
            // so a failure there would otherwise leave a leaked transcript with no record
            // anywhere — and an invisible leak is the thing this module exists to end.
            app.log.error(
              { err: error, sessionId, scope },
              'verity: could not purge the backend transcripts of a session',
            );
          }
        };

  const usesClaudeBackend = (model: string | undefined): boolean =>
    !isCodexModel(model) && !(config.openCodeEnabled === true && model?.includes('/'));
  let cachedProjects: { at: number; result: ProjectRecord[] } | undefined;
  let projectsInflight: Promise<ProjectRecord[]> | undefined;

  const app = buildControlPlane({
    eventStore,
    workflowStore,
    ...(config.workflowGithubWebhookSecret !== undefined
      ? { workflowGithubWebhookSecret: config.workflowGithubWebhookSecret }
      : {}),
    ...(config.authorizeWorkflowAction !== undefined
      ? { authorizeWorkflowAction: config.authorizeWorkflowAction }
      : {}),
    bus,
    ...(purgeRunnerArtifacts === undefined
      ? {}
      : {
          purgeSessionArtifacts: async (sessionId: string): Promise<void> => {
            // Read the bindings HERE rather than in the helper: this is the delete path,
            // and the rows are about to go with the FK cascade.
            await purgeRunnerArtifacts(
              sessionId,
              await eventStore.getSessionBackendStates(sessionId),
              'session-delete',
            );
          },
        }),
    ...(config.serverUpdateResolver !== undefined
      ? { serverUpdateResolver: config.serverUpdateResolver }
      : {}),
    ...(config.serverUpdateController !== undefined
      ? { serverUpdateController: config.serverUpdateController }
      : {}),
    ...(config.serverUpdateNotifierStatePath !== undefined
      ? { serverUpdateNotifierStatePath: config.serverUpdateNotifierStatePath }
      : {}),
    ...(previewShareManager !== undefined ? { previewShareManager } : {}),
    ...(uplinkControl !== undefined
      ? { onUplinkCredentialsChanged: () => uplinkControl.refreshCredentials() }
      : {}),
    ...(config.googleDriveClientId !== undefined
      ? { googleDriveClientId: config.googleDriveClientId }
      : {}),
    secretCipher,
    persistAgentCredentials: async (patch, persist) => {
      await claudeCredentialSync.persistCredentials(patch, persist);
      if (patch.codexAuthJson !== undefined) await codexModelCatalog?.refresh();
    },
    claudeOAuthTokenProvider: claudeCredentialSync.getAccessToken,
    // The Codex quota probe reads its token from the gateway, the single refresh
    // authority for the rotating Codex login (ADR 0010) — deliberately not from the
    // stored `codexAuthJson`, which would make the Server a second writer. Without a
    // gateway the probe stays inert and the meter keeps its per-session signal.
    ...(codexGatewayCredentialProvider === undefined ? {} : { codexGatewayCredentialProvider }),
    onSecretUnlocked: async () => {
      await finishLegacyDopplerCutover();
      await projectAgentGatewayIdentity();
      // Publishes what the sealed boot had to skip. Ordered after the gateway
      // projection because both mint from the same CA and the gateway is what a
      // Sandbox needs first; the Runner picks its material up by generation file.
      await publishRunnerIdentity('secret unlock');
      await codexModelCatalog?.refresh();
    },
    authRegistry,
    pushEnabled: config.pushEnabled === true,
    // ADR 0011 D2: the operator's review-and-revoke surface for standing grants. The
    // current binding is passed so each grant can be flagged with whether it would
    // auto-approve anything today — but grants against a superseded binding are still
    // listed, because binding ids are derived deterministically and a restored binding
    // would put such a grant back in force. Unlistable is unrevokable.
    listBrokeredGrants: async (projectId) =>
      brokeredHttpGrants.list(projectId, (await brokeredGrantBindingId(projectId)) ?? null),
    revokeBrokeredGrant: (projectId, grantId) => brokeredHttpGrants.revoke(projectId, grantId),
    ...(secretJobRuntimeReadiness !== undefined ? { secretJobRuntimeReadiness } : {}),
    ...(config.pushEnabled === true
      ? {
          pushSender: (logger: FastifyBaseLogger) =>
            createPushSender({
              store: eventStore,
              transport: createExpoPushTransport(config.expoAccessToken),
              logger,
            }),
        }
      : {}),
    ...(config.wsAllowedOrigins !== undefined ? { wsAllowedOrigins: config.wsAllowedOrigins } : {}),
    signingCapabilities,
    // When a dedicated internal listener is configured, gate `/internal/*` to it
    // (the public listener 404s those paths). main.ts starts that listener and
    // tags its sockets; this predicate reads the tag. Omit → no gate.
    ...(config.internalPort !== undefined ? { internalPathGuard: requestArrivedInternally } : {}),
    // `configuredCodexModels` stands in for the catalogue as well as for itself: the
    // refresh timer only runs when `codexModels` was left unset, and that is precisely
    // the case where this list falls back to `[CODEX_DEFAULT_MODEL]`. So a populated
    // catalogue always has a non-empty list beside it, and this gate cannot drop one.
    ...(openCodeModels.length > 0 || configuredCodexModels.length > 0
      ? {
          // Synchronous behind an async contract: the Codex catalogue is a cache the
          // refresh timer fills, and the OpenCode half is the operator's pinned list,
          // so neither half has anything to await since the transport migration. The
          // signature stays a promise because it is the seam a live catalogue would
          // reappear in.
          listModels: () =>
            Promise.resolve([
              ...(codexModelCatalog?.list() ?? configuredCodexModels),
              ...openCodeModels,
            ]),
        }
      : {}),
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
    ...(config.workspacesDir !== undefined ? { spawnWorktreeRoot: config.workspacesDir } : {}),
    ...(worktrees !== undefined ? { worktrees } : {}),
    ...(branches !== undefined ? { branches } : {}),
    ...(prServiceFor !== undefined
      ? { branchPr: (b: string, wt: string) => prServiceFor(wt).prForBranch(b) }
      : {}),
    ...(prServiceFor !== undefined
      ? { branchPrStatus: (b: string, wt: string) => prServiceFor(wt).prStatusForBranch(b) }
      : {}),
    ...(prServiceFor !== undefined
      ? {
          branchPrStatusForBranches: (bs: readonly string[], wt: string) =>
            prServiceFor(wt).prStatusForBranches(bs),
        }
      : {}),
    ...(prServiceFor !== undefined
      ? {
          mergePr: (n: number, wt: string, expectedHeadSha?: string) =>
            prServiceFor(wt).mergePr(n, expectedHeadSha),
        }
      : {}),
    repoIdentity: (wt: string) => repoIdentityFor(wt)(),
    // Live GitHub-App credential validation for the onboarding wizard (#320). The
    // route reads + decrypts the stored creds itself (unsealed-only) and hands them
    // here; this just performs the redaction-safe test-mint against GitHub.
    githubAppValidate: (creds: GitHubAppCreds) => validateGitHubAppCreds(creds),
    // GitHub-token broker: resolve a sandbox capability + mint its repo-scoped token.
    ghTokenCapabilities,
    ghTokenMint: (project) => cachedProjectTokenMint(project),
    // Loopback MCP gateway for ACP sessions (ADR 0014 D1). The approval seam is
    // deliberately absent here and bound inside buildServer to its own conductor.
    mcpGateway,
    // Derive the git committer identity from the App installation for the
    // signing-key onboarding step. Resolves the (decrypted) creds from settings;
    // undefined when no App is configured yet (nothing to derive).
    resolveGitHubAppIdentity: async (): Promise<GitHubAppIdentityResult | undefined> => {
      const creds = await resolveGithubAppCreds();
      return creds === undefined ? undefined : resolveGitHubAppIdentity(creds);
    },
    // Live Doppler Service Account token validation for the OPTIONAL onboarding
    // Doppler step (#320). The route reads + decrypts the stored token itself
    // (unsealed-only) and hands it here; this just performs the redaction-safe
    // list-projects check against Doppler.
    dopplerValidate: (token: string) => validateDopplerToken(token),
    dopplerCredentialReader: readBrokerDopplerCredential,
    // Live Doppler project/config listing for the binding picker (#320). Both read
    // the account token from the decrypting route (unsealed-only) and list from
    // that TRUSTED token — NOT repo content (closes the confused-deputy). Both are
    // contractually redaction-safe: never log/echo the token; return only the
    // NON-secret slug/name summaries.
    dopplerListProjects: (token: string) => listDopplerProjects(token),
    dopplerListConfigs: (token: string, project: string) => listDopplerConfigs(token, project),
    // Real code→App conversion for the manifest one-click onboarding routes
    // (#320). Redaction-safe by contract: never logs the PEM / GitHub body. The
    // callback route persists the returned app id + PEM via the sealed store.
    manifestConvert: defaultManifestConvert(),
    // Real server-side ssh-keygen for the onboarding signing-key step (#320).
    // Needs `openssh-client` in the Server image (deploy/Dockerfile). Injectable
    // so tests never shell out.
    sshKeygen: defaultSshKeygenSpawner,
    ...(issueService !== undefined ? { listIssues: () => issueService.listOpenIssues() } : {}),
    ...(taskService !== undefined ? { taskService } : {}),
    // Voice → Refiner (ADR 0007): the one-shot refiner runs in the server's repo for
    // context. Present only with a repo; the route 503s otherwise.
    ...(config.repoDir ? { refineCwd: config.repoDir } : {}),
    latestRelease: (owner: string, repo: string) => releaseService.latestRelease(owner, repo),
    refreshLatestRelease: (owner: string, repo: string) =>
      releaseService.refreshLatestRelease(owner, repo),
    // Multi-repo fleet-registry listing (concept §19, #174). The provider syncs
    // the live GitHub-App-installation repos into the durable `projects` cache
    // (upsert preserves worker-owned state — cloning/container_starting/active/
    // failed survives a list-refresh that runs mid-provisioning) and returns the
    // cache. New repos land as `state='absent'`; Verity-self's row appears after
    // the first `GET /projects` because Verity is itself a normal installation
    // repo (§19.1).
    ...(installationService !== undefined
      ? {
          ...(refreshProjectToken !== undefined ? { refreshProjectToken } : {}),
          listProjects: async () => {
            if (hasMasterPassword && secretCipher.isSealed()) throw new SealedError();
            if (cachedProjects && Date.now() - cachedProjects.at < 3_000) {
              return cachedProjects.result;
            }
            if (projectsInflight) return projectsInflight;
            projectsInflight = (async () => {
              const projects = await syncProjectsFromInstallation(eventStore, installationService);
              const reconciled =
                docker !== undefined
                  ? reconcileProjectContainerStates(
                      projects,
                      docker,
                      (id, state, provisionError, provisionWarning) =>
                        eventStore.updateProjectState(id, state, provisionError, provisionWarning),
                      (id) => provisioner?.isProjectProvisioning(id) === true,
                    )
                  : projects;
              const result = await reconciled;
              // Nudge Runner-supervisor reconciliation OFF the hot path: reconcile
              // fans out a `docker exec` into every active sandbox, so awaiting it
              // here would add per-container Docker latency to project listing. The
              // periodic reconciler (below) is the primary driver and surfaces its
              // own failures; this list-triggered call is best-effort.
              void provisioner?.reconcileRunnerSupervisors(result).catch(() => undefined);
              return result;
            })()
              .then((result) => {
                cachedProjects = { at: Date.now(), result };
                return result;
              })
              .finally(() => {
                projectsInflight = undefined;
              });
            return projectsInflight;
          },
          listAvailableRepositories: async () => {
            if (hasMasterPassword && secretCipher.isSealed()) throw new SealedError();
            return syncProjectsFromInstallation(eventStore, installationService, {
              includeHidden: true,
            });
          },
        }
      : {}),
    // Single-project freshness for `GET /projects/:id` (the screen that owns
    // Repair). Deliberately independent of `listProjects`: no GitHub-installation
    // sync and no list cache, just one container inspect — so detail stays correct
    // while the installation sync is degraded, and a sandbox that died is visible
    // the moment the screen loads instead of after the next overview poll.
    ...(docker !== undefined
      ? {
          reconcileProjectState: async (project: ProjectRecord) => {
            const [reconciled] = await reconcileProjectContainerStates(
              [project],
              docker,
              (id, state, provisionError, provisionWarning) =>
                eventStore.updateProjectState(id, state, provisionError, provisionWarning),
              (id) => provisioner?.isProjectProvisioning(id) === true,
            );
            return reconciled ?? project;
          },
        }
      : {}),
    ...(projectDocker !== undefined
      ? {
          sandboxUpdates: createSandboxUpdateChecker({
            docker: projectDocker,
            defaultProjectImage,
            defaultProjectImageVersion: config.defaultProjectImageVersion,
            toolkitFeatureRef:
              typeof devcontainerFeature === 'function'
                ? async () => (await devcontainerFeature())?.ref
                : devcontainerFeature?.ref,
          }),
        }
      : {}),
    // Repo root reserved for the human/main session — the server's delete path
    // never removes it (#105 safety guard); sessions always run in their own worktree.
    ...(config.repoDir !== undefined ? { workspaceDir: config.repoDir } : {}),
    // Multi-repo fleet-registry provisioner + deprovisioner (§19.3/#19.8). Absent →
    // the `project` field on POST /sessions and POST /projects/:id/deprovision
    // both return 503 (the mobile picker hides the fleet-registry UI).
    ...(provisioner !== undefined ? { provisioner } : {}),
    ...(config.dockerBaseUrl !== undefined && config.hostCloneRoot !== undefined
      ? { projectCloneRoot: config.hostCloneRoot }
      : {}),
    ...(!config.repoDir && config.hostCloneRoot !== undefined
      ? { projectWorktreeBranchesOnly: true }
      : {}),
    ...(config.dockerBaseUrl !== undefined && config.hostCloneRoot !== undefined
      ? {
          projectBackend: (project: ProjectRecord, selected, settings) =>
            new DockerExecBackend({
              containerName: project.containerName,
              hostProjectRoot: projectClonePath(config.hostCloneRoot as string, project),
              dockerBaseUrl: config.dockerBaseUrl,
              backend: selected,
              containerEnv: projectSettingsEnv(settings),
            }),
          // Git for the GitHub-free merge, run inside the project's own container.
          // Same shape as the backend above on purpose: the merge touches a clone the
          // session owns, so it must execute where the session's own code executes.
          // Needs the daemon client too — without one there is no way to tell a stopped
          // sandbox from a failing git, so the route reports merging as unconfigured
          // rather than running it somewhere else.
          ...(projectDocker !== undefined
            ? {
                sandboxGit: (project: ProjectRecord, clonePath: string) =>
                  createSandboxGit({
                    containerName: project.containerName,
                    hostRoot: clonePath,
                    dockerBaseUrl: config.dockerBaseUrl,
                    // Which of the two failed is settled with the daemon, never with the
                    // failed command's own output — which the repository can write.
                    inspect: () => projectDocker.inspectContainer(project.containerName),
                  }),
              }
            : {}),
          ...(config.enableProjectRuntime === true
            ? { projectRuntime: new DockerProjectRuntime({ dockerBaseUrl: config.dockerBaseUrl }) }
            : {}),
        }
      : {}),
    ...(deprovisioner !== undefined ? { deprovisioner } : {}),
    // Per-project session worktree factory whose `refreshBase` fetch carries the
    // project-scoped token (only wired when the App-token mint + docker/clone-root
    // are configured — same guard as `refreshProjectToken`).
    ...(projectWorktrees !== undefined ? { projectWorktrees } : {}),
    conductor: {
      // Stable ACP v1 is the only Claude transport (ADR 0012); the native
      // stream-json backend it replaced has been removed, rollback included.
      backend: new AcpClaudeBackend(),
      // ACP delegates every approval decision to its client. Keep Verity's
      // durable permission card/decision channel authoritative for those calls.
      permissionControl: true,
      // Capture each session's verbatim .jsonl so it survives + is resumable.
      transcript: transcriptStore,
      // ADR 0011 D3: expose the project's secret alias names to every turn whose
      // transport carries the brokered tools — ACP included, not just codex.
      brokeredSecretAliases,
      // ADR 0011 D2: scoped operator grants auto-approve matching brokered-secret prompts.
      checkBrokeredHttpGrant: async (input) => {
        const bindingId = await brokeredGrantBindingId(input.projectId);
        return bindingId === undefined ? false : brokeredHttpGrants.check({ ...input, bindingId });
      },
      persistBrokeredHttpGrant: async (input) => {
        const bindingId = await brokeredGrantBindingId(input.projectId);
        if (bindingId === undefined) throw new Error('project Doppler binding is unavailable');
        await brokeredHttpGrants.grant({ ...input, bindingId });
      },
      // Auto-name an unnamed session from its opening turn: the conductor derives a
      // 2–3 word title from the first chat using the session's OWN model (routed via
      // the same backend its turns run on). `afterTurns: 1` names off the very first
      // exchange, and the attempt fires at turn START — concurrently with the turn, off
      // the operator's prompt — so the name lands in seconds rather than waiting for the
      // reply to stream or the turn to settle. Best-effort — a failure just leaves the
      // branch label. When a title lands, also ask the same model for a short
      // English branch candidate and let the branch service rename only fresh,
      // unpublished Verity-created branches in place.
      autoTitle: {
        afterTurns: 1,
        ...(branches !== undefined
          ? {
              onBranchName: async (session, branchName) => {
                if (
                  !(await branchRenameAppliesToSession(session, (id) => eventStore.getProject(id)))
                ) {
                  return;
                }
                await branches.autoRename(session.worktree, branchName);
              },
            }
          : {}),
      },
      // Runner wiring (ADR 0006), opt-in per deployment flag — see {@link
      // buildRunnerConductorWiring}. `runnerSupervisor` routes project turns through a
      // restart-surviving Sandbox {@link SupervisorRunnerClient} (Server-owned transcript
      // + reattach recovery); `runnerTransport` uses the in-process
      // {@link FileTailRunnerClient} event-file/control-socket transport; neither leaves
      // the Conductor's default loopback byte-for-byte unchanged. `eventStore` is the real
      // EventSink; events republish onto the SAME hoisted `bus` the live WS stream reads.
      // Switching a session to another backend drops the previous backend's
      // `session_backend_state` row, and that row was the only thing naming its files
      // on the runner runtime. Purging here is the one chance to reach them; otherwise
      // they survive even the eventual delete of the session that wrote them. The
      // `backend-switch` scope keeps what the session still needs while it lives —
      // claude's `subagents/` tree has no other copy — and the startup sweep collects
      // that remainder once the displaced id is no longer live.
      ...(purgeRunnerArtifacts === undefined
        ? {}
        : {
            purgeBackendArtifacts: async (
              sessionId: string,
              bindings: readonly { backend: string; backendSessionId: string }[],
            ): Promise<void> => {
              await purgeRunnerArtifacts(sessionId, bindings, 'backend-switch');
            },
          }),
      ...buildRunnerConductorWiring({
        // The dedicated control-plane service is itself a supervisor transport;
        // never let its feature flag coexist with loopback conductor wiring.
        runnerSupervisor: config.runnerSupervisor === true || config.controlPlaneRunner === true,
        runnerTransport: config.runnerTransport === true,
        dataVolumeRoot: config.dataVolumeRoot,
        ...(config.controlPlaneRunner === true
          ? { controlPlaneProjectId: CONTROL_PLANE_RUNNER_PROJECT_ID }
          : {}),
        isControlPlaneProject: async (projectId) =>
          (await eventStore.getProject(projectId))?.kind === 'control_plane',
        store: eventStore,
        bus,
        transcript: transcriptStore,
        allocateEventFile,
        allocateControlSocket,
        getSession: (sessionId) => eventStore.getSession(sessionId),
        onMissingSupervisorSocket: ({ projectId, socketPath, reason }) => {
          app.log.warn(
            { projectId, socketPath, reason },
            'verity: project runner supervisor is unavailable',
          );
        },
        hostCloneRoot: config.hostCloneRoot,
        containerProjectRoot: RUNNER_CONTAINER_PROJECT_ROOT,
        // ADR 0014 D1: the ACP tool gateway bearer registry. The
        // registry is the Server's half of the gateway bearer — the runner client
        // mints one per ACP turn and retires it when the turn settles.
        mcpGatewayTokens,
        // ADR 0011 D2: a standing grant answers the prompt inside the tail, before
        // it can become an approval card or a push notification.
        autoApprovePermission: async (sessionId, request, channel) => {
          const toolName = brokeredGrantToolName(request.toolName);
          if (toolName === undefined) return false;
          const target = brokeredGrantTarget(toolName, request.input);
          if (target === undefined) return false;
          const session = await eventStore.getSession(sessionId);
          const projectId =
            session?.projectId ??
            (session !== undefined && config.controlPlaneRunner === true
              ? CONTROL_PLANE_RUNNER_PROJECT_ID
              : undefined);
          if (projectId == null) return false;
          const bindingId = await brokeredGrantBindingId(projectId);
          if (bindingId === undefined) return false;
          return brokeredHttpGrants.check({
            projectId,
            sessionId,
            bindingId,
            channel,
            ...target,
          });
        },
      }),
      ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
      // OpenCode backend (#143) for provider-qualified models, over ACP like every
      // other agent since ADR 0012 Amendment 4. The conductor routes by model; not
      // enabled → Claude-only.
      ...(config.openCodeEnabled === true ? { openCodeBackend: new AcpOpenCodeBackend() } : {}),
      // Codex runs exclusively over ACP. ADR 0014 supplies its brokered tools through
      // the approval-gated per-turn MCP gateway.
      ...(config.codexEnabled === true
        ? {
            codexBackend: new AcpCodexBackend(),
          }
        : {}),
      sessionBackend: async (session, selected, preparation) => {
        const isClaudeSession = usesClaudeBackend(session.model);
        const isCodexSession = isCodexModel(session.model);
        // Every branch below assumes a Claude turn is an ACP turn: none of them
        // fetches an access token, and no agent process is handed
        // `CLAUDE_CODE_OAUTH_TOKEN` except the non-secret egress placeholder. The
        // refusal that makes that assumption safe is a tested pure decision.
        const transportRefusal = claudeTransportRefusal({
          isClaudeSession,
          runnerSupervisorBackend: selected.runnerSupervisorBackend,
        });
        if (transportRefusal !== undefined) throw new Error(transportRefusal);
        const supervisorProjectId =
          session.projectId ??
          (config.controlPlaneRunner === true &&
          isRunnerSupervisorBackend(selected.runnerSupervisorBackend)
            ? CONTROL_PLANE_RUNNER_PROJECT_ID
            : undefined);
        const supervisorAvailable =
          supervisorProjectId !== undefined &&
          config.dataVolumeRoot !== undefined &&
          existsSync(
            join(config.dataVolumeRoot, 'runners', supervisorProjectId, 'supervisor.sock'),
          );
        // Keep Claude ACP selected even when the pre-preparation socket snapshot is
        // absent: serializeProjectTurnPreparation below may recreate the Sandbox and
        // restore its supervisor. The runner performs the authoritative reachability
        // check after that repair and fails Claude ACP closed instead of falling back.
        // Project-less control-plane sessions resolve the fixed dedicated runtime
        // above. Codex uses the same dedicated-runner fail-closed boundary.
        const sessionSelected = selected;
        if (session.projectId === null) {
          if (isCodexSession) {
            if (config.controlPlaneRunner !== true || !supervisorAvailable) {
              throw new Error(
                'Codex control-plane turns require the dedicated control-plane runner.',
              );
            }
            await refreshControlPlaneRunnerIdentity?.();
            await awaitControlPlaneRunnerIdentity?.();
            await synchronizeAgentGatewayForTurn();
            return sessionSelected;
          }
          if (isClaudeSession) {
            if (config.controlPlaneRunner !== true || !supervisorAvailable) {
              throw new Error(
                'Claude ACP control-plane turns require the dedicated control-plane runner.',
              );
            }
            await refreshControlPlaneRunnerIdentity?.();
            await awaitControlPlaneRunnerIdentity?.();
            await synchronizeAgentGatewayForTurn();
            return sessionSelected;
          }
          // Whatever is left is a loopback backend with no Verity-held provider
          // credential of its own (OpenCode/Pi), so it inherits the control-plane
          // agent environment and nothing else.
          return withControlPlaneAgentCredentials(sessionSelected, async (inherited) =>
            materializeControlPlaneAgentEnv(secretRoot, inherited),
          );
        }
        const store = new EventStore(db, secretCipher);
        const project = await store.getProject(session.projectId);
        if (project === undefined) {
          if (isClaudeSession) {
            throw new Error('Claude ACP cannot verify its project isolation boundary.');
          }
          return undefined;
        }
        if (project.kind === 'control_plane') {
          if (isCodexSession) {
            const controlPlaneSupervisorAvailable =
              config.controlPlaneRunner === true &&
              config.dataVolumeRoot !== undefined &&
              existsSync(
                join(
                  config.dataVolumeRoot,
                  'runners',
                  CONTROL_PLANE_RUNNER_PROJECT_ID,
                  'supervisor.sock',
                ),
              );
            if (!controlPlaneSupervisorAvailable) {
              throw new Error(
                'Codex control-plane turns require the dedicated control-plane runner.',
              );
            }
            await refreshControlPlaneRunnerIdentity?.();
            await awaitControlPlaneRunnerIdentity?.();
            await synchronizeAgentGatewayForTurn();
            return sessionSelected;
          }
          if (isClaudeSession) {
            const controlPlaneSupervisorAvailable =
              config.controlPlaneRunner === true &&
              config.dataVolumeRoot !== undefined &&
              existsSync(
                join(
                  config.dataVolumeRoot,
                  'runners',
                  CONTROL_PLANE_RUNNER_PROJECT_ID,
                  'supervisor.sock',
                ),
              );
            if (!controlPlaneSupervisorAvailable) {
              throw new Error(
                'Claude ACP control-plane turns require the dedicated control-plane runner.',
              );
            }
            await refreshControlPlaneRunnerIdentity?.();
            await awaitControlPlaneRunnerIdentity?.();
            await synchronizeAgentGatewayForTurn();
            return sessionSelected;
          }
          return withControlPlaneAgentCredentials(sessionSelected, async (inherited) =>
            materializeControlPlaneAgentEnv(secretRoot, inherited),
          );
        }
        const supervisorRefusal = acpSupervisorWiringRefusal({
          runnerSupervisorBackend: selected.runnerSupervisorBackend,
          runnerSupervisor: config.runnerSupervisor === true,
          dataVolumeRootAvailable: config.dataVolumeRoot !== undefined,
          dockerAvailable: config.dockerBaseUrl !== undefined,
          cloneRootAvailable: config.hostCloneRoot !== undefined,
        });
        if (supervisorRefusal !== undefined) throw new Error(supervisorRefusal);
        // Refused BEFORE `serializeProjectTurnPreparation`, so a pure configuration
        // error leaves no half-prepared turn behind. Both operands are assigned once
        // during start-up (`claudeEgressIdentity` above; nothing in a turn creates the
        // service), so the answer cannot change inside the preparation below.
        //
        // Two operands, not three: the routed env also needs the gateway itself, but a
        // deployment that can serve project turns at all already refuses to START
        // without it ('Project Docker provisioning requires the Agent Gateway'), so
        // `routed` can never point an agent at a connector that was never provisioned.
        const claudeEgressActive =
          claudeEgressIdentity !== undefined && config.claudeConnectorPort !== undefined;
        const egressRefusal = claudeProjectEgressRefusal({
          isClaudeSession,
          egressActive: claudeEgressActive,
        });
        if (egressRefusal !== undefined) throw new Error(egressRefusal);
        if (config.dockerBaseUrl === undefined || config.hostCloneRoot === undefined) {
          return undefined;
        }
        const dockerBaseUrl = config.dockerBaseUrl;
        const hostCloneRoot = config.hostCloneRoot;
        return serializeProjectTurnPreparation(
          project.id,
          preparation.sessionId,
          preparation.canWait,
          async (queuedSessionIds) => {
            await refreshProjectToken?.(project);
            const settings = isProjectSettingsReader(store)
              ? await store.getProjectSettings(project.id)
              : undefined;
            // A sandbox is single-homed on its own project network and reaches Claude
            // only through its generation-matched relay, so the target stamped on it
            // is that relay (`provisioner.ts`: claudeGatewayUrl(relayActivation)) —
            // never the gateway origin. Comparing the stamp against the gateway URL
            // therefore never matched and failed every Claude turn closed; the relay,
            // not the sandbox, is what forwards to the gateway.
            if (
              (isClaudeSession || isCodexSession) &&
              claudeEgressActive &&
              agentGatewayUrl !== undefined
            ) {
              if (docker === undefined) {
                throw new Error('Claude egress routing target cannot be verified');
              }
              let relayProvisioned: boolean;
              try {
                const inspected = await docker.inspectContainer(project.containerName);
                relayProvisioned = await healthyRelayGeneration(project.id, inspected);
              } catch (error) {
                app.log.warn(
                  { err: error, projectId: project.id },
                  'Could not verify agent gateway relay provisioning',
                );
                throw new Error('Claude egress routing target cannot be verified', {
                  cause: error,
                });
              }
              if (!relayProvisioned) {
                // The Sandbox cannot serve this turn — but that is a repairable state,
                // not a reason to end the turn. Failing here surfaced as a red
                // `run_failed` the operator had to resolve by hand, and the periodic
                // reconciler could not resolve it either: it defers around in-flight
                // turns, and the turn waiting on the repair is what keeps the project
                // busy. So rebuild now, tell the operator it is happening, and continue
                // the turn on the fresh Sandbox once it is up. Background resolutions
                // (auto-title, reattach) don't wait — they keep failing fast.
                relayProvisioned = await repairSandboxForClaudeTurn(
                  project,
                  preparation,
                  queuedSessionIds,
                );
              }
              if (!relayProvisioned) {
                throw new Error(
                  'Sandbox predates the agent gateway relay and could not be recreated automatically — repair the project, then send the message again',
                );
              }
              // Binding issuance and revocation keep the routed set current: read the
              // latest rotating credential and wait for the gateway to acknowledge
              // that exact cached identity configuration.
              await synchronizeAgentGatewayForTurn();
            }
            // A Claude project agent is pointed at the sandbox connector with only the
            // placeholder, so the real token never enters the untrusted sandbox.
            // Non-Claude sessions never route.
            const egressRouted = claudeEgressRouteEnabled({
              isClaudeSession,
              egressActive: claudeEgressActive,
            });
            return new DockerExecBackend({
              containerName: project.containerName,
              hostProjectRoot: projectClonePath(hostCloneRoot, project),
              dockerBaseUrl,
              backend: sessionSelected,
              containerEnv: {
                ...projectSettingsEnv(settings),
                ...claudeEgressAgentEnv({
                  routed: egressRouted,
                  connectorPort: config.claudeConnectorPort,
                }),
              },
            });
          },
        );
      },
    },
  });
  const argoWorkflowGate =
    config.workflowArgoCdBaseUrl !== undefined && config.workflowArgoCdToken !== undefined
      ? createArgoCdWorkflowGate({
          baseUrl: config.workflowArgoCdBaseUrl,
          token: () => Promise.resolve(config.workflowArgoCdToken),
        })
      : undefined;
  const workflowReconciler = createWorkflowGateReconciler({
    store: workflowStore,
    adapters: {
      github: createGitHubWorkflowGate({
        token: (owner, repo) => cachedProjectTokenMint({ owner, repo }),
      }),
      ...(config.workflowOciVerifier !== undefined
        ? { oci: createOciProvenanceWorkflowGate({ verify: config.workflowOciVerifier }) }
        : {}),
      ...(argoWorkflowGate !== undefined ? { argoCd: argoWorkflowGate } : {}),
      ...(config.workflowApplicationHealthVerifier !== undefined
        ? {
            applicationHealth: createApplicationHealthWorkflowGate({
              verify: config.workflowApplicationHealthVerifier,
            }),
          }
        : {}),
    },
  });
  let workflowReconciling = false;
  const reconcileWorkflows = async (): Promise<void> => {
    if (workflowReconciling) return;
    workflowReconciling = true;
    try {
      await workflowReconciler.reconcile();
    } catch (error) {
      app.log.warn({ err: error }, 'cross-project workflow reconciliation failed');
    } finally {
      workflowReconciling = false;
    }
  };
  void reconcileWorkflows();
  const workflowReconcileTimer = setInterval(() => void reconcileWorkflows(), 30_000);
  workflowReconcileTimer.unref?.();
  app.addHook('onClose', () => clearInterval(workflowReconcileTimer));
  // One-time reconciliation of backend transcripts left by sessions that no longer
  // exist (see `session-artifact-sweep.ts`). Deleting a session now takes its
  // transcripts with it, but everything deleted BEFORE that fix left its files behind
  // and no future delete can reach them — those sessions are gone from the store. It is
  // also the backstop for the one case the delete path cannot cover: a backend switch
  // leaves claude's `subagents/` tree in place (it is the only copy while the session
  // lives), so the tree of a displaced binding is collected once the session it belongs
  // to is deleted and its worktree stops being live.
  //
  // Not awaited into the boot: a start must not wait on a directory walk, and nothing
  // downstream depends on the outcome. What IS handed back on the server object is the
  // store-read phase alone ({@link EmbeddedServer.transcriptSweep}), so a caller that
  // closes immediately — a test, a one-shot CLI run — settles those two queries before
  // `destroy()` without also waiting out the walk behind them. Blocking a SIGTERM on a
  // full walk of a large volume is how a graceful shutdown becomes a SIGKILL, and the
  // walk touches nothing that shutdown tears down. Not on a timer either: the ongoing
  // case is handled at the delete itself, so once per start is enough.
  const sweepMode = config.transcriptSweep ?? 'on';
  let transcriptSweep: Promise<void> | undefined;
  let transcriptSweepWalk: Promise<SweepResult | undefined> | undefined;
  // Aborted by `close()`, which then waits for the walk to notice. Without it a caller
  // that closes the server and tears its data root down is racing a delete loop over that
  // same root — `main.ts` never sees it because it exits immediately after, but this is a
  // public entry point and not every caller does.
  const sweepAbort = new AbortController();
  /**
   * Started only once the rest of the build has succeeded — see the call site.
   *
   * Nothing here depends on where it is defined; what matters is that the walk is not
   * running while `buildEmbeddedServer` can still throw. A rejected build hands the caller
   * no server, so nobody holds {@link sweepAbort} or the walk promise, and a delete loop
   * over `runners/` would carry on under a boot that failed.
   */
  const startTranscriptSweep = (): void => {
    if (dataVolumeRoot === undefined || sweepMode === 'off') return;
    const runnersRoot = join(dataVolumeRoot, 'runners');
    const dryRun = sweepMode === 'dry';
    let storeReadsDone!: () => void;
    const storeReads = new Promise<void>((resolve) => {
      storeReadsDone = resolve;
    });
    transcriptSweep = storeReads;
    transcriptSweepWalk = (async () => {
      let liveIds: string[];
      let worktrees: string[];
      try {
        [liveIds, worktrees] = await Promise.all([
          eventStore.listLiveBackendSessionIds(),
          eventStore.listSessionWorktrees(),
        ]);
      } finally {
        storeReadsDone();
      }
      const result = await sweepOrphanArtifacts({
        runnersRoot,
        liveIds: new Set(liveIds),
        // The claude directory name of every session that still exists. `encodeCwd` is
        // claude's own naming rule, applied to the cwd as the SANDBOX saw it — the same
        // derivation the delete path uses, so the two agree on which directory belongs
        // to which session.
        liveCwdDirs: new Set(worktrees.map((worktree) => encodeCwd(sessionSandboxCwd(worktree)))),
        dryRun,
        signal: sweepAbort.signal,
      });
      // Logged unconditionally, at info: this deletes conversations, so what it did on
      // a given boot has to be answerable afterwards — including "nothing".
      const summary = {
        dryRun,
        scanned: result.scanned,
        // Under `dry` nothing was deleted, so the count goes out under a name that
        // says so: a dashboard summing `removed` must not be fed files that are still
        // there by a run whose whole point was not to touch them.
        ...(dryRun ? { wouldRemove: result.removed } : { removed: result.removed }),
        megabytes: Number((result.bytes / 1024 / 1024).toFixed(1)),
        liveKept: result.liveKept,
        graceKept: result.graceKept,
        liveCwdSkipped: result.liveCwdSkipped,
        claudeCwdDirsSeen: result.claudeCwdDirsSeen,
        failed: result.failed,
      };
      if (result.aborted) {
        // Shutdown reached the walk before the walk was done. Its own line rather than the
        // ordinary one, because every count in the summary is a partial and the ordinary
        // line is what someone reads to answer "what did this boot delete".
        app.log.info(
          { ...summary, aborted: true },
          'verity: orphaned backend transcript sweep stopped by shutdown',
        );
        return result;
      }
      if (result.storeReportedNoSession) {
        // The bluntest of the two refusals, and the one that catches a server pointed at
        // the wrong control-plane database: the store named no session at all, the volume
        // was full of transcripts, and both readings of that — a deployment with no
        // sessions, or a database that is not this volume's — end with nothing deleted.
        // If the store really is this volume's and really is empty, the held files are
        // dead and can be removed from the volume directly; the sweep will not do it on a
        // store it cannot corroborate.
        app.log.error(
          { ...summary, held: result.held },
          'verity: orphaned transcript sweep removed nothing — the store knows of no session at all',
        );
        return result;
      }
      if (result.claudeGuardUnproven !== undefined) {
        // Either way the sweep collected no claude file this boot, and either way the count
        // it did NOT take goes out with it. The level splits on how much the sweep actually
        // knows. A contradiction means one live backend id appeared under multiple cwd
        // directories, so no legacy mapping is unique; this line is then the only warning
        // before a session's unreproducible `subagents/` tree would have gone. The weaker check only
        // says nothing matched, which a deployment whose live sessions have never run claude
        // sits in legitimately and indefinitely — an error line that never clears teaches
        // people to ignore error lines.
        const level = result.claudeGuardUnproven === 'contradiction' ? 'error' : 'warn';
        app.log[level](
          { ...summary, held: result.held, signal: result.claudeGuardUnproven },
          'verity: orphaned transcript sweep kept every claude file — live-worktree guard unproven',
        );
        return result;
      }
      app.log.info(
        summary,
        dryRun
          ? 'verity: orphaned backend transcript sweep (dry run, nothing removed)'
          : 'verity: orphaned backend transcript sweep',
      );
      return result;
    })().catch((error: unknown) => {
      // Covers the store reads too, which is why `storeReadsDone` resolves from a
      // `finally` — a close waiting on that promise must not hang on a failed query.
      app.log.warn({ err: error }, 'verity: orphaned transcript sweep failed');
      return undefined;
    });
  };

  if (embeddedSecretJobs !== undefined) {
    registerSecretJobRoutes(app, embeddedSecretJobs.service, (header) => {
      const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
      const actorId = authRegistry.resolveId(token);
      if (token === undefined || actorId === undefined) return undefined;
      return {
        actorId,
        authorizationHash: createHash('sha256')
          .update(`verity.secret-job-approval.v1\0${token}`)
          .digest('hex'),
      };
    });
    app.addHook('onClose', () => embeddedSecretJobs.service.close());
  }
  if (secretProviderCatalog !== undefined) {
    const dopplerOptions = config.secretJobs!.doppler!;
    registerSecretProviderRoutes(
      app,
      secretProviderCatalog,
      createDopplerSecretNameLister({
        ...dopplerOptions,
        readCredential: readBrokerDopplerCredential,
      }),
      async (header, projectId) => {
        const token = /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
        const actorId = token === undefined ? undefined : authRegistry.resolveId(token);
        if (
          actorId === undefined ||
          !(await config.secretJobs!.authorizeProviderAdministration!(actorId, projectId))
        ) {
          return undefined;
        }
        return actorId;
      },
    );
  }
  // Adopt the handed-off key (ADR 0008 D8) only now that everything is built.
  // Every component above was therefore constructed against a sealed store, the
  // way it is on an interactive boot, and the key goes in through the same door
  // an operator unlock uses — the very callback `onSecretUnlocked` runs.
  if (handedOffKeyMaterial !== undefined) {
    await adoptHandedOffSecretKey({
      cipher: secretCipher,
      material: handedOffKeyMaterial,
      activate: async () => {
        await finishLegacyDopplerCutover();
        await projectAgentGatewayIdentity();
        // The candidate constructed every component against a sealed store, so the
        // Runner identity publish was deferred exactly as on an interactive boot.
        // This callback IS the update path's unlock — carry it out here too, or the
        // promoted Server runs without Runner identity until some later turn
        // happens to refresh it. Best-effort for the same reason the boot path is:
        // a certificate must never cost the key handover it rides in on.
        await publishRunnerIdentity('key handover');
        await codexModelCatalog?.refresh();
      },
    });
  }
  app.addHook('onClose', () => claudeCredentialSync.close());
  let preserveProjectRelaysOnClose = false;
  app.addHook('onClose', () =>
    preserveProjectRelaysOnClose
      ? (projectRelayLifecycle?.suspend() ?? Promise.resolve())
      : (projectRelayLifecycle?.close() ?? Promise.resolve()),
  );
  if (previewShareManager !== undefined) {
    app.addHook('onClose', async () => {
      await uplinkControl?.stop();
    });
    let reconciling = false;
    const reconcile = async (): Promise<void> => {
      if (reconciling) return;
      reconciling = true;
      try {
        await previewShareManager.reconcile();
      } catch (error) {
        app.log.warn({ err: error }, 'public preview reconciliation failed');
      } finally {
        reconciling = false;
      }
    };
    void reconcile();
    const previewTimer = setInterval(() => void reconcile(), 30_000);
    previewTimer.unref?.();
    app.addHook('onClose', () => clearInterval(previewTimer));
  } else if (projectDocker !== undefined) {
    // No edge control means no manager and therefore no reconciliation loop, so
    // shares an earlier version created would run on untouched. Close them out
    // instead of leaving live connectors and unrevocable records behind. This
    // retries on the reconcile cadence rather than only at boot — a Docker or
    // store hiccup during startup must not strand a share for the process
    // lifetime — and stops the timer once a sweep completes cleanly, because
    // without a manager nothing can create new shares to find.
    let sweeping = false;
    const sweep = async (): Promise<void> => {
      if (sweeping) return;
      sweeping = true;
      try {
        const swept = await sweepOrphanedPreviewShares({
          store: eventStore,
          docker: projectDocker,
        });
        if (swept > 0) {
          app.log.warn({ swept }, 'revoked orphaned public preview shares');
        }
        clearInterval(sweepTimer);
      } catch (error) {
        app.log.warn({ err: error }, 'orphaned public preview sweep failed, retrying');
      } finally {
        sweeping = false;
      }
    };
    const sweepTimer = setInterval(() => void sweep(), 30_000);
    sweepTimer.unref?.();
    app.addHook('onClose', () => clearInterval(sweepTimer));
    void sweep();
  }

  // Host-disk GC (docker-gc.ts). Wired off `projectDocker` because that is the
  // client that CREATES the resources it collects — the devcontainer image cache
  // in `resolveOrBuildImage` and the sandbox containers whose anonymous volumes
  // can outlive them. Without this the runner's two append-only caches grow until
  // the disk is full; `docker system prune` does not reach either (the image tags
  // are tagged, not dangling, and prune skips volumes entirely).
  if (projectDocker !== undefined && config.dockerGc !== false) {
    const dockerGc = startDockerGcScheduler({
      docker: projectDocker,
      log: app.log,
      ...(config.dockerGcPolicy !== undefined ? { policy: config.dockerGcPolicy } : {}),
      // Free space is measured on the volume that actually fills up — the Verity
      // data root shares the host filesystem with /var/lib/docker in the reference
      // install, so this is the number that matters for disk-pressure escalation.
      ...(config.dataVolumeRoot !== undefined ? { dataRoot: config.dataVolumeRoot } : {}),
      // Read through the `let` on every pass, not captured once: the lifecycle is
      // constructed below this block, and its held set changes with every
      // provision. This is what keeps the sweep off a relay whose sandbox has not
      // been created yet — neither the listing nor elapsed time can see that.
      heldRelays: () => projectRelayLifecycle?.heldRelays() ?? [],
    });
    app.addHook('onClose', () => {
      dockerGc.stop();
    });
  }
  if (codexModelCatalog !== undefined) {
    app.addHook('onClose', () => codexModelCatalog.close());
  }

  if (projectRelayEnabled) {
    if (
      docker === undefined ||
      config.dataVolumeRoot === undefined ||
      config.dataVolume === undefined
    )
      throw new Error('project relay Docker runtime is unavailable');
    const relayGid = config.projectRelayGid ?? 65_532;
    if (!(process.getgroups?.() ?? []).includes(relayGid) && process.getgid?.() !== relayGid) {
      throw new Error(`project relay requires server membership in group ${String(relayGid)}`);
    }
    const brokerSocketRoot = join(config.dataVolumeRoot, 'relay', 'broker');
    const claudeSocketRoot = join(config.dataVolumeRoot, 'relay', 'claude');
    const codexSocketRoot = join(config.dataVolumeRoot, 'relay', 'codex');
    mkdirSync(brokerSocketRoot, { recursive: true, mode: 0o700 });
    mkdirSync(claudeSocketRoot, { recursive: true, mode: 0o700 });
    mkdirSync(codexSocketRoot, { recursive: true, mode: 0o700 });
    projectRelayLifecycle = createProjectRelayRuntime({
      app,
      docker,
      signingCapabilities,
      githubCapabilities: ghTokenCapabilities,
      image: config.projectRelayImage!,
      dataVolume: config.dataVolume,
      dataVolumeRoot: config.dataVolumeRoot,
      brokerSocketRoot,
      claudeSocketRoot,
      codexSocketRoot,
      socketOwnerUid: process.getuid?.() ?? 1000,
      relayGid,
      projectNetwork: projectNetworkName,
    });
  }

  if (
    provisioner !== undefined &&
    (config.runnerSupervisor === true || claudeEgressIdentity !== undefined)
  ) {
    const reconcileRunnerSupervisors = async (): Promise<void> => {
      await provisioner.reconcileRunnerSupervisors(
        await eventStore.listProjects({ includeHidden: true }),
      );
    };
    const reportReconcileError = (error: unknown): void => {
      app.log.warn({ err: error }, 'Runner supervisor reconciliation failed');
    };
    await reconcileRunnerSupervisors().catch(reportReconcileError);
    stopRunnerSupervisorReconciler = startRunnerSupervisorReconciler(
      reconcileRunnerSupervisors,
      config.runnerSupervisorReconcileIntervalMs,
      reportReconcileError,
    );
  }

  // Last thing before the server object exists, because from here on the only way out is
  // the `return` below: everything that could still have thrown has run, so the caller is
  // guaranteed to receive the handle that can stop this walk.
  startTranscriptSweep();

  // Latch so a double SIGINT/SIGTERM (or any repeat call) coalesces onto one
  // teardown instead of double-closing the app/db.
  let closing: Promise<void> | undefined;
  return {
    app,
    ...(embeddedSecretJobs !== undefined ? { secretJobs: embeddedSecretJobs } : {}),
    ...(transcriptSweep !== undefined ? { transcriptSweep } : {}),
    ...(transcriptSweepWalk !== undefined ? { transcriptSweepWalk } : {}),
    secretKeyHandoff: {
      exportKeyMaterial: () => secretCipher.exportKeyMaterial(),
    },
    close: (options = {}) =>
      (closing ??= (async () => {
        // Latched by the first close call, matching the coalesced teardown below.
        // Only standby quiescence is a handoff; SIGTERM and administrative stops
        // retain destructive relay/capability cleanup.
        preserveProjectRelaysOnClose = options.preserveProjectRelays === true;
        await stopAgentGatewayCredentialProjection();
        await stopRunnerSupervisorReconciler();
        await agentGatewaySynchronizer?.close();
        await app.close();
        // The sweep, settled before the database goes: a short-lived process (a test, a
        // one-shot run) can otherwise reach `destroy()` with its two store reads still in
        // flight — and, worse, hand control back to a caller that tears down the data root
        // while the walk is still calling `rm` inside it.
        //
        // So the walk is told to stop rather than left to run: it checks between directory
        // entries and between deletes, and returns a partial result the next boot's sweep
        // completes. Waiting for it then costs one in-flight `fs` call, not a full volume
        // walk — blocking a SIGTERM on THAT is how a graceful shutdown becomes a SIGKILL.
        //
        // Bounded even so, and the bound is what makes this a strong guarantee only in the
        // normal case: if the timer wins, `close` resolves with the walk still somewhere
        // inside a call that never came back, so a caller that then removes the data root
        // is back to racing it. That is the wedged-volume case, where every other option —
        // waiting forever, and the SIGKILL that follows — is worse. The store reads are
        // full-table scans issued at boot and get the same treatment: giving up and
        // destroying under them costs at worst one logged query error on a process that is
        // exiting anyway. `ref: false` so the losing timer cannot itself hold the process
        // open for the rest of the window.
        sweepAbort.abort();
        await Promise.race([
          Promise.all([transcriptSweep, transcriptSweepWalk]),
          delay(SWEEP_SHUTDOWN_WAIT_MS, undefined, { ref: false }),
        ]);
        await db.destroy();
      })()),
  };
}

/**
 * Refresh the `projects` cache against the live GitHub-App-installation list
 * (concept §19, #174). Each repo from {@link GitHubInstallationService.listInstallationRepos}
 * is upserted with `state='absent'` — the provisioning-worker-owned `state`
 * (cloning/container_starting/active/failed) survives the upsert because
 * `EventStore.upsertProject`'s ON CONFLICT branch keeps it. New repos land as
 * `absent`; the mobile picker discovers them on the next `GET /projects`. The
 * GitHub archive flag is refreshed on every sync so pickers can suppress
 * archived repositories.
 *
 * `eventStore` is a per-call instance (the route handler creates one — cheap,
 * just holds a kysely handle; the shared `db` is the real durable resource). If
 * the installation service degrades to `[]` (token absent / GitHub unreachable)
 * the function STILL returns the persisted cache so the picker stays usable
 * offline — re-sync will land on the next `GET` once GitHub is reachable.
 *
 * `image_ref` is intentionally NOT set by the sync — its value comes from Verity's
 * default-project-image config (or a per-repo override, slice 3 only); the upsert
 * lets NULL survive a refresh for installations-registered rows that the operator
 * hasn't explicitly pinned yet.
 *
 * IDs: a fresh `randomUUID()` is minted per call, BUT only the FIRST insert for a
 * given `(owner, repo)` consumes it — the ON CONFLICT branch's `doUpdateSet` skips
 * the `id` column, so a row's identity is established at first insert and stable
 * across re-syncs. A `session.project_id` FK bound to a project id therefore
 * survives list refreshes (the project row identity never flips).
 */
export async function syncProjectsFromInstallation(
  eventStore: EventStore,
  installation: GitHubInstallationService,
  opts?: { includeHidden?: boolean },
): Promise<ProjectRecord[]> {
  // Live repos first; if GitHub is unreachable we keep `[]` so the per-repo
  // upsert loop is a no-op — the persisted cache below still surfaces the rows
  // we already have.
  const live = await installation
    .listInstallationRepos()
    .catch(() => [] as { owner: string; repo: string; archived?: boolean }[]);

  // The container_name is the canonical hyphen-slug form derived from the
  // (owner, repo) — `upsertProject` lowercases again on its side, this is just
  // pre-derivation so the input matches what will be persisted.
  const { randomUUID } = await import('node:crypto');
  for (const r of live) {
    const containerName = containerNameFor({
      owner: r.owner.toLowerCase(),
      repo: r.repo.toLowerCase(),
    });
    try {
      await eventStore.upsertProject({
        id: randomUUID(),
        owner: r.owner,
        repo: r.repo,
        containerName,
        state: 'absent',
        archived: r.archived ?? false,
      });
    } catch (error) {
      // A link that has reserved this identity holds the claim while its push
      // runs, with no `projects` row to update yet — so the upsert reports the
      // pair as spoken for. That is a repo mid-adoption, not a broken sync:
      // skip it and let the next pass see the finished project. Without this,
      // one in-flight link would throw straight out of `GET /projects` and take
      // the entire project list down with it.
      if (!(error instanceof ProjectIdentityClaimConflict)) throw error;
    }
  }

  return eventStore.listProjects({ includeHidden: opts?.includeHidden === true });
}

export function createProjectAwareGitHubTokenSource(
  repoDir: string,
  fallback: GitHubTokenSource,
): () => string | undefined {
  return () => readProjectGitHubToken(repoDir) ?? resolveGitHubToken(fallback);
}

function resolveGitHubToken(source: GitHubTokenSource): string | undefined {
  const token = typeof source === 'function' ? source() : source;
  const trimmed = token?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function readProjectGitHubToken(repoDir: string): string | undefined {
  const marker = `${sep}.verity-sessions${sep}`;
  const markerIndex = repoDir.indexOf(marker);
  const projectRoot = markerIndex >= 0 ? repoDir.slice(0, markerIndex) : repoDir;
  try {
    const token = readFileSync(join(projectRoot, '.gh-token'), 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Read the bundled `verity-sandbox-toolkit` Feature metadata from the Server image
 *  (R3.1/#299). The directory defaults to `/opt/verity-features/verity-sandbox-toolkit`
 *  (the Dockerfile bind path) and is overridable via `VERITY_FEATURE_DIR` for
 *  tests/alternate layouts. Parses the Feature's `devcontainer-feature.json` for
 *  its `version`, hashes the Feature directory contents, and returns
 *  `{ ref: <dir>, version, identity }`.
 *
 *  Fail-soft: the file is absent on dev/test/non-Server hosts, so a missing
 *  file, unreadable file, malformed JSON, or a missing/blank `version` all
 *  resolve to `undefined` (+ a warn log) rather than throwing while reading.
 *  When project Docker provisioning is active, repos without `.devcontainer/`
 *  still run on the base sandbox image; repos with `.devcontainer/` fail closed
 *  before build if this Feature is unavailable. */
export function readBundledDevcontainerFeature():
  { ref: string; version: string; identity: string } | undefined {
  const dir = process.env.VERITY_FEATURE_DIR ?? '/opt/verity-features/verity-sandbox-toolkit';
  const manifestPath = join(dir, 'devcontainer-feature.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT/ENOTDIR is the expected dev/test/non-Server case — stay quiet there;
    // only warn on unexpected read errors (e.g. permissions).
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.warn(
        `verity: could not read bundled devcontainer feature at ${manifestPath}: ${String(error)}`,
      );
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    if (version.length === 0) {
      console.warn(
        `verity: bundled devcontainer feature at ${manifestPath} has no usable "version" — ignoring.`,
      );
      return undefined;
    }
    return { ref: dir, version, identity: bundledFeatureIdentity(dir) };
  } catch (error) {
    console.warn(
      `verity: bundled devcontainer feature at ${manifestPath} is not valid JSON: ${String(error)}`,
    );
    return undefined;
  }
}

function bundledFeatureIdentity(dir: string): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  };
  walk(dir);
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join('/');
    const content = readFileSync(file);
    hash.update(`path:${rel.length}:`);
    hash.update(rel);
    hash.update('\n');
    hash.update(`file:${content.length}:`);
    hash.update(content);
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * "Refresh" a project's GitHub token. With the on-demand token broker there is no
 * per-project token FILE to rewrite — the sandbox mints a fresh repo-scoped token
 * on every git/gh call via its capability. This just re-mints server-side (warming
 * any mint cache and surfacing an App-not-configured failure to the caller); it
 * never writes into the clone dir, so no token lands in the sandbox's /work.
 */
export async function refreshProjectGitHubToken(
  project: ProjectRecord,
  mint: GitHubProjectTokenMint,
): Promise<void> {
  await mint(project);
}

/**
 * Build the `deps.projectWorktrees` factory (§19.3 seam) that gives each
 * per-project session worktree a `refreshBase` fetch authenticated with the
 * PROJECT-scoped GitHub token — the same short-TTL App installation token
 * (`repositories:[project.repo]`) the {@link GitHubProjectTokenMint} issues for
 * {@link refreshProjectGitHubToken}. Single source of truth: the header is built
 * from `gitAuthHeader` (the exact form `provisioner.ts` uses for its clone/fetch),
 * so the session-worktree path and the clone path authenticate identically.
 *
 * The token is minted FRESH inside `fetchAuthHeader` (resolved per fetch) so a
 * rotated ~1h-TTL token is always current. When the mint yields no token (App
 * creds unavailable) the fetch runs tokenless — same fallback as elsewhere.
 *
 * Without this, `createGitWorktreeProvisioner`'s fetch of a private project repo
 * outside the container's global git-credential scope falls through to that
 * narrow global token and fails with `remote: Repository not found`.
 */

export function createProjectWorktreeFactory(mint: GitHubProjectTokenMint): (
  project: ProjectRecord,
  projectClone: string,
  // `git` is an optional injection seam (tests); production omits it and the
  // real `git` runs. `baseBranch`/`refreshBase` are the fields the server's
  // `worktreeOpts` supplies at the `deps.projectWorktrees(...)` call site.
  worktreeOpts?: Pick<GitWorktreeOptions, 'baseBranch' | 'refreshBase' | 'git'>,
) => WorktreeProvisioner {
  return (project, projectClone, worktreeOpts) =>
    createGitWorktreeProvisioner({
      ...worktreeOpts,
      repoDir: projectClone,
      worktreeRoot: join(projectClone, '.verity-sessions'),
      fetchAuthHeader: async () => {
        // On-demand mint only — no project-clone `.gh-token` file exists anymore
        // (it would sit in the sandbox's /work; the sandbox uses the token broker).
        const token = await mint(project);
        return token ? gitAuthHeader(token) : undefined;
      },
    });
}
