import type { SessionStorage } from './session-storage.js';
import type { Backend, Conductor, EventBus } from '@verity/session';
import type {
  EventStore,
  ProjectRecord,
  SealableSecretCipher,
  VeritySettingsPatch,
  VeritySettingsRecord,
} from '@verity/store';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import type { AgentLoginService } from './agent-login.js';
import type { AuditLog } from './audit-log.js';
import type { AuditRecorder } from './audit-recorder.js';
import type { AuthTokenRegistry } from './auth.js';
import type { BackupRuntime } from './backup/runtime.js';
import type { GitBranchService, GitOutput } from './branches.js';
import type { BrokeredGrantRecord } from './brokered-http-grants.js';
import type { ClaudeOAuthTokenProvider, ClaudeUsageService } from './claudeUsage.js';
import type { CodexUsageCredentialProvider, CodexUsageService } from './codexUsage.js';
import type { DevicePairingManager } from './device-pairing.js';
import type {
  DopplerConfigSummary,
  DopplerProjectSummary,
  DopplerValidateResult,
} from './doppler-token.js';
import type { ForgeRepoRef, PullRequestStatus, ReleaseSummary } from './forge-provider.js';
import type { SshSignSpawner } from './git-signer.js';
import type {
  GitHubAppCreds,
  GitHubAppIdentityResult,
  GitHubAppValidateResult,
} from './github-app-token.js';
import type { ManifestConvert } from './github-manifest.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { HttpMcpProxyDeps } from './http-mcp-proxy.js';
import type { ListenerDiscovery } from './listener-discovery.js';
import type { SessionChangeFeed } from './live/live-hub.js';
import type { LocalPreviewManager } from './local-preview-manager.js';
import type { LogRouteDeps } from './log-routes.js';
import type { ManagedDevServerManager } from './managed-dev-server-manager.js';
import type { McpGatewayDeps } from './mcp-gateway.js';
import type { MeetingTranscriber } from './meeting-transcription.js';
import type { PreviewSharingCapability } from './preview-capability.js';
import type { PreviewShareManager } from './preview-share-manager.js';
import type { ProjectGitHubIssues } from './project-github-issues.js';
import type { ProjectSandboxLifecycleTelemetry } from './project-lifecycle-telemetry.js';
import type { ProjectRepository } from './project-repo-route.js';
import type { ProjectRuntime } from './project-runtime.js';
import type { ProjectEnvironmentSettings } from './project-settings-env.js';
import type { Deprovisioner, Provisioner } from './provisioner.js';
import type { PushSender } from './push-sender.js';
import type { RepairDiscovery } from './repair-supervisor.js';
import type { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import type { SandboxUpdateChecker } from './sandbox-updates.js';
import type { ReleaseChannelResolver } from './self-update/release-channel.js';
import type { ServerUpdateController } from './server-update-routes.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';
import type { SshKeygenSpawner } from './signing-key.js';
import type { RemoteControlDescriptor } from './uplink-control-client.js';
import type { WorktreeProvisioner } from './worktree.js';

export interface ServerDeps {
  /** Internal service; public operations remain gated on complete recovery acceptance. */
  backup?: BackupRuntime | undefined;
  webAppDir?: string | undefined;
  matrixConnectorToken?: string | (() => Promise<string | undefined>) | undefined;
  onMatrixConfigured?: (() => Promise<void>) | undefined;
  /** TLS termination for direct/non-managed deployments. Managed deployments
   * terminate at the dedicated Gateway instead. */
  https?: HttpsServerOptions | undefined;
  /** Authenticated original-client identity supplied by the managed TLS gateway. */
  unlockClientIdentity?: ((request: FastifyRequest) => string | undefined) | undefined;
  browserRequestOrigin?: ((request: FastifyRequest) => string | undefined) | undefined;
  eventStore: EventStore;
  /**
   * Verity's data root. The knowledge folders live under `<dataRoot>/knowledge`
   * (ADR 0022 D1) and the session explorer browses them from there. Absent —
   * tests, and any deployment without a data root — leaves the explorer's
   * knowledge roots reporting "not found" and changes nothing else.
   */
  dataRoot?: string | undefined;
  /**
   * Delete the backend transcript files a session left on the runner runtime, so a
   * deleted session takes its conversation with it and not just its row (see
   * `session-artifacts.ts`). Called immediately BEFORE the store delete, because the
   * `session_backend_state` rows that name those files go with the FK cascade.
   *
   * Absent on deployments without the runner supervisor, where no such files exist.
   * Never rejects: a transcript that could not be removed is logged by the
   * implementation, and must not fail the delete it belongs to.
   */
  purgeSessionArtifacts?: ((sessionId: string) => Promise<void>) | undefined;
  /** Verified official release-channel resolver. Absent means this deployment is unmanaged. */
  serverUpdateResolver?: ReleaseChannelResolver | undefined;
  /** Privileged Updater control channel. Absent leaves the update action unavailable. */
  serverUpdateController?: ServerUpdateController | undefined;
  /**
   * Where the release notifier remembers the version it last announced. Absent
   * disables the notification entirely — deliberately, because without somewhere
   * to persist that, the only options are announcing on every check or losing the
   * announcement across the restart an update itself causes.
   */
  serverUpdateNotifierStatePath?: string | undefined;
  /** Temporary public preview lifecycle. Absent keeps sharing routes disabled. */
  listenerDiscovery?: ListenerDiscovery | undefined;
  localPreviewManager?: LocalPreviewManager | undefined;
  /** Dev servers the agent sets up and Verity runs (concept 2.6). */
  managedDevServerManager?: ManagedDevServerManager | undefined;
  previewSharingCapability?:
    (() => Promise<PreviewSharingCapability> | PreviewSharingCapability) | undefined;
  previewShareManager?: PreviewShareManager | undefined;
  returnPathActivation?: import('./remote-return-path-activation.js').ReturnPathActivation;
  returnPathConnectorCount?: () => number;
  coordinatedRecording?: import('./coordinated-recording.js').CoordinatedRecordingManager;
  remoteControlDescriptor?: (() => RemoteControlDescriptor) | undefined;
  runtimeDiagnostics?: ReturnType<typeof createRuntimeDiagnostics> | undefined;
  uplinkDiagnostics?:
    | (() => import('./uplink-control-client.js').UplinkDiagnostics & {
        remoteStreams?: import('./remote-control-connector.js').RemoteStreamRecord[];
      })
    | undefined;
  /** Reconnect the Uplink after its encrypted credential changes. */
  recheckUplink?:
    (() => Promise<import('./uplink-control-client.js').UplinkDiagnostics>) | undefined;
  onUplinkCredentialsChanged?: (() => void) | undefined;
  /** Apply the premium feature switches after either of them changed. */
  onPremiumFeatureSwitchesChanged?:
    ((settings: VeritySettingsRecord) => void | Promise<void>) | undefined;
  /** Rewrite the OpenCode config directory after its central settings change. */
  onOpenCodeSettingsChanged?:
    ((settings: VeritySettingsRecord) => void | Promise<void>) | undefined;
  /** Fan-out bus the live WS stream subscribes to (M3-2). */
  bus: EventBus;
  /** Google Drive OAuth *iOS* client id (ADR 0009), supplied as server env
   *  `GOOGLE_AUTH_ID`. Release images bake a default in at build time, while
   *  local/self-built deployments can pass it at container runtime. Non-secret —
   *  the app reads it from `/settings` to build the PKCE request, and the server
   *  uses it for the code exchange + refresh. Omit → the Drive feature reports
   *  "not configured". */
  googleDriveClientId?: string | undefined;
  stagingGoogleClientId?: string | undefined;
  /** Invalidate access tokens minted from shared Google credentials after OAuth reconnects. */
  onGoogleCredentialsChanged?: (() => void) | undefined;
  /** Sealable at-rest secret cipher backing `/secret/status|init|unlock`.
   *  Omit → the secret store is treated as an unmanaged always-unlocked no-op. */
  attendeeEdge?: import('./preview-share-manager.js').PreviewEdgeControl;
  /** Mints access tokens for a stored Google account; scheduling requests act on their own. */
  googleAccessToken?: ((accountId?: string) => Promise<string | undefined>) | undefined;
  secretCipher?: SealableSecretCipher | undefined;
  /** Per-device API auth-token registry backing the C1 auth gate. When present
   *  AND enabled (a master password exists), a global `onRequest` hook requires a
   *  valid `Authorization: Bearer` token on every route outside the pre-auth
   *  allowlist. Omit → the gate is disabled (tests / unmanaged deployments). */
  authRegistry?: AuthTokenRegistry | undefined;
  /** Installer-issued, TLS-bound device pairing. When present, a fresh
   * `/secret/init` additionally requires a one-time bootstrap capability. */
  devicePairing?: DevicePairingManager | undefined;
  /** Enable Expo push-token registration and sender. Off by default. */
  pushEnabled?: boolean | undefined;
  /** Standing brokered-secret grants for a project (ADR 0011 D2), backing
   *  `GET /projects/:id/secret-grants`. Absent → the route reports "not configured". */
  listBrokeredGrants?: ((projectId: string) => Promise<BrokeredGrantRecord[]>) | undefined;
  /** End one standing grant, backing `DELETE /projects/:id/secret-grants/:grantId`. A
   *  `forever` grant never expires, so this is the ONLY way it ends — ship it with the
   *  scope, not after. Resolves false when no active grant matched (→ 404). */
  revokeBrokeredGrant?: ((projectId: string, grantId: string) => Promise<boolean>) | undefined;
  /** Re-attest Docker/runsc for health probes when the Secret Job runtime is required. */
  secretJobRuntimeReadiness?: (() => Promise<void>) | undefined;
  /** Expo notification transport + durable receipt worker. The factory form
   * receives Fastify's logger after app construction. Omit when push is off. */
  pushSender?: PushSender | ((logger: FastifyBaseLogger) => PushSender) | undefined;
  /** Foreground reconnect debounce for push fire points. Production uses the
   * default; tests may shorten it without sleeping. */
  pushFirePointDebounceMs?: number | undefined;
  /** Conductor-side session changes no event records; hinted to live overviews. */
  sessionChanges?: SessionChangeFeed | undefined;
  /** How long an in-app alert waits for an answer before the user's other
   * devices are pushed. Tests shorten it. */
  pushEscalationMs?: number | undefined;
  /** PR-ready background refresh cadence. Production defaults to 30 seconds;
   * tests may shorten it. */
  pullRequestPushPollMs?: number | undefined;
  /** Background PR repair cadence, independent of app presence and push tokens. */
  pullRequestRepairPollMs?: number | undefined;
  /** Injectable clock for PR cache freshness tests. Defaults to Date.now. */
  pullRequestCacheNow?: (() => number) | undefined;
  /** Optional subscription-login service. Defaults to spawning Claude/Codex login CLIs. */
  agentLogin?: AgentLoginService | undefined;
  /** Serializes a credential DB write with propagation into live sandbox mounts. */
  persistAgentCredentials?:
    ((patch: VeritySettingsPatch, persist: () => Promise<void>) => Promise<void>) | undefined;
  /** Single serialized Claude OAuth provider shared by turns and usage polling. */
  claudeOAuthTokenProvider?: ClaudeOAuthTokenProvider | undefined;
  /** Reads a short-lived Codex access token from the Agent Gateway, which owns the
   * rotating login (ADR 0010). Absent → the Codex usage probe stays inert. */
  codexGatewayCredentialProvider?: CodexUsageCredentialProvider | undefined;
  /** Runs after a successful first initialization or unlock. Used by services whose
   * encrypted runtime material could not be loaded while the store was sealed. */
  onSecretUnlocked?: (() => Promise<void>) | undefined;
  /** Allowlist of `Origin` header values accepted on the WebSocket upgrade
   *  (defence-in-depth against cross-site WebSocket hijacking). Only enforced
   *  when non-empty: a request whose `Origin` is PRESENT and not listed is
   *  refused. A missing `Origin` (native mobile clients don't send one) always
   *  passes — those aren't reachable by a browser CSWSH. Omit/empty → no Origin
   *  check (the bearer token, which a hostile page cannot obtain, is the guard). */
  wsAllowedOrigins?: readonly string[] | undefined;
  /**
   * Steering: dispatches operator turns to a session's resumed process (M3-3).
   * Either a ready {@link Conductor} or a factory called with the server's
   * logger — the factory form lets the conductor's background-failure sink
   * (`onTurnError`) log through the same logger (see `buildControlPlane`).
   */
  conductor: Conductor | ((logger: FastifyBaseLogger) => Conductor);
  /**
   * Root directory under which `POST /sessions` provisions a fresh worktree per
   * spawned agent. Defaults to `<tmpdir>/verity-sessions`. Only used to build the
   * default scratch provisioner when {@link ServerDeps.worktrees} is absent.
   */
  spawnWorktreeRoot?: string;
  /**
   * Provisions a worktree per spawned agent (concept §8). Inject the git-worktree
   * provisioner so a spawned agent runs on a real branch of the project repo
   * (edit/commit/push/PR); absent → a {@link createScratchProvisioner scratch
   * dir} default (empty, no repo — A1 behavior).
   */
  worktrees?: WorktreeProvisioner;
  sessionStorage?: SessionStorage | undefined;
  /**
   * The repo-root checkout (e.g. `/work`) reserved for the human/main session —
   * NEVER provisioned or removed by the server (#105). Sessions never run here
   * (every spawn is an isolated worktree); this is purely a delete-time safety
   * guard so a stale session row whose worktree happens to be the repo root can
   * never `git worktree remove` the operator's main tree. Absent → no guard needed.
   */
  workspaceDir?: string;
  /**
   * Switches the working branch of a session's worktree while keeping the chat
   * (#91). Absent → the branch routes return 503 (no project repo configured).
   */
  branches?: GitBranchService;
  /**
   * How long the session header's branch label may be served from memory before
   * the next activity poll re-reads git. Defaults to {@link BRANCH_TTL_MS}; `0`
   * reads git on every poll, which is what tests asserting a live read want.
   */
  branchCacheTtlMs?: number;
  /**
   * Looks up the open PR number for a branch (#125) — used to add `currentPr` to the
   * branches response so the header can show `PR #N`. Absent → no PR chip (GitHub not
   * configured). Best-effort and cached; the issue # comes from the branch name on
   * the client, independent of this.
   */
  branchPr?: (branch: string, worktree: string) => Promise<number | null>;
  /** Live compact PR status for the current branch: title, URL, check counts and
   * whether the Merge button should be enabled. Absent → older token-less behavior. */
  invalidateProjectPrStatus?: (projectId: string) => void;
  repairPullRequest?: (
    project: ProjectRecord,
    number: number,
  ) => Promise<{ state: 'open' | 'closed' | 'merged' } | null>;
  repairDiscovery?: (project: ProjectRecord, page: number) => Promise<RepairDiscovery>;
  branchPrStatus?: (branch: string, worktree: string) => Promise<PullRequestStatus | null>;
  /**
   * Live compact PR status for a session spanning SEVERAL branches — the most-
   * recently-updated OPEN PR among `branches` (the worktree HEAD first, then the
   * session's other branches). Fixes the empty PR bar when a session's PR is on a
   * branch other than its worktree HEAD (a multi-phase session that pushed a
   * differently-named branch). Falls back to the HEAD branch's own status when no
   * branch has an open PR, so single-branch sessions are unchanged. Absent → the
   * server uses {@link branchPrStatus} on the current branch only (older behavior). */
  branchPrStatusForBranches?: (
    branches: readonly string[],
    worktree: string,
  ) => Promise<PullRequestStatus | null>;
  /** Merge a PR by number. Absent → merge endpoint returns 503. */
  mergePr?: (number: number, worktree: string, expectedHeadSha?: string) => Promise<boolean>;
  /**
   * Resolves the project repo's GitHub `{ owner, repo }` identity from its `origin`
   * remote (#161) — surfaced as `owner`/`repo` on the branches response so the mobile
   * header can build tappable GitHub URLs for its Issue/PR chips. Memoized by the
   * provider (the origin is stable). Absent, or resolving to null (no GitHub remote /
   * unparseable origin), omits owner/repo so the chips degrade to non-tappable. Never
   * throws into the branches list — a rejection degrades to omitting the fields.
   */
  repoIdentity?: (worktree: string) => Promise<ForgeRepoRef | null>;
  /**
   * Account-global Claude quota probe (the undocumented `/api/oauth/usage`
   * endpoint the Claude apps use), surfaced via `GET /provider-limits` so the
   * overview can show a real usage gauge for Claude — at parity with Codex —
   * instead of the reset-time-only signal the stream emits. Absent → defaulted in
   * {@link buildServer} from Verity DB settings only; without stored Claude
   * credentials the probe is inert (yields `[]`) and the route returns an empty
   * list. Injected in tests.
   */
  claudeUsage?: ClaudeUsageService;
  /**
   * Account-global Codex quota probe, the Codex half of `GET /provider-limits`.
   * Codex's own per-turn `rate_limit` events only advance when an interactive
   * session finishes a turn — `codex exec` runs consume quota silently — so
   * without this probe the Codex meter freezes at the last observed value.
   * Absent → defaulted in {@link buildServer} from the gateway credential
   * provider; without one the probe is inert (yields `[]`). Injected in tests.
   */
  codexUsage?: CodexUsageService;
  /** Repository context for server-side model queries. */
  refineCwd?: string;
  /**
   * Latest published GitHub release for a repo, for the project-overview version
   * badge. Synchronous + non-blocking by contract (the provider serves a cached
   * value and refreshes in the background), so the `GET /projects` handler can
   * enrich each project without awaiting the network. Tristate return:
   * `undefined` = not known yet (cold cache / no token — keep the persisted
   * value), `null` = confirmed no release (clear a stale one), a summary = the
   * latest release. Absent dep → projects fall back to their persisted release.
   */
  latestRelease?: (owner: string, repo: string) => ReleaseSummary | null | undefined;
  refreshLatestRelease?: (
    owner: string,
    repo: string,
  ) => Promise<ReleaseSummary | null | undefined>;
  /**
   * Lists the multi-repo fleet-registry projects (concept §19, #174) for `GET
   * /projects` — the mobile new-session picker's source. A provider typically syncs
   * the GitHub-App-installation repos into the durable `projects` cache before
   * returning the cache, so the picker sees both repos GitHub exposes AND any
   * Verity-side provisioning state on the same rows. Absent → route returns 503
   * (GitHub installation service not configured). Never throws; resolves to the
   * cached list even when the GitHub fetch degrades to `[]`.
   */
  listProjects?: () => Promise<ProjectRecord[]>;
  /**
   * Forgets the memoised `listProjects` result. The routes that write an
   * operator-owned project field (fold state, order, setup status) call it
   * before answering: the overview polling the list would otherwise echo the
   * state from before the write for the whole cache window — long enough for a
   * client to take that echo for the truth.
   */
  invalidateProjectList?: () => void;
  /** Best-effort image cleanup after a successful project soft-delete. */
  onProjectHidden?: (projectId: string) => Promise<void>;
  /** Durable audit trail (ADR 0028): project deletion and the admin read API. */
  audit?:
    | ({ recorder: AuditRecorder; log: AuditLog } & Pick<
        LogRouteDeps,
        'buildDiagnostics' | 'serverLogs'
      >)
    | undefined;
  /**
   * Reconciles ONE project's cached lifecycle state against Docker's current
   * container truth and returns the (possibly updated) row. `listProjects` does
   * this for the whole fleet on the overview path; the project detail route needs
   * the same freshness without the GitHub-installation sync, because that screen
   * owns the Repair action — reading the cache alone let it offer "Pause" for a
   * container that had already died. Absent → the route serves the cached row.
   */
  reconcileProjectState?: (project: ProjectRecord) => Promise<ProjectRecord>;
  /**
   * Lists all GitHub-App installation repositories that can become Verity projects.
   * Unlike `listProjects`, this includes rows that are still `state='absent'`
   * so onboarding/new-project pickers can offer every installed repository without
   * making the overview look like every repo has been created.
   */
  listAvailableRepositories?: () => Promise<ProjectRecord[]>;
  forgejoEnabled?: boolean;
  listProjectGitHubIssues?: (project: ProjectRecord) => Promise<ProjectGitHubIssues>;
  /**
   * Provisioning worker (concept §19.3, #174). When `POST /sessions { project }`
   * targets a project whose `state !== 'active'`, the route fires this worker
   * asynchronously and returns `202 awaiting_provisioning` — the operator
   * polls `GET /projects` (or the `state` badge on the project row) until the
   * container is ready, then re-issues `POST /sessions { project }` to spawn
   * the agent. Absent → the `project` field on `POST /sessions` is rejected
   * with 503 (multi-repo fleet registry not configured; clients fall back to
   * the no-project spawn path).
   */
  provisioner?: Provisioner | undefined;
  /** In-process aggregate and structured transition feed for Sandbox sleep/wake. */
  projectSandboxLifecycleTelemetry?: ProjectSandboxLifecycleTelemetry | undefined;
  /**
   * Host root containing provisioned project clones. Required alongside
   * `provisioner` for active project spawns so the conductor runs in the
   * selected repository instead of the server's default worktree allocator.
   */
  projectCloneRoot?: string | undefined;
  /** Restrict git branch operations to project-backed sessions. */
  projectWorktreeBranchesOnly?: boolean | undefined;
  /** Refresh a project's short-lived GitHub token before an agent uses git. */
  refreshProjectToken?: (project: ProjectRecord) => Promise<void>;
  /** Computes whether a running project container should be rebuilt/recreated to
   *  pick up the current Verity sandbox/toolkit artifact. */
  sandboxUpdates?: SandboxUpdateChecker | undefined;
  /** The content identity of the toolkit trust root this Server ships, for the
   *  per-project drift verdict. Injectable so tests can state a Server identity
   *  without a bundle on disk; defaults to the cached real read. `undefined`
   *  means this Server ships no bundle and judges nothing. */
  toolkitIdentity?: (() => Promise<string | undefined>) | undefined;
  /**
   * Live GitHub-App credential validation for `POST /github/app/validate` (#320,
   * onboarding). Given the stored App creds it test-mints an installation token
   * and reports success (with a SAFE account login) or a redacted failure. It
   * MUST never return/log the token or PEM. Absent → the route reports
   * `{ ok: false, error: 'not configured' }` (no validator wired).
   */
  githubAppValidate?: (creds: GitHubAppCreds) => Promise<GitHubAppValidateResult>;
  /**
   * Derive the git committer identity from the configured GitHub App installation
   * (`GET /app/installations/:id` → account). Used by `/settings/signing-key/
   * generate` to fill `gitUserName`/`gitUserEmail` from the App rather than env
   * config, so the signing identity matches an account that can hold the signing
   * key. Resolves the (decrypted) App creds itself. Returns `undefined` when no App
   * is configured (no identity to derive); an `{ ok: false }` result signals a real
   * failure (e.g. an organization installation). MUST never return/log JWT or PEM.
   */
  resolveGitHubAppIdentity?: (() => Promise<GitHubAppIdentityResult | undefined>) | undefined;
  /**
   * Live Doppler Service Account token validation for `POST /doppler/validate`
   * (#320, onboarding — OPTIONAL step). Given the stored account token it lists
   * the account's projects and reports success (with a SAFE project count) or a
   * redacted failure. It MUST never return/log the token. Absent → the route
   * reports `{ ok: false, error: 'not configured' }` (no validator wired).
   */
  dopplerValidate?: (token: string) => Promise<DopplerValidateResult>;
  /**
   * Live listing of the account's Doppler projects for the binding picker (#320,
   * `GET /doppler/projects`). The route reads + decrypts the stored account token
   * itself (unsealed-only) and hands it here; this lists the account's projects
   * from that TRUSTED token (NOT repo content — closes the confused-deputy). It
   * MUST never return/log the token — only NON-secret `{ slug, name }` summaries.
   * On failure it throws a redacted, status-keyed message (no token/body leak).
   * Absent → the route reports `{ ok: false, error: 'not configured' }`.
   */
  dopplerListProjects?: (token: string) => Promise<DopplerProjectSummary[]>;
  /**
   * Live listing of a Doppler project's configs for the binding picker (#320,
   * `GET /doppler/configs?project=<project>`). Same security contract as
   * {@link dopplerListProjects}: reads the token from the decrypting route,
   * returns only NON-secret `{ name, environment?, root? }` summaries, redacted
   * throw on failure. Absent → `{ ok: false, error: 'not configured' }`.
   */
  dopplerListConfigs?: (token: string, project: string) => Promise<DopplerConfigSummary[]>;
  /** Central broker-owned Doppler identity reader shared with native secret tools. */
  dopplerCredentialReader?: (() => Promise<Uint8Array | undefined>) | undefined;
  /**
   * Exchanges a GitHub App manifest `code` for the created App (id + slug + PEM)
   * for the manifest one-click onboarding routes (#320, `/github/app/manifest/*`).
   * Injectable so tests drive a fake instead of calling GitHub. Absent → the
   * `callback` route renders an error page (manifest onboarding not configured).
   * MUST be redaction-safe: never log the PEM; never echo the GitHub body.
   */
  manifestConvert?: ManifestConvert;
  /**
   * Injectable clock for the manifest CSRF-state TTL (#320). Defaults to
   * `Date.now`; tests pass a controllable clock to exercise expiry deterministically.
   */
  manifestStateNow?: () => number;
  /**
   * Injectable `ssh-keygen` spawner for `POST /settings/signing-key/generate`
   * (#320, onboarding). Generates the ed25519 signing keypair server-side.
   * Defaults to the real spawner (needs `openssh-client` in the runner image);
   * tests inject a fake so the suite never shells out.
   */
  sshKeygen?: SshKeygenSpawner | undefined;
  /** Injectable `ssh-keygen -Y sign` spawner for the commit-signing broker
   *  (`POST /internal/git/sign`, audit H1). Defaults to the real spawner; tests
   *  inject a fake so the suite never shells out. */
  sshSign?: SshSignSpawner | undefined;
  /** Project-bound signing authority accepted only on a matching project Unix socket. */
  signingCapabilities?: SigningCapabilityRegistry | undefined;
  /** Network-origin guard for `/internal/*` routes (audit H1 follow-up). When set,
   *  a request to any `/internal/*` path is 404'd unless this predicate returns
   *  true — wired to {@link requestArrivedInternally} so the commit-signing broker
   *  is reachable ONLY over the dedicated non-published listener, never the
   *  public/LAN-published API port. Omit → `/internal/*` stays on the main listener
   *  (today's behaviour), guarded only by the route's own broker token. */
  internalPathGuard?: ((request: FastifyRequest) => boolean) | undefined;
  /** GitHub-token broker (security review). Resolves a sandbox-presented capability
   *  to its server-side project binding for `POST /internal/github/token`. When set
   *  together with {@link ServerDeps.ghTokenMint}, the route is registered +
   *  pre-auth-allowlisted; otherwise no token-broker route is exposed. */
  ghTokenCapabilities?: GhTokenCapabilityRegistry | undefined;
  /** The code host behind a repository project, for the sandbox `verity-repo` tool. */
  projectRepository?:
    ((project: ProjectRecord) => Promise<ProjectRepository | undefined>) | undefined;
  /** Check live Drive ancestry before granting automatic document URL reads. */
  googleDriveDocumentIsWithinProject?: (input: {
    projectId: string;
    sessionId: string;
    url: string;
    accountId?: string | undefined;
    folderLinkId?: string | undefined;
  }) => Promise<boolean>;
  /**
   * The loopback MCP gateway's dependencies, minus its approval seam (ADR 0014 D1). When
   * set, `POST /internal/mcp` is registered + pre-auth-allowlisted; otherwise an ACP session
   * reaches no brokered tool at all.
   *
   * `requestApproval` is deliberately NOT part of this: it is bound here to the conductor
   * this server already resolved, so the gateway's card, its decide route and the standing
   * grant are the same ones a turn-bound prompt uses (D2). A composition that could supply
   * its own approval seam could supply one that never asks.
   */
  mcpGateway?: Omit<McpGatewayDeps, 'requestApproval'> | undefined;
  /** Separate bearer audience for configured upstream MCP connections. */
  mcpProxyResolveCaller?: HttpMcpProxyDeps['resolveCaller'] | undefined;
  /** Mint a repo-scoped GitHub token for a resolved capability binding (the same
   *  App-installation mint the provisioner uses). The broker calls this AFTER
   *  resolving the capability, so the sandbox never influences owner/repo/scope. */
  ghTokenMint?:
    ((project: { owner: string; repo: string }) => Promise<string | undefined>) | undefined;
  /** Backend for a project-bound session. Typically `docker exec` into the
   * project's canonical container. */
  projectBackend?:
    | ((
        project: ProjectRecord,
        selected: Backend,
        settings?: ProjectEnvironmentSettings,
      ) => Backend)
    | undefined;
  /** Runs a git command INSIDE a project's sandbox container, against the clone
   *  mounted there. Used by the GitHub-free merge: that path drives git over a
   *  repository whose `.git/config` the session owns, and several config keys name a
   *  program git then runs. Executing it in the sandbox keeps that program where the
   *  sandbox is already allowed to run code, instead of on the server. Absent → the
   *  local merge is refused rather than run server-side. */
  sandboxGit?: ((project: ProjectRecord, clonePath: string) => GitOutput) | undefined;
  /** Runtime actions for an active project container, e.g. starting its dev server. */
  projectRuntime?: ProjectRuntime | undefined;
  /** Server-side meeting transcription with speaker diarization. When omitted, the
   *  server runs the configured local transcription command. */
  meetingTranscriber?: MeetingTranscriber | undefined;
  /** How long a finished live meeting waits for late notes before it is filed. */
  /** Test/deployment seam for per-project session worktrees. Omit to create
   * git worktrees under `<project clone>/.verity-sessions`. */
  projectWorktrees?:
    | ((
        project: ProjectRecord,
        clonePath: string,
        opts?: { baseBranch?: string; refreshBase?: boolean },
      ) => WorktreeProvisioner)
    | undefined;
  /**
   * Deprovisioner (concept §19.8, #174). Powers `POST /projects/:id/deprovision`
   * (stop + remove container → `state='absent'`) plus the `?purge=true` flag
   * that ALSO removes the bind-mount clone path. Absent → the deprovision route
   * returns 503.
   */
  deprovisioner?: Deprovisioner | undefined;
  /**
   * Enumerates the non-Claude models for `GET /models` (ADR 0001 / #143) — the Codex
   * catalogue plus the operator-pinned OpenCode ids (`providerID/modelID`). Absent →
   * neither backend is configured, so `/models` returns the Claude ids alone. MUST
   * resolve to a list or throw; a throw is caught by the route and DEGRADES to
   * Claude-only — `/models` never 500s on it.
   */
  listModels?: () => Promise<string[]>;
  /** Enable Fastify request/error logging. Off by default (tests, embedding). */
  logger?: boolean;
  /** Overrides {@link PROJECT_DELETE_SPAWN_WAIT_MS} — how long `DELETE
   *  /projects/:id` waits for a spawn admitted just before it. Tests that
   *  exercise the give-up path shrink it; production leaves it alone. */
  projectDeleteSpawnWaitMs?: number;
}
