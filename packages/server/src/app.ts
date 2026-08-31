import { Conductor, type Backend, type ConductorDeps, type EventBus } from '@verity/session';
import type {
  VeritySettingsPatch,
  EventStore,
  SealableSecretCipher,
  WorkflowStore,
} from '@verity/store';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import {
  VERITY_CONTROL_PROJECT_ID,
  VERITY_CONTROL_SESSION_NAME,
  LEGACY_VERITY_CONTROL_SESSION_NAME,
  VERITY_CONTROL_SYSTEM_PROMPT,
  buildServer,
  type MeetingTranscriber,
  type ServerDeps,
  type ServerUpdateController,
} from './server.js';
import type { AuthTokenRegistry } from './auth.js';
import type { BrokeredGrantRecord } from './brokered-http-grants.js';
import type { WorktreeProvisioner } from './worktree.js';
import type { GitBranchService, GitOutput } from './branches.js';
import type { GitHubIdentity, IssueSummary, PullRequestStatus, ReleaseSummary } from './github.js';
import type { GitHubTaskService } from './github-tasks.js';
import type {
  GitHubAppCreds,
  GitHubAppIdentityResult,
  GitHubAppValidateResult,
} from './github-app-token.js';
import type {
  DopplerValidateResult,
  DopplerProjectSummary,
  DopplerConfigSummary,
} from './doppler-token.js';
import type { ManifestConvert } from './github-manifest.js';
import type { SshKeygenSpawner } from './signing-key.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';
import type { ProjectRecord } from '@verity/store';
import type { Provisioner, Deprovisioner } from './provisioner.js';
import type { ProjectRuntime } from './project-runtime.js';
import type { ProjectEnvironmentSettings } from './project-settings-env.js';
import type { SandboxUpdateChecker } from './sandbox-updates.js';
import type { ClaudeOAuthTokenProvider } from './claudeUsage.js';
import type { CodexUsageCredentialProvider } from './codexUsage.js';
import type { PushSender } from './push-sender.js';
import type { ReleaseChannelResolver } from './self-update/release-channel.js';

