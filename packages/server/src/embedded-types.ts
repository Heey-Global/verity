import { type Database } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { type Kysely } from 'kysely';
import type { ServerDeps, ServerUpdateController } from './server.js';
import { type DockerGcPolicy } from './docker-gc.js';
import { type RemoteConnectorPoolOptions } from './remote-control-connector.js';
import { type BrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import {
  createSecretGrantBroker,
  type SecretResolver,
  type WorkloadAuthorizer,
} from './secret-grant-broker.js';
import { type DopplerSecretResolverOptions } from './doppler-secret-resolver.js';
import type { SecretGrantIssuer } from './secret-authorization.js';
import { type SecretJobFrameSpool } from './secret-job-frame-spool.js';
import { type SecretJobAuthorization, type SecretJobService } from './secret-job-service.js';
import type { RunGrantClaims, StreamingRedactorProfile } from '@verity/secret-contracts';
import { type SweepResult } from './session-artifact-sweep.js';
import { type GitHubProjectTokenMint } from './github-app-token.js';
import { type ProjectImageRefSource } from './provisioner.js';
import { ProjectEgressLifecycle } from './project-egress-lifecycle.js';
import { type SandboxVersionSource } from './sandbox-updates.js';
import type { ReleaseChannelResolver } from './self-update/release-channel.js';

export interface EmbeddedServerConfig {
  /** TLS termination for a direct Server. Managed mode terminates at its Gateway. */
  https?: ServerDeps['https'];
  unlockClientIdentity?: ServerDeps['unlockClientIdentity'];
  webAppDir?: ServerDeps['webAppDir'];
  browserRequestOrigin?: ServerDeps['browserRequestOrigin'];
  /** Optional installer-issued authority that gates first initialization. */
  devicePairing?: ServerDeps['devicePairing'];
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
  stagingGoogleClientId?: string | undefined;
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
  /** Test seam for the DB-backed, project-scoped GitHub App token mint. */
  githubProjectTokenMint?: GitHubProjectTokenMint | undefined;

  /** Enable the Codex CLI backend and discover its visible model ids daily. */
  codexEnabled?: boolean | undefined;
  /** Explicit Codex model allow-list. When omitted, the bundled Codex CLI catalog is used. */
  codexModels?: readonly string[] | undefined;
  /** Test seam for the bundled Codex catalog (the sealed-boot seed). Production uses
   *  `codex debug models --bundled`, which needs neither an unlock nor a CODEX_HOME. */
  codexBundledModelLoader?: (() => Promise<string[]>) | undefined;
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
   *  When set, the multi-repo fleet-registry provisioner and deprovisioner are wired —
   *  `POST /sessions { project }` and
   *  `POST /projects/:id/deprovision` become operational. Omit → those routes
   *  return 503 (multi-repo fleet registry not configured). */
  dockerBaseUrl?: string | undefined;
  /** Injected host egress lifecycle (tests and probes); otherwise built from the socket and key. */
  projectEgress?: ProjectEgressLifecycle | undefined;
  /** Host egress service control socket and key file. Both present → network protection
   *  becomes available; whether it applies is the system-wide `projectEgressEnabled` setting. */
  projectEgressSocketPath?: string | undefined;
  projectEgressProvisioningPending?: boolean | undefined;
  projectEgressKeyPath?: string | undefined;
  projectEgressInventoryRequired?: (() => boolean) | undefined;
  diagnosticServerContainerId?: string | undefined;
  hostDiagnosticSnapshotPath?: string | undefined;
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
  /** Local preview transport is available independently of Uplink. */
  resolvePreviewConnectorImage?: (() => Promise<string | undefined>) | undefined;
  publicPreviews?:
    | {
        resolveConnectorImage: () => Promise<string | undefined>;
        uplinkUrl: string;
        expectedInstallationId?: string;
        serverVersion: string;
        /** Explicitly configured fixed ingress; absent in the production entrypoint. */
        remoteControl?: Pick<RemoteConnectorPoolOptions, 'localHost' | 'localPort'>;
      }
    | undefined;
  /** Sandbox runtime hardening (security review C1). The provisioner always drops
   *  all capabilities, blocks privilege escalation, and caps PIDs by default; these
   *  tune it. See main.ts for the `VERITY_SANDBOX_*` env mapping. */
  sandboxPidsLimit?: number | undefined;
  sandboxMemoryBytes?: number | undefined;
  sandboxMemoryReservationBytes?: number | undefined;
  sandboxHostReserveBytes?: number | undefined;
  sandboxOomScoreAdj?: number | undefined;
  sandboxSwapBytes?: number | undefined;
  sandboxNanoCpus?: number | undefined;
  sandboxCpuShares?: number | undefined;
  sandboxCapAdd?: string[] | undefined;
  sandboxAllowPrivilegeEscalation?: boolean | undefined;
  /** Upstream resolvers for gVisor project Sandboxes (`VERITY_SANDBOX_DNS_SERVERS`). Unset →
   *  the project relay, which forwards to Docker's embedded resolver. */
  sandboxDnsServers?: readonly string[] | undefined;
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
  /** Shared npm download-cache maintenance target, in allocated bytes (default 4 GiB). */
  runnerCacheMaxBytes?: number | undefined;
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
  /** Internal test seam for startup transcript cleanup; production always uses `on`. */
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
   * The STORE-READ phase of the startup transcript sweep. Absent without a data volume.
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
interface EmbeddedSecretKeyHandoff {
  /** Key material to seal for the successor, or undefined while sealed. */
  exportKeyMaterial(): string | undefined;
}

export interface EmbeddedSecretJobs {
  broker: ReturnType<typeof createSecretGrantBroker>;
  executor: BrokeredSecretJobExecutor;
  frames: SecretJobFrameSpool;
  service: SecretJobService;
}