export interface ControlPlaneDeps {
  eventStore: EventStore;
  /** TLS termination options for the public direct-server listener. */
  https?: ServerDeps['https'];
  unlockClientIdentity?: ServerDeps['unlockClientIdentity'];
  /** Installer-issued authority that gates first initialization. */
  devicePairing?: ServerDeps['devicePairing'];
  workflowStore?: WorkflowStore | undefined;
  workflowGithubWebhookSecret?: string | undefined;
  authorizeWorkflowAction?: ServerDeps['authorizeWorkflowAction'];
  /** Remove a session's backend transcript files from the runner runtime as part of
   *  deleting it. Forwarded verbatim to {@link buildServer}; see the same field on
   *  `ServerDeps`. Omit on deployments without the runner supervisor. */
  purgeSessionArtifacts?: ((sessionId: string) => Promise<void>) | undefined;
  /** Verified official release channel. Omit for deployments not managed by Verity. */
  serverUpdateResolver?: ReleaseChannelResolver | undefined;
  /** Control boundary to the managed Updater. Omit to leave `/server/updates` read-only. */
  serverUpdateController?: ServerUpdateController | undefined;
  /** Where the release notifier remembers what it last announced. Omit to leave the
   *  update notification off; see the same field on `ServerDeps`. */
  serverUpdateNotifierStatePath?: string | undefined;
  /** Fan-out bus shared by the live WS stream and the conductor (M3-2). */
  bus: EventBus;
  /** Google Drive OAuth iOS client id (ADR 0009), from `GOOGLE_AUTH_ID`. Forwarded
   *  to {@link buildServer}; non-secret, surfaced to the app via `/settings`. */
  googleDriveClientId?: string | undefined;
  /** The sealable at-rest secret cipher — powers `/secret/status|init|unlock`.
   *  Omit → those routes report/act as an always-unlocked no-op deployment. */
  secretCipher?: SealableSecretCipher | undefined;
  /** Serializes a Claude/Codex credential DB write with runtime-file propagation. */
  persistAgentCredentials?:
    ((patch: VeritySettingsPatch, persist: () => Promise<void>) => Promise<void>) | undefined;
  /** Serialized Claude OAuth access-token provider shared across all sessions. */
  claudeOAuthTokenProvider?: ClaudeOAuthTokenProvider | undefined;
  /** Reads the gateway-held Codex access token for the account-global usage probe. */
  codexGatewayCredentialProvider?: CodexUsageCredentialProvider | undefined;
  /** Activates encrypted runtime services after the store is initialized/unlocked. */
  onSecretUnlocked?: (() => Promise<void>) | undefined;
  /** Per-device API auth-token registry (audit C1). Omit → the control plane is
   *  unauthenticated (test/local default); when present and enabled, every route
   *  outside the pre-auth allowlist requires a Bearer token. */
  authRegistry?: AuthTokenRegistry | undefined;
  /** Enable the ADR 0008 Expo push-token registration surface. */
  pushEnabled?: boolean | undefined;
  /** Standing brokered-secret grants for a project (ADR 0011 D2). */
  listBrokeredGrants?: ((projectId: string) => Promise<BrokeredGrantRecord[]>) | undefined;
  /** Ends one standing grant — the only exit a `forever` grant has. */
  revokeBrokeredGrant?: ((projectId: string, grantId: string) => Promise<boolean>) | undefined;
  /** Re-attest Docker/runsc for `/healthz` when the Secret Job runtime is required. */
  secretJobRuntimeReadiness?: (() => Promise<void>) | undefined;
  /** Sender/receipt-worker factory; receives the server logger after Fastify exists. */
  pushSender?: PushSender | ((logger: FastifyBaseLogger) => PushSender) | undefined;
  /** Origin allowlist for the WebSocket upgrade (anti-CSWSH). Forwarded to
   *  {@link buildServer}; only enforced when non-empty. */
  wsAllowedOrigins?: readonly string[] | undefined;
  /** Project- and generation-bound signing authority for the relay UDS listener. */
  signingCapabilities?: SigningCapabilityRegistry | undefined;
  /** Network-origin guard for `/internal/*` (audit H1 follow-up) — when set, those
   *  routes 404 unless the request arrived on the internal listener. Forwarded to
   *  {@link buildServer}. */
  internalPathGuard?: ((request: FastifyRequest) => boolean) | undefined;
  /** GitHub-token broker capability registry (resolve side) for
   *  `POST /internal/github/token`. Forwarded to {@link buildServer}. */
  ghTokenCapabilities?: GhTokenCapabilityRegistry | undefined;
  /** Mint a repo-scoped token for a resolved capability binding. Forwarded to
   *  {@link buildServer}. */
  ghTokenMint?:
    ((project: { owner: string; repo: string }) => Promise<string | undefined>) | undefined;
  /** Loopback MCP gateway dependencies for `POST /internal/mcp` (ADR 0014 D1),
   *  minus the approval seam — {@link buildServer} binds that to its own
   *  conductor so no composition can substitute one that never asks. */
  mcpGateway?: Omit<McpGatewayDeps, 'requestApproval'> | undefined;
  /**
   * Conductor construction options (spawner / command / transcript / claudeHome
   * / permissionMode / timeoutMs / env). `store`, `bus`, and the background-
   * failure sink are wired in by the factory, so they're omitted here.
   */
  conductor?: Omit<ConductorDeps, 'store' | 'bus' | 'onTurnError'>;
  /**
   * Optional EXTRA sink for a turn that fails AFTER its 202 acceptance (e.g.
   * push it to the operator). Background failures are ALWAYS logged via the
   * server logger regardless; this just fans out in addition.
   */
  onTurnError?: ((sessionId: string, error: Error) => void) | undefined;
  /** Root dir under which `POST /sessions` provisions a spawn worktree (see
   * {@link buildServer}'s `spawnWorktreeRoot`). */
  spawnWorktreeRoot?: string | undefined;
  /** Enable Fastify request/error logging. Off by default. */
  logger?: boolean | undefined;
  /** Worktree provisioner for `POST /sessions` (real git worktree per agent, §8).
   * Omit to fall back to the empty-scratch-dir default. */
  worktrees?: WorktreeProvisioner | undefined;
  /** The repo-root checkout (e.g. `/work`) reserved for the human/main session —
   * never provisioned or removed by the server (#105). A delete-time safety guard
   * only; sessions never run here. Omit → no guard. */
  workspaceDir?: string | undefined;
  /** Branch switcher for a session's worktree (#91). Omit → branch routes 503. */
  branches?: GitBranchService | undefined;
  /** Open-PR lookup for a branch (#125), adds `PR #N` to the branches response.
   * Omit → no PR chip. (Previously declared only on {@link buildServer}'s deps and
   * dropped here — now forwarded so the embedded composition actually wires it.) */
  branchPr?: ((branch: string, worktree: string) => Promise<number | null>) | undefined;
  /** Compact PR strip status for a branch: title, URL, check counts and mergeability. */
  branchPrStatus?:
    ((branch: string, worktree: string) => Promise<PullRequestStatus | null>) | undefined;
  /** Compact PR strip status for a multi-branch session — the most-recently-updated
   * open PR across `branches`, so a session whose PR is on a branch other than its
   * worktree HEAD still shows the strip. Omit → current-branch-only lookup. */
  branchPrStatusForBranches?:
    | ((branches: readonly string[], worktree: string) => Promise<PullRequestStatus | null>)
    | undefined;
  /** Merge a PR by number. Omit → merge route returns 503. */
  mergePr?: ((number: number, worktree: string) => Promise<boolean>) | undefined;
  /** Resolve GitHub owner/repo for a session worktree so Issue/PR chips deep-link correctly. */
  repoIdentity?: ((worktree: string) => Promise<GitHubIdentity | null>) | undefined;
  /** Open-issues list for the overview backlog (#137). Omit → `GET /issues` 503. */
  listIssues?: (() => Promise<IssueSummary[]>) | undefined;
  /** Latest GitHub release lookup for project overview/detail badges. */
  latestRelease?: ((owner: string, repo: string) => ReleaseSummary | null | undefined) | undefined;
  /** Awaited latest-release refresh for routes that need an immediate answer. */
  refreshLatestRelease?:
    ((owner: string, repo: string) => Promise<ReleaseSummary | null | undefined>) | undefined;
  /** Task-management backend over a Projects v2 board (ADR 0007). Omit → the `/tasks`
   *  routes 503. Forwarded to {@link buildServer} — like `listIssues`, it must be
   *  passed explicitly or the routes silently never see it (#137). */
  taskService?: GitHubTaskService | undefined;
  /** Working dir (repo root) for the one-shot task refiner (ADR 0007, Voice → Refiner).
   *  Omit → `POST /tasks/refine` 503. Forwarded to {@link buildServer}. */
  refineCwd?: string | undefined;
  /** Live GitHub-App credential validation for `POST /github/app/validate` (#320).
   * Test-mints an installation token from the passed creds and reports a redaction-
   * safe result. Omit → the route reports `{ ok: false, error: 'not configured' }`. */
  githubAppValidate?: ((creds: GitHubAppCreds) => Promise<GitHubAppValidateResult>) | undefined;
  /** Derive the git committer identity from the configured GitHub App installation
   * for `/settings/signing-key/generate`. Resolves the decrypted creds itself;
   * `undefined` when no App is configured. Forwarded to {@link buildServer}. */
  resolveGitHubAppIdentity?: (() => Promise<GitHubAppIdentityResult | undefined>) | undefined;
  /** Live Doppler Service Account token validation for `POST /doppler/validate`
   * (#320, OPTIONAL onboarding step). Lists the account's projects from the passed
   * token and reports a redaction-safe result. Omit → the route reports
   * `{ ok: false, error: 'not configured' }`. */
  dopplerValidate?: ((token: string) => Promise<DopplerValidateResult>) | undefined;
  /** Live listing of the account's Doppler projects for the binding picker (#320,
   * `GET /doppler/projects`). Lists from the passed (TRUSTED account) token — never
   * repo content. Redaction-safe. Omit → the route reports
   * `{ error: 'not configured' }`. */
  dopplerListProjects?: ((token: string) => Promise<DopplerProjectSummary[]>) | undefined;
  /** Live listing of a Doppler project's configs for the binding picker (#320,
   * `GET /doppler/configs?project=<project>`). Same trust + redaction contract as
   * {@link dopplerListProjects}. Omit → `{ error: 'not configured' }`. */
  dopplerListConfigs?:
    ((token: string, project: string) => Promise<DopplerConfigSummary[]>) | undefined;
  dopplerCredentialReader?: (() => Promise<Uint8Array | undefined>) | undefined;
  /** Exchanges a GitHub App manifest `code` for the created App for the manifest
   * one-click onboarding routes (#320, `/github/app/manifest/*`). Omit → the
   * callback route renders an error page (manifest onboarding not configured). */
  manifestConvert?: ManifestConvert | undefined;
  /** Injectable `ssh-keygen` spawner for `POST /settings/signing-key/generate`
   * (#320). Generates the ed25519 signing keypair server-side. Omit → the default
   * real spawner (needs `openssh-client` in the runner image). */
  sshKeygen?: SshKeygenSpawner | undefined;
  /** Multi-repo fleet-registry projects (concept §19, #174). Omit →
   * `GET /projects` 503. Typically syncs the GitHub-App-installation repos
   * into the durable `projects` cache and returns the cache. */
  listProjects?: (() => Promise<ProjectRecord[]>) | undefined;
  /** Every GitHub-App installation repository that could become a project —
   * including `state='absent'` rows `listProjects` leaves out. Omit → the repo
   * picker falls back to the project overview. */
  listAvailableRepositories?: (() => Promise<ProjectRecord[]>) | undefined;
  /** Reconciles ONE project's cached lifecycle state against its container before
   * the detail route answers, so the screen that owns Repair never offers an action
   * for a container that has already died. Omit → the cached row is served. */
  reconcileProjectState?: ((project: ProjectRecord) => Promise<ProjectRecord>) | undefined;
  /** Refreshes a project's short-lived GitHub token before an agent uses git. */
  refreshProjectToken?: ((project: ProjectRecord) => Promise<void>) | undefined;
  /** OpenCode-routable model enumeration for the new-session picker (#143). Omit →
   * `GET /models` returns the Claude ids alone (no OpenCode backend configured). */
  listModels?: (() => Promise<string[]>) | undefined;
  /** Provisioning worker (concept §19.3, #174). Drives a project from `absent`
   * to `active` via clone + container start. Omit → the `project` field on
   * `POST /sessions` is rejected with 503. */
  provisioner?: Provisioner | undefined;
  /** Host root containing provisioned project clones. Required with `provisioner`
   * for project-backed session spawns. */
  projectCloneRoot?: string | undefined;
  /** When true, the branch service applies only to project-backed sessions. */
  projectWorktreeBranchesOnly?: boolean | undefined;
  /** Backend wrapper for project-bound sessions, usually Docker exec into the project container. */
  projectBackend?:
    | ((
        project: ProjectRecord,
        selected: Backend,
        settings?: ProjectEnvironmentSettings,
      ) => Backend)
    | undefined;
  /** Runs a git command INSIDE a project's sandbox container instead of on the
   * server. The GitHub-free merge needs it: that path drives git over a clone whose
   * `.git/config` the session owns. Omit → the local merge is refused (503) rather
   * than run server-side. */
  sandboxGit?: ((project: ProjectRecord, clonePath: string) => GitOutput) | undefined;
  /** Runtime actions for active project containers. */
  projectRuntime?: ProjectRuntime | undefined;
  /** Server-side meeting transcriber. Omit → server env-backed local default. */
  meetingTranscriber?: MeetingTranscriber | undefined;
  /** Seam for per-project worktree allocation; production omits it. */
  projectWorktrees?:
    | ((
        project: ProjectRecord,
        clonePath: string,
        opts?: { baseBranch?: string; refreshBase?: boolean },
      ) => WorktreeProvisioner)
    | undefined;
  /** Deprovisioner (concept §19.8, #174). Stops + removes a project container,
   * optionally purges the bind-mount clone. Omit → deprovision route returns 503. */
  deprovisioner?: Deprovisioner | undefined;
  /** Computes whether a running project container should be rebuilt/recreated to
   * pick up the current Verity sandbox/toolkit artifact. */
  sandboxUpdates?: SandboxUpdateChecker | undefined;
}

/**
 * Compose the running control plane: a {@link Conductor} whose background-turn
 * failures are ALWAYS routed to the server logger (plus an optional extra sink),
 * wired into the HTTP server. This is the single correct way to build the live
 * control plane — it closes the silent-black-hole where a turn that already got
 * its `202 Accepted` then fails in the background with no sink configured would
 * vanish (M3-3a-2 follow-up). A full deployment entrypoint (pg pool, migrations,
 * `listen`, graceful shutdown) is a later §17 slice that calls this.
 */
export function buildControlPlane(deps: ControlPlaneDeps): FastifyInstance {
  const derivedProjectSessionBackend =
    deps.projectBackend !== undefined
      ? async (
          session: Parameters<NonNullable<ConductorDeps['sessionBackend']>>[0],
          selected: Backend,
        ) => {
          if (session.projectId === null) return undefined;
          const project = await deps.eventStore.getProject(session.projectId);
          if (project === undefined) return undefined;
          const settings = await deps.eventStore.getProjectSettings(session.projectId);
          return deps.projectBackend!(project, selected, settings);
        }
      : undefined;

  return buildServer({
    eventStore: deps.eventStore,
    ...(deps.https !== undefined ? { https: deps.https } : {}),
    ...(deps.unlockClientIdentity !== undefined
      ? { unlockClientIdentity: deps.unlockClientIdentity }
      : {}),
    ...(deps.devicePairing !== undefined ? { devicePairing: deps.devicePairing } : {}),
    ...(deps.workflowStore !== undefined ? { workflowStore: deps.workflowStore } : {}),
    ...(deps.workflowGithubWebhookSecret !== undefined
      ? { workflowGithubWebhookSecret: deps.workflowGithubWebhookSecret }
      : {}),
    ...(deps.authorizeWorkflowAction !== undefined
      ? { authorizeWorkflowAction: deps.authorizeWorkflowAction }
      : {}),
    bus: deps.bus,
    ...(deps.purgeSessionArtifacts !== undefined
      ? { purgeSessionArtifacts: deps.purgeSessionArtifacts }
      : {}),
    ...(deps.serverUpdateResolver !== undefined
      ? { serverUpdateResolver: deps.serverUpdateResolver }
      : {}),
    ...(deps.serverUpdateController !== undefined
      ? { serverUpdateController: deps.serverUpdateController }
      : {}),
    ...(deps.serverUpdateNotifierStatePath !== undefined
      ? { serverUpdateNotifierStatePath: deps.serverUpdateNotifierStatePath }
      : {}),
    ...(deps.googleDriveClientId !== undefined
      ? { googleDriveClientId: deps.googleDriveClientId }
      : {}),
    ...(deps.secretCipher !== undefined ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.persistAgentCredentials !== undefined
      ? { persistAgentCredentials: deps.persistAgentCredentials }
      : {}),
    ...(deps.claudeOAuthTokenProvider !== undefined
      ? { claudeOAuthTokenProvider: deps.claudeOAuthTokenProvider }
      : {}),
    ...(deps.codexGatewayCredentialProvider !== undefined
      ? { codexGatewayCredentialProvider: deps.codexGatewayCredentialProvider }
      : {}),
    ...(deps.onSecretUnlocked !== undefined ? { onSecretUnlocked: deps.onSecretUnlocked } : {}),
    ...(deps.authRegistry !== undefined ? { authRegistry: deps.authRegistry } : {}),
    ...(deps.pushEnabled !== undefined ? { pushEnabled: deps.pushEnabled } : {}),
    ...(deps.listBrokeredGrants !== undefined
      ? { listBrokeredGrants: deps.listBrokeredGrants }
      : {}),
    ...(deps.revokeBrokeredGrant !== undefined
      ? { revokeBrokeredGrant: deps.revokeBrokeredGrant }
      : {}),
    ...(deps.secretJobRuntimeReadiness !== undefined
      ? { secretJobRuntimeReadiness: deps.secretJobRuntimeReadiness }
      : {}),
    ...(deps.pushSender !== undefined ? { pushSender: deps.pushSender } : {}),
    ...(deps.wsAllowedOrigins !== undefined ? { wsAllowedOrigins: deps.wsAllowedOrigins } : {}),
    ...(deps.signingCapabilities !== undefined
      ? { signingCapabilities: deps.signingCapabilities }
      : {}),
    ...(deps.internalPathGuard !== undefined ? { internalPathGuard: deps.internalPathGuard } : {}),
    ...(deps.ghTokenCapabilities !== undefined
      ? { ghTokenCapabilities: deps.ghTokenCapabilities }
      : {}),
    ...(deps.ghTokenMint !== undefined ? { ghTokenMint: deps.ghTokenMint } : {}),
    ...(deps.mcpGateway !== undefined ? { mcpGateway: deps.mcpGateway } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.spawnWorktreeRoot !== undefined ? { spawnWorktreeRoot: deps.spawnWorktreeRoot } : {}),
    ...(deps.worktrees !== undefined ? { worktrees: deps.worktrees } : {}),
    ...(deps.workspaceDir !== undefined ? { workspaceDir: deps.workspaceDir } : {}),
    ...(deps.branches !== undefined ? { branches: deps.branches } : {}),
    ...(deps.branchPr !== undefined ? { branchPr: deps.branchPr } : {}),
    ...(deps.branchPrStatus !== undefined ? { branchPrStatus: deps.branchPrStatus } : {}),
    ...(deps.branchPrStatusForBranches !== undefined
      ? { branchPrStatusForBranches: deps.branchPrStatusForBranches }
      : {}),
    ...(deps.mergePr !== undefined ? { mergePr: deps.mergePr } : {}),
    ...(deps.repoIdentity !== undefined ? { repoIdentity: deps.repoIdentity } : {}),
    ...(deps.listIssues !== undefined ? { listIssues: deps.listIssues } : {}),
    ...(deps.latestRelease !== undefined ? { latestRelease: deps.latestRelease } : {}),
    ...(deps.refreshLatestRelease !== undefined
      ? { refreshLatestRelease: deps.refreshLatestRelease }
      : {}),
    ...(deps.taskService !== undefined ? { taskService: deps.taskService } : {}),
    ...(deps.refineCwd !== undefined ? { refineCwd: deps.refineCwd } : {}),
    ...(deps.githubAppValidate !== undefined ? { githubAppValidate: deps.githubAppValidate } : {}),
    ...(deps.resolveGitHubAppIdentity !== undefined
      ? { resolveGitHubAppIdentity: deps.resolveGitHubAppIdentity }
      : {}),
    ...(deps.dopplerValidate !== undefined ? { dopplerValidate: deps.dopplerValidate } : {}),
    ...(deps.dopplerListProjects !== undefined
      ? { dopplerListProjects: deps.dopplerListProjects }
      : {}),
    ...(deps.dopplerListConfigs !== undefined
      ? { dopplerListConfigs: deps.dopplerListConfigs }
      : {}),
    ...(deps.dopplerCredentialReader !== undefined
      ? { dopplerCredentialReader: deps.dopplerCredentialReader }
      : {}),
    ...(deps.manifestConvert !== undefined ? { manifestConvert: deps.manifestConvert } : {}),
    ...(deps.sshKeygen !== undefined ? { sshKeygen: deps.sshKeygen } : {}),
    ...(deps.listProjects !== undefined ? { listProjects: deps.listProjects } : {}),
    ...(deps.listAvailableRepositories !== undefined
      ? { listAvailableRepositories: deps.listAvailableRepositories }
      : {}),
    ...(deps.reconcileProjectState !== undefined
      ? { reconcileProjectState: deps.reconcileProjectState }
      : {}),
    ...(deps.refreshProjectToken !== undefined
      ? { refreshProjectToken: deps.refreshProjectToken }
      : {}),
    ...(deps.listModels !== undefined ? { listModels: deps.listModels } : {}),
    ...(deps.provisioner !== undefined ? { provisioner: deps.provisioner } : {}),
    ...(deps.projectCloneRoot !== undefined ? { projectCloneRoot: deps.projectCloneRoot } : {}),
    ...(deps.projectWorktreeBranchesOnly !== undefined
      ? { projectWorktreeBranchesOnly: deps.projectWorktreeBranchesOnly }
      : {}),
    ...(deps.projectBackend !== undefined ? { projectBackend: deps.projectBackend } : {}),
    ...(deps.sandboxGit !== undefined ? { sandboxGit: deps.sandboxGit } : {}),
    ...(deps.projectRuntime !== undefined ? { projectRuntime: deps.projectRuntime } : {}),
    ...(deps.meetingTranscriber !== undefined
      ? { meetingTranscriber: deps.meetingTranscriber }
      : {}),
    ...(deps.projectWorktrees !== undefined ? { projectWorktrees: deps.projectWorktrees } : {}),
    ...(deps.deprovisioner !== undefined ? { deprovisioner: deps.deprovisioner } : {}),
    ...(deps.sandboxUpdates !== undefined ? { sandboxUpdates: deps.sandboxUpdates } : {}),
    // Factory form: called with the app logger so the sink logs through it.
    conductor: (logger) =>
      new Conductor({
        store: deps.eventStore,
        bus: deps.bus,
        ...deps.conductor,
        ...(deps.conductor?.sessionBackend === undefined &&
        derivedProjectSessionBackend !== undefined
          ? { sessionBackend: derivedProjectSessionBackend }
          : {}),
        ...(deps.conductor?.sessionSystemPrompt === undefined
          ? {
              sessionSystemPrompt: (session) =>
                session.projectId === VERITY_CONTROL_PROJECT_ID ||
                (session.projectId === null &&
                  (session.name === VERITY_CONTROL_SESSION_NAME ||
                    session.name === LEGACY_VERITY_CONTROL_SESSION_NAME ||
                    session.name === 'Concierge'))
                  ? VERITY_CONTROL_SYSTEM_PROMPT
                  : '',
            }
          : {}),
        onTurnError: (sessionId, error) => {
          // Log the full Error (pino's `err` serializer keeps the stack) — the
          // background path has no HTTP request context, so it's the most
          // diagnostic-critical place to preserve it.
          logger.error({ sessionId, err: error }, 'verity: background turn failed');
          deps.onTurnError?.(sessionId, error);
        },
      }),
  });
}
