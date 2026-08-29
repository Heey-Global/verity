/**
 * Provisioning worker (multi-repo fleet registry, concept §19.3, Refs #174).
 * Drives one `projects` row from `state='absent'` to `state='active'`:
 *
 *   absent → cloning → container_starting → active
 *                    ↘ failed (with `provision_error`)
 *
 * Each **state transition** runs INSIDE a `SELECT … FOR UPDATE`-locked
 * transaction (so two concurrent `POST /sessions` for the same
 * not-yet-provisioned repo can't both claim `cloning`). The actual
 * long-running I/O (git clone, docker create+start) runs OUTSIDE the lock
 * — a throw inside the lock-scope would roll back the `failed`-state write;
 * running the I/O outside means the `failed` transition persists even on
 * error. Collision backstop: docker-name uniqueness + the ON CONFLICT
 * (owner, repo) constraint on `upsertProject`.
 *
 * **Token handling** (§19.3 security-critical): GitHub App installation
 * tokens are passed as HTTPS Basic credentials via an in-memory
 * `http.extraheader` (username `x-access-token`, password = token). GitHub
 * accepts that form for Git transport; `Bearer` is only reliable for API calls.
 * The token NEVER lands in `remote.origin.url` (which Git persists in
 * `.git/config` ON the bind-mount — would survive container rebuilds,
 * defeating the §19.2 "token is for clone-time, not stored" contract). After a
 * successful clone the URL is overwritten with the credential-less form as a
 * second defense layer (per §19.3 "Nach erfolgreichem Clone remote set-url").
 *
 * The clone path itself is the bind-mount path (§19.1 — `/data/dev/<slug>` on
 * the host). Re-provisioning after a `deprovision-keep` (§19.8) detects a
 * non-empty path and does `git fetch + reset --hard origin/main` instead of
 * a fresh clone (preserves uncommitted state if any survived; the design was
 * ambiguous on that — inheriting the worker-state-from-cache rule, we just
 * re-sync to the latest `origin/main`, NOT clobbering local branches).
 */
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fchownSync,
  fstatSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  type Stats,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { type Kysely } from 'kysely';
import { PROJECT_IMAGE_REBUILDING_WARNING } from '@verity/events';
import { SealedError, isLocalProject } from '@verity/store';
import {
  resolveSigningPrivateKey,
  SIGNING_BROKER_TOKEN_FILE,
  SIGNING_BROKER_TOKEN_HASH_LABEL,
  signingBrokerTokenHash,
} from './git-signer.js';
import { signHistoryForPush } from './sign-history.js';
import { RUNNER_CLAUDE_HOME_DIRNAME, RUNNER_CODEX_SESSIONS_DIRNAME } from './runner-transcript.js';
import {
  attestRunnerSupervisorBoundary,
  RUNNER_RUNTIME_GID,
  RUNNER_RUNTIME_UID,
  type ImageEvidenceCollector,
  type RunnerBoundaryAttestation,
} from './runner-boundary-attestation.js';

// Re-exported from their definition next to the boundary evaluator that
// enforces them, so the container-start path and the attestation cannot drift
// apart on what the reserved Runner identities are.
export { RUNNER_RUNTIME_GID, RUNNER_RUNTIME_UID };
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { ClaudeEgressIdentityService } from './claude-egress-identity.js';
import type { SigningCapabilityRegistry } from './signing-capability.js';
import type { VeritySettingsRecord, Database, EventStore, ProjectRecord } from '@verity/store';
import {
  DockerError,
  type DockerClient,
  type ContainerSpec,
  type CreateContainerResult,
} from './docker.js';
import {
  defaultContainerCommandRunner,
  type ContainerCommandRunner,
} from './devcontainer-lifecycle.js';
export {
  defaultContainerCommandRunner,
  devcontainerLifecycleCommand,
  devcontainerLifecyclePath,
  type ContainerCommandRunner,
} from './devcontainer-lifecycle.js';
import type { GitHubTokenSource } from './github.js';
import type { GitHubInstallationTokenMint, GitHubProjectTokenMint } from './github-app-token.js';
import type { ProjectRelayActivation, ProjectRelayBinding } from './project-relay-lifecycle.js';
import { getProjectInTx, updateProjectStateInTx, withProjectLock } from './project-persistence.js';
import {
  CONTAINER_GENERATION_LABEL,
  PROJECT_ID_LABEL,
  SANDBOX_SELF_REPAIR_FAILURE_LIMIT,
  classifyProjectContainer,
  containerGenerationOf,
  decideMigrationAction,
  ENV_DRIFT_RECREATE_LIMIT,
  ENV_DRIFT_RECREATES_PER_TICK,
  envDriftIsSoleReason,
  type ProjectContainerClass,
} from './project-relay-migration.js';

export interface ProjectRelayControl {
  start(binding: ProjectRelayBinding): Promise<ProjectRelayActivation>;
  /** Reattach process-local listeners to a relay generation that survived a
   * Server restart, without rotating the capabilities mounted in its sandbox. */
  resume?(binding: ProjectRelayBinding): Promise<boolean>;
  stop(projectId: string): Promise<void>;
  brokerUrl(activation: ProjectRelayActivation): string;
  claudeGatewayUrl(activation: ProjectRelayActivation): string;
  codexGatewayUrl?(activation: ProjectRelayActivation): string;
  /** Whether the relay serving a sandbox of this exact generation is live — both
   *  its container running and this server still owning the listeners and
   *  capabilities behind it. Optional so a control that cannot answer (test
   *  doubles, older wirings) leaves relay health unprobed rather than reported
   *  unhealthy. A property rather than a method so callers can test for its
   *  presence without holding an unbound method reference. */
  isHealthy?: (binding: { projectId: string; containerGeneration: string }) => Promise<boolean>;
}

const execFileAsync = promisify(execFile);

// Default hard memory ceiling per project sandbox (HostConfig.Memory). Sandboxes
// are UNTRUSTED and run arbitrary agent workloads (builds, tests, memory-leaky
// tooling); without a cap a single runaway can exhaust host RAM and trigger a
// GLOBAL OOM that thrashes the whole box unreachable (observed in prod: one
// sandbox process ballooned and took the dev-server down). Capping each sandbox
// keeps an OOM contained to that container's cgroup — the box stays healthy.
// Safe-by-default for a modest single-host install; override per-host with
// VERITY_SANDBOX_MEMORY (main.ts) where a higher/lower ceiling fits the
// available RAM.
const DEFAULT_SANDBOX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
// Keep CPU-heavy builds from starving the control plane and neighbouring
// sandboxes. Two cores matches the reference Compose deployment and remains
// overridable through VERITY_SANDBOX_CPUS for larger or smaller hosts.
const DEFAULT_SANDBOX_NANO_CPUS = 2 * 1e9;
const DEVCONTAINER_BUILD_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** How many genuinely legacy or broken project relays may be repaired at once,
 * without letting every project's container create hit the host in one instant. */
const RELAY_MIGRATION_CONCURRENCY = 4;
export const RUNNER_RUNTIME_TARGET = '/run/verity-runner';
export const RUNNER_AGENT_UID = 1000;
export const RUNNER_AGENT_GID = 1000;
export const RUNNER_BROKER_CAPABILITIES = ['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP'] as const;

const DEVCONTAINER_NODE_FEATURE_REF = 'ghcr.io/devcontainers/features/node:1';
const DEVCONTAINER_NODE_FEATURE_OPTIONS = { version: '24' } as const;
const DEVCONTAINER_TOOLKIT_FEATURE_OPTIONS = { installRunnerSupervisor: true } as const;
const DEVCONTAINER_TOOLKIT_ENTRYPOINT = ['/bin/sh', '-lc'];
const DEVCONTAINER_POST_CREATE_READY_FILE = '/tmp/verity-post-create-complete';
/** In-container path of the read-only GitHub-token-broker capability file. The
 *  credential helper / gh wrapper read it to authenticate to the token broker. */
const GH_TOKEN_CAPABILITY_FILE = '/run/verity/gh-token-capability';

/** In-container paths of the read-only Claude-egress mTLS material. Only the
 *  public CA and this project's own client identity are projected here; the CA
 *  private key and the OAuth token never cross into the sandbox (ADR 0006 D10).
 *  The connector (`verity-egress-connector-start`) realpath-validates
 *  these and requires the key file to be readable by only the Runner identity. */
const CLAUDE_EGRESS_CA_FILE = '/run/verity/claude-egress/ca.crt';
const CLAUDE_EGRESS_CERT_FILE = '/run/verity/claude-egress/client.crt';
const CLAUDE_EGRESS_KEY_FILE = '/run/verity/claude-egress/client.key';

/** Hand a freshly written secret FILE to the Runner group without requiring the
 *  non-root Verity server to hold effective CAP_CHOWN. The sandbox's regular
 *  agent user can share the Server uid, so owner-read is explicitly removed:
 *  the file becomes group-read-only (0040) for the Runner gid. */
function defaultChownRunnerFile(path: string, ownership: { uid: number; gid: number }): void {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new ProvisioningError('Claude egress key path is not a regular file');
    }
    fchownSync(fd, -1, ownership.gid);
    fchmodSync(fd, 0o040);
  } finally {
    closeSync(fd);
  }
}
function devcontainerToolkitCommand(waitForPostCreate: boolean): string[] {
  const wait = waitForPostCreate
    ? `while [ ! -f ${DEVCONTAINER_POST_CREATE_READY_FILE} ]; do sleep 0.1; done; rm -f ${DEVCONTAINER_POST_CREATE_READY_FILE}; `
    : '';
  return [
    `${wait}if [ -x /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh ]; then VERITY_AGENT_RUN_FOREGROUND=1 exec /usr/local/share/verity-sandbox-toolkit/lifecycle/post-start.sh; fi; exec verity-agent-run`,
  ];
}
const UNSUPPORTED_DEVCONTAINER_RUNTIME_KEYS = [
  'capAdd',
  'containerEnv',
  'containerUser',
  'init',
  'initializeCommand',
  'onCreateCommand',
  'overrideCommand',
  'postAttachCommand',
  'privileged',
  'remoteEnv',
  'runArgs',
  'runServices',
  'securityOpt',
  'updateContentCommand',
  'waitFor',
  'workspaceMount',
];

/** Async exec seam (so tests can stub `git`/`remote` invocations without
 *  spawning a real process). Each call receives the argv array and returns
 *  `{ stdout, stderr }`; rejects on a non-zero exit (the production runner
 *  surfaces a real `ExecFileException` via `execFileAsync`). */
export type GitRunner = (
  args: readonly string[],
  opts?: GitRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;

/** Per-invocation overrides. `env` is MERGED over the server's own environment,
 *  never a replacement — dropping `PATH`/`HOME` would break git itself. It exists
 *  for the identity `git commit-tree` reads only from the environment
 *  (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`), which no `-c` flag can express: rebuilding
 *  a commit has to preserve its ORIGINAL author while giving it a new committer.
 *  Optional, so every existing runner (and every test fake) stays valid. */
export interface GitRunnerOptions {
  env?: Readonly<Record<string, string>>;
}

const defaultGitRunner: GitRunner = async (args, opts) => {
  return execFileAsync(
    'git',
    [...args],
    opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } },
  );
};

/** Injectable seam for the official `@devcontainers/cli` build (ADR 0003 R3.1).
 *  Given the workspace folder, the derived image tag to build, and the
 *  `DOCKER_HOST` the build must target, it shells out
 *  `devcontainer build --workspace-folder <folder> --image-name <tag>` and
 *  resolves on success. On a non-zero exit it MUST reject with an `Error` whose
 *  message carries the build stderr so the provisioner can surface a truncated
 *  `provision_error`. Kept injectable so tests never spawn a real build. */
export type DevcontainerBuildSpawner = (args: {
  workspaceFolder: string;
  imageName: string;
  dockerHost: string;
  /** Ref of the published `verity-sandbox-toolkit` Feature (R3.1/#299). When set, the
   *  build injects it via `--additional-features {"<ref>": {}}` ({} = the Feature's
   *  own defaults). Absent → the flag is omitted entirely (no-feature behaviour). */
  additionalFeatures?: string | undefined;
  /** ghcr.io bearer token for the build. When set, the spawner writes a scoped,
   *  temporary docker config so the devcontainer CLI can resolve the PRIVATE
   *  `verity-sandbox-toolkit` Feature (and pull the base image) as the GitHub App.
   *  Absent → no registry auth (public-only, the prior behaviour). Never logged. */
  registryToken?: string | undefined;
  /** Forced rebuild (`--no-cache`): re-run every layer instead of reusing the
   *  daemon's build cache. Only the explicit "Rebuild image" action sets this.
   *  Bypassing the derived-tag cache alone is not enough — a rebuild that still
   *  hits the layer cache re-runs nothing, so a `RUN` whose inputs live outside
   *  the Dockerfile (an apt index, a remote install script) produces the same
   *  image and the operator sees the same "nothing changed" as before. */
  noCache?: boolean | undefined;
}) => Promise<{ stdout: string; stderr: string }>;

/** Options for the container-replacing actions: the recreate the app exposes as
 *  "Update & restart", and the container phase it and `provision` both run. */
export interface RecreateContainerOptions {
  confirmWarnings?: boolean;
  /** The app's "Rebuild image" action. Skips the derived devcontainer image
   *  cache and builds with `--no-cache`. Costs a full build, so it is never
   *  implied by an ordinary provision or update — only an operator asks for it,
   *  after a change the content hash cannot see (see `resolveOrBuildImage`).
   *  A project running the base image directly has nothing to rebuild, and the
   *  flag is inert there rather than an error: which of the two a project is
   *  depends on whether its clone carries a `.devcontainer/`, which the caller
   *  is not required to know. */
  forceRebuild?: boolean;
}

/** Build the `devcontainer build` argv (pure, exported for behaviour-driven
 *  testing). Appends `--additional-features {"<ref>": {}}` ONLY when a feature ref
 *  is present — the CLI's JSON map of feature-id→options, `{}` selecting the
 *  Feature's own defaults. Absent → the flag never appears, so the no-feature case
 *  is byte-identical to before R3.1's Feature wiring. `--no-cache` is appended
 *  only for a forced rebuild, so the ordinary provision argv is unchanged. */
export function devcontainerBuildArgs(args: {
  workspaceFolder: string;
  imageName: string;
  additionalFeatures?: string | undefined;
  noCache?: boolean | undefined;
}): string[] {
  const argv = [
    'build',
    '--workspace-folder',
    args.workspaceFolder,
    '--image-name',
    args.imageName,
  ];
  if (args.noCache === true) argv.push('--no-cache');
  if (args.additionalFeatures !== undefined && args.additionalFeatures.length > 0) {
    argv.push(
      '--additional-features',
      JSON.stringify({
        [DEVCONTAINER_NODE_FEATURE_REF]: DEVCONTAINER_NODE_FEATURE_OPTIONS,
        [args.additionalFeatures]: DEVCONTAINER_TOOLKIT_FEATURE_OPTIONS,
      }),
    );
  }
  return argv;
}

/** Real devcontainer-build spawner: runs `devcontainer build` with `DOCKER_HOST`
 *  pointed at the target daemon so the official CLI builds the derived image onto
 *  the same Engine Verity spawns containers on. Rejects (via `execFileAsync`) on a
 *  non-zero exit; the rejection's `stderr` is what the provisioner truncates into
 *  `provision_error`. The explicit output buffer avoids false failures from
 *  verbose but valid devcontainer builds. Not covered by the unit suite (a real
 *  build is heavy) — the build LOGIC is verified through an injected fake +
 *  {@link devcontainerBuildArgs}. */
export const defaultDevcontainerBuildSpawner: DevcontainerBuildSpawner = async ({
  workspaceFolder,
  imageName,
  dockerHost,
  additionalFeatures,
  registryToken,
  noCache,
}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: dockerHost };
  // When we have a token, point the devcontainer CLI at a throwaway docker config
  // that authenticates to ghcr.io as the GitHub App (`x-access-token:<token>`).
  // Scoped via DOCKER_CONFIG so it never touches the server's own config and is
  // wiped in `finally`. Mode 0700/0600 — it holds a short-lived bearer.
  let dockerConfigDir: string | undefined;
  if (registryToken !== undefined && registryToken.length > 0) {
    dockerConfigDir = mkdtempSync(join(tmpdir(), 'verity-dockercfg-'));
    const auth = Buffer.from(`x-access-token:${registryToken}`, 'utf8').toString('base64');
    writeFileSync(
      join(dockerConfigDir, 'config.json'),
      JSON.stringify({ auths: { 'ghcr.io': { auth } } }),
      { mode: 0o600 },
    );
    env.DOCKER_CONFIG = dockerConfigDir;
  }
  try {
    return await execFileAsync(
      'devcontainer',
      devcontainerBuildArgs({ workspaceFolder, imageName, additionalFeatures, noCache }),
      { env, maxBuffer: DEVCONTAINER_BUILD_MAX_BUFFER_BYTES },
    );
  } finally {
    if (dockerConfigDir !== undefined) rmSync(dockerConfigDir, { recursive: true, force: true });
  }
};

export interface ProvisioningDirectory {
  /** Host-side canonical hyphen-slug, e.g. `/data/dev/heey-global-verity`. */
  clonePath: string;
  /** Container-name hyphen-slug, e.g. `dev-heey-global-verity`. */
  containerName: string;
}

interface ProjectImage {
  imageRef: string;
  usesDevcontainerImage: boolean;
  usesConfiguredOverride: boolean;
}

// The function form accepts an optional `forceRefresh`: the provision/recreate
// path passes `true` to bypass the resolver's staleness cache and pin the
// container to the CURRENT default digest (see createPublishedDefaultResolver).
// Zero-arg callers (the update-status poll) keep the cached, rate-limit-friendly
// behavior.
export type ProjectImageRefSource = string | ((forceRefresh?: boolean) => Promise<string>);
export type DevcontainerFeatureSource =
  | { ref: string; version: string; identity: string }
  | (() => Promise<{ ref: string; version: string; identity: string } | undefined>);

/** Outcome of linking a local project to a GitHub repository. Empty when the history
 *  went straight onto the (empty) repository's default branch; otherwise it names the
 *  import branch the history was published on and the pull request carrying it in. */
export interface LinkCloneToGitHubResult {
  importBranch?: string | undefined;
  pullRequest?: { number: number; url: string } | undefined;
  /** Set when the branch is published but its pull request could not be opened. */
  pullRequestError?: string | undefined;
}

export interface ProvisionerOptions {
  /** EventStore the provisioner drives `projects.state` through. */
  store: EventStore;
  /** Raw kysely handle (used for the `SELECT … FOR UPDATE` lock tx — the
   *  {@link EventStore} interface doesn't expose transactions, so the lock
   *  tx is composed here on the raw kysely connection). */
  db: Kysely<Database>;
  /** Docker client (socket-proxy-backed; from slice 3a). */
  docker: DockerClient;
  /** Token provider — fresh `ghs_*` per clone (*not* cached; the issue says
   *  `~/.gh-token` rotates ~hourly, the call site re-reads each time). */
  token: GitHubTokenSource;
  /** Runs after a project container has started, before provisioning succeeds. */
  onContainerStarted?: ((project: ProjectRecord) => Promise<void>) | undefined;
  /** Fail-closed hook for generation-bound dependants such as public previews.
   * Runs after validation/warnings but before the old sandbox is mutated. */
  withContainerReplace?:
    (<T>(project: ProjectRecord, mutation: () => Promise<T>) => Promise<T>) | undefined;
  /** Default image ref (centrally pinned, §19.5) for projects without an
   *  explicit `image_ref` override. */
  defaultImageRef: ProjectImageRefSource;
  /** Path to the host-side gh-token file — mount read-only in the container
   *  so agent processes inside can `git push` (per §19.3 + §16 blast-radius
   *  note). */
  ghTokenFilePath: string;
  /** Optional GitHub App token minter. When configured, Verity mints and
   *  persists a fresh project-local token during provisioning instead of
   *  relying on external Concierge rotation. */
  projectTokenMint?: GitHubProjectTokenMint | undefined;
  /** Bind-mount root (`/data/dev`). The provisioner joins `<root>/<slug>`. */
  hostCloneRoot: string;
  /** Host-visible agent-seed directory mounted into sandboxes at /opt/agent-seed. */
  agentSeedHostPath?: string | undefined;
  /** Shared Claude Code config/auth volume mounted into project containers. */
  claudeConfigVolume?: string | undefined;
  /** Shared Codex CLI config/auth volume mounted into project containers. */
  codexConfigVolume?: string | undefined;
  /** Shared OpenCode config/auth volume mounted into project containers. */
  opencodeConfigVolume?: string | undefined;
  /** Shared pi config/auth volume mounted into project containers. */
  piConfigVolume?: string | undefined;
  /** Central Verity settings provider for git identity/signing material. */
  veritySettings?: (() => Promise<VeritySettingsRecord | undefined>) | undefined;
  /** Opens the pull request that carries a linked local project's history onto a
   *  non-empty GitHub repository. Absent → the branch is published without one and
   *  the operator opens it (see {@link LinkCloneToGitHubResult.pullRequestError}). */
  openPullRequest?:
    | ((
        target: { owner: string; repo: string },
        token: string,
        pr: { head: string; base: string; title: string; body: string },
      ) => Promise<{ number: number; url: string }>)
    | undefined;
  /** Server-owned root for ephemeral files materialized from DB-backed secrets. */
  gitSecretRoot?: string | undefined;
  /** Named data volume + its in-server mount root (security review, M16). When set,
   *  every per-project mount whose host path lives under {@link dataVolumeRoot}
   *  (the `/work` clone + the materialized secrets) is emitted as a NAMED-VOLUME
   *  mount with a subpath relative to the volume root, instead of a host bind. The
   *  sibling sandbox then resolves the source by volume NAME — no host-path
   *  knowledge, no pre-created/chowned host dir. Deploy-level mounts (the read-only
   *  agent-seed toolkit, `/dev/null`, devcontainer mounts) stay host binds. Set both
   *  or neither. */
  dataVolume?: string | undefined;
  /** The path the {@link dataVolume} is mounted at inside the Verity server (e.g.
   *  `/srv/verity`), so a host clone/secret path can be reduced to a volume subpath
   *  (`workspaces/<owner>-<repo>`, `secrets/…`). */
  dataVolumeRoot?: string | undefined;
  /** ADR 0006 Stage 3: prepare and mount a protected per-project Runner runtime,
   * then start the sandbox-local discovery supervisor. This does NOT route turns
   * through it yet. Default off until remote attach is complete. */
  runnerSupervisor?: boolean | undefined;
  /** True only when the default source is the managed Verity sandbox image. */
  runnerSupervisorTrustedDefaultImage?: boolean | undefined;
  runnerRuntimeUid?: number | undefined;
  runnerRuntimeGid?: number | undefined;
  /** Test seam for trusted, host-side image evidence collection. */
  imageEvidenceCollector?: ImageEvidenceCollector | undefined;
  /** Bundled toolkit directory whose binaries are the attestation trust root. */
  runnerBoundaryFeatureDir?: string | undefined;
  /** Test/deployment seam for ownership preparation. Defaults to mkdir/chmod/chown. */
  prepareRunnerRuntime?:
    ((path: string, ownership: { uid: number; gid: number }) => void) | undefined;
  /** GitHub-token broker (security review). The mandatory project relay lifecycle
   *  issues a per-container capability into this registry; the provisioner mounts
   *  it (plus the relay URL) instead of writing a
   *  `.gh-token` file into the sandbox. The sandbox's git credential helper / gh
   *  wrapper redeem the capability at `POST /internal/github/token` for a
   *  repo-scoped token minted on demand — so no GitHub token lives at rest. */
  ghTokenCapabilities?: GhTokenCapabilityRegistry | undefined;
  /** Claude-egress mTLS projection (ADR 0006 D10). When set together with
   *  {@link claudeEgressGatewayUrl}, {@link claudeConnectorPort} and
   *  {@link gitSecretRoot}, the provisioner issues this project's client identity
   *  and mounts the public CA + client cert/key read-only into the sandbox, plus
   *  the connector's coordinates as env — so the agent's Claude traffic can be
   *  pinned to the Verity egress gateway with NO OAuth token or CA private key at
   *  rest. Absent → dormant (no material projected). This does NOT start the
   *  gateway; that is a separate activation step. */
  claudeEgressIdentity?: ClaudeEgressIdentityService | undefined;
  /** Origin the sandbox connector forwards Claude traffic to (the egress gateway),
   *  e.g. `https://verity:9443`. Sets `VERITY_CLAUDE_EGRESS_URL`. */
  claudeEgressGatewayUrl: string;
  /** Parallel Codex gateway origin reached through the project relay. */
  codexEgressGatewayUrl?: string;
  /** Server-namespace address used by the relay-owned Unix listener to reach the
   * legacy in-process gateway. Distinct from the TLS hostname in the URL. */
  claudeEgressGatewayConnectHost?: string | undefined;
  /** Loopback port the sandbox connector listens on; drives
   *  `VERITY_CLAUDE_CONNECTOR_PORT` and `VERITY_CLAUDE_CONNECTOR_AUTHORITY`. */
  claudeConnectorPort?: number | undefined;
  /** Whether a sandbox carrying only PART of an env block the provisioner writes
   *  whole (`SANDBOX_ENV_COHORTS` in `./project-relay-migration.js`) is recreated.
   *  Default true, and that is
   *  the point of the feature — a project whose sandbox predates the Codex egress
   *  leg cannot run Codex at all until it is rebuilt.
   *
   *  The switch exists because the first deploy of a new cohort makes every drifted
   *  sandbox in the fleet a rebuild target on the next reconcile tick, and the whole
   *  safety argument rests on a cohort being declared correctly. `ENV_DRIFT_RECREATE_LIMIT`
   *  bounds the damage of getting that wrong to three recreates per project; this
   *  bounds it to zero, without a rollback, for a deployment that would rather serve
   *  502s than churn containers. Set false and classification ignores env entirely,
   *  which is exactly the behaviour that shipped before this. */
  recreateEnvDriftedSandboxes?: boolean | undefined;
  /** Optional SNI the connector pins on the gateway (`VERITY_CLAUDE_EGRESS_SERVERNAME`);
   *  should match the identity service's gateway server name. */
  claudeEgressServerName?: string | undefined;
  /** Optional per-project override used for explicit standalone-gateway canaries.
   * Returning undefined preserves the legacy gateway coordinates. */
  claudeEgressGatewayForProject?:
    ((project: ProjectRecord) => { url: string; serverName?: string }) | undefined;
  /** Test/deployment seam for handing the client-key file to the Runner uid/gid.
   *  Defaults to {@link defaultChownRunnerFile}; unit tests pass a recorder/no-op
   *  when they need to assert the requested Runner identity without mutating file
   *  ownership. */
  chownRunnerFile?: ((path: string, ownership: { uid: number; gid: number }) => void) | undefined;
  /** Runtime hardening for spawned sandbox containers (security review C1). By
   *  default Verity drops all Linux capabilities, blocks privilege escalation
   *  (`no-new-privileges`), and caps PIDs — so a malicious dependency cannot fork-
   *  bomb the host or escalate to container-root. These knobs tune that policy for
   *  a project whose devcontainer legitimately needs more. */
  /** Max PIDs per sandbox (fork-bomb guard). Default 512. */
  sandboxPidsLimit?: number | undefined;
  /** Hard memory ceiling per sandbox, in bytes. Default 4 GiB. */
  sandboxMemoryBytes?: number | undefined;
  /** CPU quota per sandbox in nano-CPUs (1e9 = one core). Default 2 cores. */
  sandboxNanoCpus?: number | undefined;
  /** Capabilities to add back on top of the default `CapDrop: ALL` — for a project
   *  that genuinely needs one (e.g. `NET_BIND_SERVICE`). */
  sandboxCapAdd?: string[] | undefined;
  /** Opt OUT of `no-new-privileges` for sandboxes whose devcontainer relies on
   *  `sudo` (which privilege-escalation blocking would break). Default false
   *  (hardened). */
  sandboxAllowPrivilegeEscalation?: boolean | undefined;
  /** Mandatory atomic per-project relay boundary. Provisioning obtains both
   * broker capabilities and both generation-bound UDS listeners from this one
   * lifecycle; every later provisioning failure invokes stop() fail-closed. */
  projectRelay: ProjectRelayControl;
  /** Injected git runner (tests). */
  git?: GitRunner;
  /** Optional filesystem probe seams (tests). */
  isDirectory?: (path: string) => boolean;
  localConfigState?: (clonePath: string) => LocalConfigState;
  /** Devcontainer-build spawner (ADR 0003 R3.1). When set together with
   *  {@link dockerHostForBuild}, a project whose clone has a `.devcontainer/`
   *  directory gets a content-hash-cached derived image built via the official
   *  `@devcontainers/cli` instead of running the base image directly. Absent →
   *  every project runs the base image. Injectable so tests
   *  don't spawn a real build. */
  devcontainerBuild?: DevcontainerBuildSpawner | undefined;
  /** Mints a short-lived ghcr.io token (GitHub App installation token, `packages:read`)
   *  used to authenticate the devcontainer build so it can resolve the PRIVATE
   *  `verity-sandbox-toolkit` Feature and pull the base image as the App. Absent (or
   *  returns undefined) → the build runs without registry auth (public-only). */
  registryTokenMint?: GitHubInstallationTokenMint | undefined;
  /** `DOCKER_HOST` value the {@link devcontainerBuild} spawner must target so the
   *  CLI builds onto the same daemon Verity uses. Derived from the docker base
   *  URL at the composition root (`dockerHostFor(baseUrl)`). Required for the
   *  build path; absent → the build is skipped and the base image is used. */
  dockerHostForBuild?: string | undefined;
  /** The `verity-sandbox-toolkit` Feature (R3.1/#299). `ref` is the published
   *  Feature reference passed to `--additional-features`; `identity` is mixed into
   *  the derived-image content hash so any Feature ref/digest change invalidates the
   *  cache. The ref is injected at build time whenever the build seam
   *  ({@link devcontainerBuild} + {@link dockerHostForBuild}) is wired. Absent →
   *  devcontainer repos fail closed at build time; non-devcontainer repos still
   *  run the base image. */
  devcontainerFeature?: DevcontainerFeatureSource | undefined;
  /** Runs supported devcontainer lifecycle commands in the started container.
   *  Defaults to `docker exec`; injectable so tests never shell out. */
  containerCommand?: ContainerCommandRunner | undefined;
}

export const CLAUDE_EGRESS_GATEWAY_URL_LABEL = 'verity.claude-egress.gateway-url';

/** Read the canonical directory descriptors off a project row (post-canonical
 *  per §19.0/§19.1 — assumes the row was upserted through the slice-2 sync).
 *
 *  `cloneDir` overrides the derived `<owner>-<repo>` name. It is set for projects
 *  created without a GitHub repo and PINNED when such a project is later linked
 *  to one, so the rewritten `(owner, repo)` cannot silently point the mount — and
 *  every session worktree persisted underneath it — at a different directory. */
export function projectClonePath(hostCloneRoot: string, project: ProjectRecord): string {
  const root = hostCloneRoot.replace(/\/+$/, '');
  return `${root}/${project.cloneDir ?? `${project.owner}-${project.repo}`}`;
}

function projectDirs(hostCloneRoot: string, project: ProjectRecord): ProvisioningDirectory {
  return {
    clonePath: projectClonePath(hostCloneRoot, project),
    containerName: project.containerName,
  };
}

/** Resolve the image ref for a project: explicit `image_ref` overrides the
 *  centrally-pinned default (§19.5 — NULL on the row means "resolved at build
 *  time", not "frozen at registration"). */
export function resolveImage(project: ProjectRecord, defaultRef: string): string {
  return project.imageRef ?? defaultRef;
}

/** Recursively enumerate every file under `dir` (relative POSIX paths, sorted)
 *  paired with its raw byte contents. Deterministic across platforms: entries
 *  are name-sorted at every level and path separators normalized to `/` so the
 *  hash is stable regardless of readdir order or host OS. Symlinks are REFUSED,
 *  not followed (audit M10): this reads an untrusted repo's `.devcontainer`, and a
 *  symlink there could point the server-side read at a host path outside the clone
 *  (e.g. `/etc`, the secrets dir). A symlink entry throws loudly rather than
 *  dereferencing. */
function collectDirFiles(dir: string): Array<{ path: string; content: Buffer }> {
  const out: Array<{ path: string; content: Buffer }> = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `verity: refusing to follow a symlink in an untrusted clone: ${relative(dir, abs).split(sep).join('/')}`,
        );
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        out.push({
          path: relative(dir, abs).split(sep).join('/'),
          content: readFileSync(abs),
        });
      }
    }
  };
  walk(dir);
  return out;
}

/** Read a file from an untrusted clone, refusing to follow a symlink at the final
 *  component (audit M10) — an `lstat` guard before the read so a repo cannot alias
 *  e.g. `.devcontainer/devcontainer.json` to a host-side file. Throws `ELOOP`-style
 *  on a symlink; passes ENOENT/ENOTDIR through so callers keep their absent-file
 *  handling. */
function readFileNoFollow(path: string): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new Error(`verity: refusing to follow a symlink in an untrusted clone: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/** Content hash over `(the .devcontainer/ directory contents + the resolved base
 *  image ref)` → the 12-hex-char suffix of the derived image tag (ADR 0003 R3.1).
 *
 *  Inputs mixed in, in order, each length-prefixed so distinct inputs can't
 *  collide by concatenation: the base image ref, then (when provided) the bundled
 *  Feature's content identity, then for every file (sorted by relative path) its
 *  path and its bytes. Same devcontainer + same base + same feature identity ⇒
 *  cache hit; editing any file OR a base-image rollout OR a Feature content
 *  change ⇒ different hash ⇒ rebuild. The `featureIdentity` is optional and
 *  mixed in ONLY when provided — when absent the hash is byte-identical to the
 *  pre-Feature form (back-compat / dormant). Exported for direct
 *  behaviour-driven testing. */
export function devcontainerContentHash(
  devcontainerDir: string,
  baseImageRef: string,
  featureIdentity?: string,
): string {
  const hash = createHash('sha256');
  const mix = (label: string, value: string | Buffer): void => {
    const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    hash.update(`${label}:${String(buf.length)}:`);
    hash.update(buf);
    hash.update('\n');
  };
  mix('base', baseImageRef);
  if (featureIdentity !== undefined) {
    mix('feature', featureIdentity);
  }
  for (const file of collectDirFiles(devcontainerDir)) {
    mix('path', file.path);
    mix('file', file.content);
  }
  return hash.digest('hex').slice(0, 12);
}

/** Sanitize an `(owner, repo)` pair into the derived-tag repository name
 *  `verity-devc-<owner>-<repo>`. Docker tags allow `[a-zA-Z0-9._-]`; any other
 *  char in owner/repo is replaced with `-` and the result lowercased so the tag
 *  is always valid regardless of the GitHub slug. */
export function devcontainerImageTag(owner: string, repo: string, hash12: string): string {
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return `${DEVCONTAINER_IMAGE_PREFIX}${clean(owner)}-${clean(repo)}:${hash12}`;
}

/** Repository-name prefix of every image {@link devcontainerImageTag} mints.
 *  Exported because the disk GC (`docker-gc.ts`) selects images to retire by this
 *  prefix: `resolveOrBuildImage` is a content-addressed cache that only ever ADDS
 *  tags (a new base image or an edited `.devcontainer/` yields a new hash, and the
 *  superseded tag is never referenced again), so something has to own the other
 *  half of that lifecycle. The prefix lives here, next to the tagger, so the two
 *  cannot drift into a GC that silently matches nothing.
 *
 *  The app mirrors this literal in `packages/mobile/src/ui/devcontainerImage.ts`
 *  to decide whether a project has a build of its own to redo (the "Rebuild
 *  image" action). It cannot import it — the mobile core does not depend on the
 *  server — so the value is pinned by a test here. Change one, change all three. */
export const DEVCONTAINER_IMAGE_PREFIX = 'verity-devc-';

/** Docker network name for a project's isolated sandbox network (security review
 *  H2). Docker network names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; sanitize the
 *  project id and prefix so it is always valid and Verity-owned. */
export function projectNetworkName(projectId: string): string {
  const clean = projectId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '');
  return `verity-proj-${clean.length > 0 ? clean : 'x'}`;
}

/**
 * The keys in `<dir>/devcontainer.json` this runtime refuses to honour, empty
 * when the file is one Verity can provision from.
 *
 * Exported for the repo's own `.devcontainer/`, which this server provisions
 * every session in: nothing else parses that file before a provision attempt,
 * so a stray comma or a rejected key would break every session for the repo
 * with no earlier signal. `provisioner.test.ts` runs this over it.
 */
export function unsupportedDevcontainerRuntimeKeys(devcontainerDir: string): string[] {
  let raw: string;
  try {
    raw = readFileNoFollow(join(devcontainerDir, 'devcontainer.json'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  const keys = devcontainerPropertyKeys(raw);
  const unsupported = UNSUPPORTED_DEVCONTAINER_RUNTIME_KEYS.filter((key) => keys.has(key));
  for (const key of ['remoteUser', 'postCreateCommand'] as const) {
    const value = topLevelJsonValue(raw, key);
    if (value !== undefined && value.kind !== 'string') {
      unsupported.push(`${key} (${value.kind})`);
    }
  }
  unsupported.push(...devcontainerMountBinds(raw).unsupported);
  return unsupported;
}

interface DevcontainerRuntimeSettings {
  remoteUser?: string;
  postCreateCommand?: string;
  binds?: string[];
}

function devcontainerRuntimeSettings(devcontainerDir: string): DevcontainerRuntimeSettings {
  const raw = readDevcontainerJson(devcontainerDir);
  if (raw === undefined) return {};
  return {
    ...topLevelStringSetting(raw, 'remoteUser', devcontainerDir),
    ...topLevelStringSetting(raw, 'postCreateCommand', devcontainerDir),
    ...devcontainerMountSettings(raw),
  };
}

function devcontainerProvisionWarning(settings: DevcontainerRuntimeSettings): string | null {
  if (settings.remoteUser?.toLowerCase() === 'root') {
    return 'Devcontainer requests remoteUser=root. The project is running, but root containers have a larger blast radius; prefer a non-root remoteUser when possible.';
  }
  return null;
}

/**
 * ADR 0006 D1. Two ways to satisfy the in-sandbox anti-forgery boundary:
 * Verity's own managed default image (known-good by construction), or ANY image
 * that passed {@link attestRunnerSupervisorBoundary} — trusted host-side evidence checks the
 * properties D1 actually names (non-root agent, reserved supervisor UID/GID the
 * agent does not hold, no-new-privileges in effect, root-owned supervisor
 * binaries). Deployment-level relaxations still veto both: added capabilities or
 * `no-new-privileges` opt-out break the boundary regardless of the image.
 *
 * `attestedBoundary` omitted means "no attestation was run", which keeps the
 * identity-only behaviour for callers that cannot attest.
 */
export function runnerSupervisorBoundarySafe(args: {
  usesManagedDefaultImage: boolean;
  allowPrivilegeEscalation: boolean;
  capAdd?: readonly string[] | undefined;
  attestedBoundary?: boolean | undefined;
}): boolean {
  if (args.allowPrivilegeEscalation) return false;
  if (!args.usesManagedDefaultImage && args.attestedBoundary !== true) return false;
  return args.capAdd === undefined || args.capAdd.length === 0;
}

function readDevcontainerJson(devcontainerDir: string): string | undefined {
  try {
    return readFileNoFollow(join(devcontainerDir, 'devcontainer.json'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function topLevelStringSetting(
  raw: string,
  key: keyof DevcontainerRuntimeSettings,
  devcontainerDir: string,
): DevcontainerRuntimeSettings {
  const found = topLevelJsonValue(raw, key);
  const value = found?.kind === 'string' ? found.value : undefined;
  if (value === undefined) return {};
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  if (key === 'remoteUser') return { remoteUser: trimmed };
  void devcontainerDir;
  return { postCreateCommand: trimmed };
}

function devcontainerMountSettings(raw: string): Pick<DevcontainerRuntimeSettings, 'binds'> {
  const parsed = devcontainerMountBinds(raw);
  return parsed.binds.length > 0 ? { binds: parsed.binds } : {};
}

function devcontainerMountBinds(raw: string): { binds: string[]; unsupported: string[] } {
  const value = topLevelJsonValue(raw, 'mounts');
  if (value === undefined) return { binds: [], unsupported: [] };
  if (value.kind !== 'array') return { binds: [], unsupported: [`mounts (${value.kind})`] };
  const mounts = topLevelStringArray(raw, 'mounts');
  if (mounts === undefined) return { binds: [], unsupported: ['mounts'] };
  const binds: string[] = [];
  for (const mount of mounts) {
    const bind = devcontainerMountBind(mount);
    if (bind === undefined) return { binds: [], unsupported: ['mounts'] };
    binds.push(bind);
  }
  return { binds, unsupported: [] };
}

function devcontainerMountBind(mount: string): string | undefined {
  const fields = new Map<string, string>();
  for (const part of mount.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) return undefined;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key.length === 0 || value.length === 0) return undefined;
    fields.set(key, value);
  }
  const unknown = [...fields.keys()].filter(
    (key) => !['source', 'src', 'target', 'dst', 'destination', 'type', 'readonly'].includes(key),
  );
  if (unknown.length > 0) return undefined;
  if (fields.get('type') !== 'volume') return undefined;
  const source = fields.get('source') ?? fields.get('src');
  const target = fields.get('target') ?? fields.get('dst') ?? fields.get('destination');
  if (source === undefined || target === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source)) return undefined;
  const containerTarget = target
    .replaceAll('${containerWorkspaceFolder}', '/work')
    .replaceAll('${workspaceFolder}', '/work');
  if (!containerTarget.startsWith('/work/')) return undefined;
  if (
    containerTarget.includes('/../') ||
    containerTarget.endsWith('/..') ||
    containerTarget.includes('//') ||
    containerTarget.includes('\\') ||
    containerTarget.includes(':')
  ) {
    return undefined;
  }
  const readonly = fields.get('readonly');
  if (readonly !== undefined && readonly !== 'true' && readonly !== 'false') return undefined;
  return readonly === 'true' ? `${source}:${containerTarget}:ro` : `${source}:${containerTarget}`;
}

function topLevelStringArray(raw: string, targetKey: string): string[] | undefined {
  let i = 0;
  let objectDepth = 0;
  const skipTrivia = (start: number): number => {
    let pos = start;
    while (pos < raw.length) {
      const ch = raw[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos += 1;
        continue;
      }
      if (raw.startsWith('//', pos)) {
        const end = raw.indexOf('\n', pos + 2);
        pos = end === -1 ? raw.length : end + 1;
        continue;
      }
      if (raw.startsWith('/*', pos)) {
        const end = raw.indexOf('*/', pos + 2);
        pos = end === -1 ? raw.length : end + 2;
        continue;
      }
      break;
    }
    return pos;
  };
  const readString = (start: number): { value: string; end: number } => {
    let pos = start + 1;
    let value = '';
    while (pos < raw.length) {
      const ch = raw[pos];
      if (ch === '\\') {
        value += raw[pos + 1] ?? '';
        pos += 2;
        continue;
      }
      if (ch === '"') return { value, end: pos + 1 };
      value += ch;
      pos += 1;
    }
    return { value, end: pos };
  };
  const readStringArray = (start: number): string[] | undefined => {
    const values: string[] = [];
    let pos = start + 1;
    while (pos < raw.length) {
      pos = skipTrivia(pos);
      if (raw[pos] === ']') return values;
      if (raw[pos] !== '"') return undefined;
      const item = readString(pos);
      values.push(item.value);
      pos = skipTrivia(item.end);
      if (raw[pos] === ',') {
        pos += 1;
        continue;
      }
      if (raw[pos] === ']') return values;
      return undefined;
    }
    return undefined;
  };
  while (i < raw.length) {
    i = skipTrivia(i);
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const key = readString(i);
    const afterKey = skipTrivia(key.end);
    if (raw[afterKey] !== ':' || objectDepth !== 1 || key.value !== targetKey) {
      i = key.end;
      continue;
    }
    const valueStart = skipTrivia(afterKey + 1);
    if (raw[valueStart] !== '[') return undefined;
    return readStringArray(valueStart);
  }
  return undefined;
}

function topLevelJsonValue(
  raw: string,
  targetKey: string,
):
  | { kind: 'string'; value: string }
  | { kind: 'array' | 'object' | 'boolean' | 'number' | 'null' }
  | undefined {
  let i = 0;
  let objectDepth = 0;
  const skipTrivia = (start: number): number => {
    let pos = start;
    while (pos < raw.length) {
      const ch = raw[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos += 1;
        continue;
      }
      if (raw.startsWith('//', pos)) {
        const end = raw.indexOf('\n', pos + 2);
        pos = end === -1 ? raw.length : end + 1;
        continue;
      }
      if (raw.startsWith('/*', pos)) {
        const end = raw.indexOf('*/', pos + 2);
        pos = end === -1 ? raw.length : end + 2;
        continue;
      }
      break;
    }
    return pos;
  };
  const readString = (start: number): { value: string; end: number } => {
    let pos = start + 1;
    let value = '';
    while (pos < raw.length) {
      const ch = raw[pos];
      if (ch === '\\') {
        value += raw[pos + 1] ?? '';
        pos += 2;
        continue;
      }
      if (ch === '"') return { value, end: pos + 1 };
      value += ch;
      pos += 1;
    }
    return { value, end: pos };
  };
  while (i < raw.length) {
    i = skipTrivia(i);
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const key = readString(i);
    const afterKey = skipTrivia(key.end);
    if (raw[afterKey] !== ':' || objectDepth !== 1 || key.value !== targetKey) {
      i = key.end;
      continue;
    }
    const valueStart = skipTrivia(afterKey + 1);
    if (raw[valueStart] === '"') return { kind: 'string', value: readString(valueStart).value };
    if (raw[valueStart] === '[') return { kind: 'array' };
    if (raw[valueStart] === '{') return { kind: 'object' };
    if (raw.startsWith('true', valueStart) || raw.startsWith('false', valueStart)) {
      return { kind: 'boolean' };
    }
    if (raw.startsWith('null', valueStart)) return { kind: 'null' };
    return { kind: 'number' };
  }
  return undefined;
}

function devcontainerPropertyKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  let i = 0;
  let objectDepth = 0;
  const skipTrivia = (start: number): number => {
    let pos = start;
    while (pos < raw.length) {
      const ch = raw[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos += 1;
        continue;
      }
      if (raw.startsWith('//', pos)) {
        const end = raw.indexOf('\n', pos + 2);
        pos = end === -1 ? raw.length : end + 1;
        continue;
      }
      if (raw.startsWith('/*', pos)) {
        const end = raw.indexOf('*/', pos + 2);
        pos = end === -1 ? raw.length : end + 2;
        continue;
      }
      break;
    }
    return pos;
  };
  const readString = (start: number): { value: string; end: number } => {
    let pos = start + 1;
    let value = '';
    while (pos < raw.length) {
      const ch = raw[pos];
      if (ch === '\\') {
        value += raw[pos + 1] ?? '';
        pos += 2;
        continue;
      }
      if (ch === '"') return { value, end: pos + 1 };
      value += ch;
      pos += 1;
    }
    return { value, end: pos };
  };
  while (i < raw.length) {
    i = skipTrivia(i);
    if (raw[i] === '{') {
      objectDepth += 1;
      i += 1;
      continue;
    }
    if (raw[i] === '}') {
      objectDepth = Math.max(0, objectDepth - 1);
      i += 1;
      continue;
    }
    if (raw[i] !== '"') {
      i += 1;
      continue;
    }
    const token = readString(i);
    const after = skipTrivia(token.end);
    if (raw[after] === ':' && objectDepth === 1) keys.add(token.value);
    i = token.end;
  }
  return keys;
}

/** Translate any thrown value into a brief failure message — never leaks the
 *  GitHub token, container id, or full volume args. Mental contract: the
 *  returned string goes into `projects.provision_error` and is visible to the
 *  mobile app, so dogfood decisions about what to surface live here. */
export function gitAuthHeader(token: string | undefined): string {
  const credential = Buffer.from(`x-access-token:${token ?? ''}`, 'utf8').toString('base64');
  return `Authorization: Basic ${credential}`;
}

function redactSensitive(message: string, values: Array<string | undefined>): string {
  let redacted = message;
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      redacted = redacted.split(value).join('[redacted]');
    }
  }
  redacted = redacted.replace(
    /Authorization: Basic [A-Za-z0-9+/=._-]+/g,
    'Authorization: Basic [redacted]',
  );
  redacted = redacted.replace(
    /Authorization: Bearer [A-Za-z0-9._-]+/g,
    'Authorization: Bearer [redacted]',
  );
  return redacted;
}

function failureMessage(error: unknown): string {
  if (error instanceof DockerError) {
    return `docker ${error.kind}: ${error.message}`;
  }
  if (error instanceof Error) {
    // Output choke so the message stays terse + safe.
    return error.message.split('\n')[0]?.slice(0, 200) ?? error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

const COMMAND_OUTPUT_TAIL_LINES = 12;
const COMMAND_OUTPUT_MAX_CHARS = 1000;

/** Actionable hint for common devcontainer failures under Verity's sandbox
 *  hardening. The raw command output often BURIES the real cause (e.g. a long
 *  successful `pip install` log before the one fatal line), so we scan the whole
 *  output for a known signature and lead the surfaced message with a concrete
 *  fix. Returns undefined when nothing matches — the caller then just shows the
 *  output tail. */
function devcontainerFailureHint(output: string): string | undefined {
  // `sudo`/root elevation blocked by the no-new-privileges hardening (audit C1).
  // The classic case: a postCreateCommand that installs tooling system-wide via
  // sudo (into /usr/local/bin), which cannot elevate in a Verity sandbox.
  if (
    /no new privileges/i.test(output) ||
    /\bsudo\b[^\n]*\b(privile|not allowed|unable to|setuid|askpass|no( |-)tty)/i.test(output)
  ) {
    return (
      'This sandbox runs with no-new-privileges (security hardening), so `sudo` cannot elevate to ' +
      'root. Change the devcontainer to install tools without sudo — e.g. into ~/.local/bin (already ' +
      'on PATH) — or set VERITY_SANDBOX_ALLOW_PRIVILEGE_ESCALATION=1 to allow sudo in sandboxes.'
    );
  }
  return undefined;
}

function commandFailureMessage(error: unknown): string {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const output = [stdout, stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n');
  const raw = output.length > 0 ? output : error instanceof Error ? error.message : String(error);
  // Surface the TAIL lines — where the real failure is — not an arbitrary
  // char-slice that leads with earlier success noise (e.g. a long install log).
  const tail = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-COMMAND_OUTPUT_TAIL_LINES)
    .join('\n')
    .slice(-COMMAND_OUTPUT_MAX_CHARS);
  const hint = devcontainerFailureHint(raw);
  return hint !== undefined ? `${hint}\n\n${tail}` : tail;
}

/** Failure message for a devcontainer build (ADR 0003 R3.1). Prefers the
 *  spawner's `stderr` (the real build's diagnostics land there, not in
 *  `.message`, which `execFile` sets to the terse `Command failed …` line) so
 *  the operator sees WHY the build failed in `provision_error`. Truncated to
 *  keep the surfaced message bounded. Falls back to {@link failureMessage} when
 *  no stderr is present (e.g. a non-`execFile` rejection). */
function buildFailureMessage(error: unknown): string {
  return commandFailureMessage(error);
}

/** Provisioning worker — drives the §19.3 transition for one project. Idempotent
 *  in the "already-active" sense: returns the canonical state if the row's
 *  state is already `active`. Throws a `ProvisioningError` carrying the failure
 *  message; the caller updates the row to `state='failed'`.
 *
 *  Caller invariant: `projectId` exists in the store. The worker re-checks
 *  inside the lock tx (race-correct against a concurrent deprovision). */
export interface Provisioner {
  provision(projectId: string, opts?: { confirmWarnings?: boolean }): Promise<ProjectRecord>;
  /** Fetch and reset the managed project checkout to its configured default branch. */
  syncProjectCheckout?(projectId: string): Promise<void>;
  provisionWarnings?(projectId: string): Promise<string[]>;
  /** Give a `local` project's clone an `origin` and publish its current branch there,
   * so the repository Verity created with `git init` becomes a GitHub repository.
   * An empty target takes the branch directly; a target that already has history gets
   * an import branch plus a pull request (see {@link LinkCloneToGitHubResult}).
   * Leaves the clone DIRECTORY where it is — session worktrees live under it. */
  linkCloneToGitHub?(
    project: ProjectRecord,
    target: { owner: string; repo: string },
    token: string | undefined,
  ): Promise<LinkCloneToGitHubResult>;
  /** Run a project mutation while new turns wait at the same admission barrier
   * used by Sandbox repair, and reject when existing work is active. */
  withProjectExclusiveMutation?<T>(projectId: string, mutation: () => Promise<T>): Promise<T>;
  /** Recreate only the project container using the existing clone path.
   * Does not fetch, reset, delete, or otherwise mutate the project worktree. */
  recreateContainer?(projectId: string, opts?: RecreateContainerOptions): Promise<ProjectRecord>;
  /** Best-effort Stage 3 watchdog: re-probe/relaunch supervisors for active
   * Sandboxes that already carry a protected runtime mount. */
  reconcileRunnerSupervisors?(projects: readonly ProjectRecord[]): Promise<void>;
  /** Stage 5 (Temporary Public Previews): migrate legacy shared-network sandboxes
   * onto their relay + project network rather than silently reusing them. No-op
   * unless relay mode is configured. */
  reconcileRelays?(
    projects: readonly ProjectRecord[],
    callbacks?: {
      onDeferred?: (projectId: string, info: { imageUpdate: boolean }) => void;
      onMigrated?: (projectId: string, info: { envDrift: boolean; imageUpdate: boolean }) => void;
      /** Projects whose running sandbox differs from the current target image.
       * They join the same busy-safe reconcile queue as relay migrations, but are
       * never allowed to spend the orphan force-repair window. */
      updateAvailable?: ReadonlySet<string>;
      /** A sandbox whose ONLY fault is env drift has exhausted
       *  `ENV_DRIFT_RECREATE_LIMIT` recreates without coming back whole, and the
       *  reconciler has stopped recreating it. Fired once per project per budget:
       *  the drift is now a standing condition to be fixed in the provisioner, not
       *  something another recreate will resolve. */
      onEnvDriftUnresolved?: (projectId: string, info: { attempts: number }) => void;
      onEnvDriftThrottled?: (info: {
        deferred: number;
        attempted: number;
        projectIds: readonly string[];
      }) => void;
      onRepaired?: (projectId: string, info: { interruptedTurn: boolean }) => void;
    },
  ): Promise<void>;
  /** Projects whose sandbox is cut off from the broker, as last classified by
   * {@link reconcileRelays}. A read of already-computed state — no Docker call —
   * so a poll-path caller can report the condition per session. Absent on
   * provisioners that do not implement relay migration. */
  disconnectedSandboxProjects?(): ReadonlySet<string>;
  /** Projects whose sandbox the automatic repair is not going to bring up to date
   * — the recreate has failed on {@link SANDBOX_SELF_REPAIR_FAILURE_LIMIT}
   * consecutive reconcile ticks, or the last tick decided there was nothing to
   * recreate at all. Read off state the reconciler already holds, so it costs no
   * Docker call like {@link disconnectedSandboxProjects}, though unlike that one
   * it unions two sets and so allocates per call. It is what lets a client tell a
   * sandbox that is merely waiting its turn from one nothing is going to fix. */
  unrepairedSandboxes?(): ReadonlySet<string>;
  /** Late-bind the per-project "turn in flight?" probe so relay migration never
   * recreates a sandbox out from under a live session (server.ts owns it). */
  attachProjectBusyProbe?(
    probe: (projectId: string, exceptSessionIds?: ReadonlySet<string>) => Promise<boolean>,
  ): void;
  /** On-demand counterpart to {@link reconcileRelays} for a turn that is BLOCKED by
   * an unusable sandbox: recreate it now (coalesced per project) and report whether
   * the sandbox is relay-ready afterwards. */
  repairSandboxForTurn?(
    projectId: string,
    requestingSessionId: string,
    queuedSessionIds?: ReadonlySet<string>,
  ): Promise<boolean>;
  /** Admission barrier for every project turn: wait while an on-demand Sandbox
   * repair owns the project, so no backend can enter the container mid-recreate. */
  waitForTurnSandboxRepair?(projectId: string, requestingSessionId: string): Promise<void>;
  /** Synchronous admission hint used by background backend resolutions, which must
   * fail fast instead of waiting for a project Sandbox rebuild. */
  turnSandboxRepairInFlight?(projectId: string): boolean;
  /** Atomically claim/release background Sandbox use against repair ownership. */
  tryBeginProjectSandboxActivity?(projectId: string): boolean;
  endProjectSandboxActivity?(projectId: string): void;
}

export class ProvisioningWarning extends Error {
  readonly warnings: string[];
  constructor(warnings: string[]) {
    super(warnings.join('\n'));
    this.name = 'ProvisioningWarning';
    this.warnings = warnings;
  }
}

function validPort(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? trimmed : null;
}

interface ProjectPortSettings {
  devServerHostPort?: string | null;
  devServerContainerPort?: string | null;
}

function projectPortBindings(
  settings: unknown,
): Array<{ hostPort: string; containerPort: string }> {
  const candidates = Array.isArray(settings)
    ? (settings as ProjectPortSettings[])
    : [settings as ProjectPortSettings | undefined];
  const seen = new Map<string, string>();
  const bindings: Array<{ hostPort: string; containerPort: string }> = [];
  for (const portSettings of candidates) {
    const hostPort = validPort(portSettings?.devServerHostPort);
    const containerPort = validPort(portSettings?.devServerContainerPort);
    if (!hostPort || !containerPort) continue;
    const existingContainerPort = seen.get(hostPort);
    if (existingContainerPort !== undefined) {
      if (existingContainerPort === containerPort) continue;
      throw new Error(
        `duplicate dev server host port ${hostPort} maps to both ${existingContainerPort} and ${containerPort}`,
      );
    }
    seen.set(hostPort, containerPort);
    bindings.push({ hostPort, containerPort });
  }
  return bindings;
}

function agentConfigBinds(
  opts: Pick<
    ProvisionerOptions,
    'claudeConfigVolume' | 'codexConfigVolume' | 'opencodeConfigVolume' | 'piConfigVolume'
  >,
  mode: 'home' | 'neutral' = 'home',
): string[] {
  const paths =
    mode === 'neutral'
      ? {
          opencode: '/run/verity/xdg/opencode',
          pi: '/run/verity/pi',
        }
      : {
          opencode: '/home/dev/.config/opencode',
          pi: '/home/dev/.pi',
        };
  return [
    // Subscription credentials are server-owned now and materialized from Verity
    // settings below. Do not mount legacy shared config volumes into project
    // sandboxes, or a clean server can inherit stale credentials from an older
    // dogfood container.
    ...(opts.opencodeConfigVolume !== undefined
      ? [`${opts.opencodeConfigVolume}:${paths.opencode}`]
      : []),
    ...(opts.piConfigVolume !== undefined ? [`${opts.piConfigVolume}:${paths.pi}`] : []),
  ];
}
function writeSecretFile(
  root: string,
  name: string,
  contents: string,
  subdir = 'git',
  mode = 0o600,
): string {
  const dir = join(root, subdir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents.endsWith('\n') ? contents : `${contents}\n`, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return path;
}

/** Non-secret custom-provider config. The sandbox receives only a fixed dummy
 * bearer; the gateway owns the subscription login and refresh authority. */
export function codexGatewayConfig(connectorPort: number): string {
  if (!Number.isInteger(connectorPort) || connectorPort < 1 || connectorPort > 65_535) {
    throw new Error('Codex gateway config requires a valid connector port');
  }
  return [
    'model_provider = "verity_gateway"',
    '[model_providers.verity_gateway]',
    'name = "Verity Gateway"',
    `base_url = "http://127.0.0.1:${String(connectorPort)}/codex"`,
    'env_key = "VERITY_CODEX_PLACEHOLDER"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
  ].join('\n');
}

function codexGatewayConfigBind(
  secretRoot: string | undefined,
  codexHome: string,
  connectorPort: number | undefined,
): string[] {
  if (!secretRoot || connectorPort === undefined) return [];
  const config = codexGatewayConfig(connectorPort);
  const path = writeSecretFile(secretRoot, 'config.toml', config, 'codex', 0o644);
  return [`${path}:${codexHome}/config.toml:ro`];
}

function gitSettingsBinds(
  settings: VeritySettingsRecord | undefined,
  secretRoot: string | undefined,
  mode: 'home' | 'neutral' = 'home',
): string[] {
  const binds: string[] = [];
  const includeHome = mode === 'home';
  // The private signing key is NEVER mounted into a sandbox. Signing is broker-only
  // (audit H4/H5): git's `gpg.ssh.program` wrapper forwards the payload to the
  // server's POST /internal/git/sign, which holds the key. The legacy mounted-key
  // compatibility path (ADR 0002 — "compatibility file", replaced by the broker) is
  // removed. Only the non-secret public key + known_hosts + allowed_signers mount,
  // so git has `user.signingkey` and local `--show-signature` verification works.
  const publicSigningKeyFileName = 'id_ed25519.pub';
  const gitSecretSubdir = 'git';
  const publicKeyPath =
    settings?.gitSshPublicKey && secretRoot
      ? writeSecretFile(
          secretRoot,
          publicSigningKeyFileName,
          settings.gitSshPublicKey,
          gitSecretSubdir,
          0o644,
        )
      : settings?.gitSshPublicKeyPath;
  if (publicKeyPath) {
    // The public key is what `user.signingkey` points at; mount it at both
    // conventions too (see the private-key note above). ssh-keygen -Y sign reads
    // the private key sitting next to it in the same dir.
    if (includeHome) binds.push(`${publicKeyPath}:/home/dev/.ssh/id_ed25519.pub:ro`);
    binds.push(`${publicKeyPath}:/run/verity/ssh/id_ed25519.pub:ro`);
  }
  const knownHostsPath =
    settings?.gitKnownHosts && secretRoot
      ? writeSecretFile(secretRoot, 'known_hosts', settings.gitKnownHosts, 'git', 0o644)
      : settings?.gitKnownHostsPath;
  if (knownHostsPath) {
    if (includeHome) binds.push(`${knownHostsPath}:/home/dev/.ssh/known_hosts:ro`);
    binds.push(`${knownHostsPath}:/run/verity/ssh/known_hosts:ro`);
  }
  const allowedSignersPath =
    settings?.gitAllowedSigners && secretRoot
      ? writeSecretFile(secretRoot, 'allowed_signers', settings.gitAllowedSigners, 'git', 0o644)
      : settings?.gitAllowedSignersPath;
  if (allowedSignersPath) {
    if (includeHome) binds.push(`${allowedSignersPath}:/home/dev/.ssh/allowed_signers:ro`);
    binds.push(`${allowedSignersPath}:/run/verity/ssh/allowed_signers:ro`);
  }
  return binds;
}

function gitSettingsEnv(settings: VeritySettingsRecord | undefined): string[] {
  const env: string[] = [];
  if (settings?.gitUserName) env.push(`GIT_USER_NAME=${settings.gitUserName}`);
  if (settings?.gitUserEmail) env.push(`GIT_USER_EMAIL=${settings.gitUserEmail}`);
  return env;
}

type VolumeMount = NonNullable<ContainerSpec['volumeMounts']>[number];

/**
 * Split `host:target[:mode]` bind strings into the mounts a sibling sandbox can
 * actually resolve. Every bind whose host path lives under `dataVolumeRoot` (the
 * per-project `/work` clone + the materialized secrets, all inside the named data
 * volume) becomes a NAMED-VOLUME mount with a subpath relative to the volume root,
 * so the source resolves by volume name on the host daemon — no host-path
 * knowledge, no pre-created host dir. Every other bind (deploy-level: the agent-seed
 * toolkit, `/dev/null`, devcontainer mounts) stays a host bind. With no data volume
 * configured, all binds pass through unchanged.
 */
/**
 * Freeze the clone's `.git/config` against the sandbox, for `local` projects.
 *
 * `/work` is mounted read-write — a session has to be able to commit — and that
 * includes the repository's own config, where keys like `filter.<name>.clean`,
 * `merge.<name>.driver`, `diff.<name>.textconv` and `core.fsmonitor` all name a
 * program git runs. Verity still drives git against that same clone from the SERVER
 * for a `local` project (reading the base branch for the merge affordance, adding
 * session worktrees), so a config the sandbox can rewrite is a way to have the server
 * run a program of the sandbox's choosing. Laying a read-only mount over the single
 * file removes the write: `git config` replaces it by renaming a lock file over the
 * path, and rename onto a mount point fails, as does unlinking it.
 *
 * Only that one file, and only for `local` projects:
 *
 * - `.git` as a whole cannot be read-only — commits write `objects/` and `refs/`, and
 *   the index needs `index.lock` — so the file is the largest unit that can be frozen.
 * - `config.worktree` (per-worktree config) stays writable, but git only reads it when
 *   `extensions.worktreeConfig` is set in `.git/config`, which is now frozen. Same for
 *   `include.path`: the sandbox can no longer add one.
 * - A GitHub-backed project keeps a writable config. Its sessions legitimately
 *   configure their own repository, and it merges through a pull request rather than
 *   through Verity driving git over the clone.
 *
 * Host-side writes still land (they bypass the container's mount namespace) but become
 * invisible to a RUNNING container. The only one during a container's life is
 * `linkCloneToGitHub`, and that route recreates the container immediately afterwards —
 * at which point the project is no longer `local` and the mount is gone anyway.
 *
 * Skipped when the file is missing, so a half-prepared clone fails on its own terms
 * instead of on a container-create error about an unresolvable mount source.
 *
 * Freezing alone would only preserve whatever is already in the file — a project
 * provisioned before this existed may carry entries its sandbox wrote. The content is
 * therefore reduced to {@link FROZEN_LOCAL_CONFIG_KEYS} first; see
 * {@link ProvisionerImpl.sanitizeLocalCloneConfig}.
 */
function localCloneConfigBind(
  project: ProjectRecord,
  clonePath: string,
  state: LocalConfigState,
): string[] {
  if (!isLocalProject(project)) return [];
  return state === 'file' ? [`${clonePath}/.git/config:/work/.git/config:ro`] : [];
}

/**
 * What `<clone>/.git/config` turns out to be on disk.
 *
 * - `absent` — nothing there, and specifically ENOENT. A half-prepared clone; skipped on
 *   both paths. Any other error reading it is `unsafe`, not `absent`: skipping past a
 *   file that cannot be read would provision the sandbox with an unexamined, writable
 *   config, which is the boundary this exists to hold.
 * - `file` — a regular file inside the clone's own `.git`, which is the only thing
 *   Verity ever puts there and the only shape it will read and freeze.
 * - `unsafe` — anything else, and specifically a symlink: the sandbox can replace this
 *   path, and both users of it are privileged. `git config --file` would REWRITE the
 *   link's target as the server's user, and the bind mount would publish that target
 *   into the container. Neither may be attempted on a guess about where it points.
 */
export type LocalConfigState = 'absent' | 'file' | 'unsafe';

/** Default {@link ProvisionerOptions.localConfigState}: a probe that follows no link. */
function inspectLocalConfig(clonePath: string): LocalConfigState {
  const file = `${clonePath}/.git/config`;
  let stat: Stats;
  try {
    stat = lstatSync(file); // deliberately not statSync: the last component is not followed
  } catch (error) {
    // Only "there is nothing there" is absent. A permission error, an I/O error, a parent
    // that is not a directory — those are a file this cannot read, and an unreadable file
    // is not one to skip past: skipping means provisioning a sandbox with a writable,
    // unexamined config, which is the boundary this exists to hold.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe';
  }
  // A symlink, a directory, a fifo — a regular file is the only thing that is this file.
  if (!stat.isFile()) return 'unsafe';
  // `lstat` only declines to follow the LAST component, so `.git` itself could be a link
  // to somewhere else entirely. Resolving the whole path settles where the file lives.
  try {
    return realpathSync(file) === `${realpathSync(clonePath)}/.git/config` ? 'file' : 'unsafe';
  } catch {
    return 'unsafe';
  }
}

/**
 * Everything a `local` clone's `.git/config` is allowed to keep — an ALLOWLIST, not a
 * denylist of the keys that name a program.
 *
 * A denylist has to enumerate every way a config value reaches an exec: hooks, the
 * fsmonitor, `filter.*`, `diff.*.textconv`, `merge.*.driver`, `credential.helper`,
 * `*.sshCommand`, an `ext::` remote URL, a submodule's `update = !cmd`, plus whatever
 * a later git adds. Listing what may STAY inverts that: a key nobody thought about is
 * dropped rather than kept, and the file after the pass is one Verity fully describes.
 *
 * These are the keys `git init` writes (the platform-dependent ones included) plus the
 * repository-format extensions, which describe how the object store is READ — dropping
 * `extensions.objectFormat` from a SHA-256 repository would make it unreadable.
 * `extensions.worktreeConfig` is deliberately absent: it is what makes the per-worktree
 * `config.worktree` file — which stays writable — take effect.
 *
 * A local project has no remote by design, so `remote.*` and `branch.*` go too. So does
 * an identity a session set on the repository: the sandbox's git identity comes from the
 * agent seed's global config, which this never touches.
 *
 * The VALUE is allowlisted with the key. A name alone would let a sandbox freeze
 * `core.bare = true` or `extensions.objectFormat = whatever` into a repository that
 * afterwards cannot be opened — the freeze makes that permanent, which is the same
 * damage from the other side. A value outside its set is dropped with the key, so git's
 * own default applies instead: for a value git would refuse anyway, that loses nothing.
 */
const CONFIG_BOOLEANS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  '1',
  '0',
]);

const FROZEN_LOCAL_CONFIG_KEYS = new Map<string, ReadonlySet<string>>([
  ['core.repositoryformatversion', new Set(['0', '1'])],
  ['core.filemode', CONFIG_BOOLEANS],
  // A managed clone is a working checkout — sessions commit in worktrees of it and
  // Verity merges in it — so only the false half is a value this repository can have.
  // Frozen at `true` it would have no worktree at all.
  ['core.bare', new Set(['false', 'no', 'off', '0'])],
  ['core.logallrefupdates', CONFIG_BOOLEANS],
  ['core.symlinks', CONFIG_BOOLEANS],
  ['core.ignorecase', CONFIG_BOOLEANS],
  ['core.precomposeunicode', CONFIG_BOOLEANS],
  ['extensions.objectformat', new Set(['sha1', 'sha256'])],
  ['extensions.compatobjectformat', new Set(['sha1', 'sha256'])],
  ['extensions.refstorage', new Set(['files', 'reftable'])],
]);

/** One `key = value` line of a config file, as git listed it. `value` is absent for a
 *  key written without one, which git reads as a boolean true. */
type ConfigEntry = { name: string; value?: string };

/**
 * The names in `entries` {@link FROZEN_LOCAL_CONFIG_KEYS} does not cover, plus the ones
 * it covers carrying a value it does not.
 *
 * git prints section and key lowercased but preserves a subsection's case, so the
 * comparison is case-insensitive while the returned name stays the one git matches on.
 * Names are returned once each: `--unset-all` drops every value a key has, so a key with
 * one bad value among several goes entirely.
 */
function configKeysToDrop(entries: readonly ConfigEntry[]): string[] {
  const drop = entries.filter(({ name, value }) => {
    const allowed = FROZEN_LOCAL_CONFIG_KEYS.get(name.toLowerCase());
    return allowed === undefined || value === undefined || !allowed.has(value.trim().toLowerCase());
  });
  return [...new Set(drop.map(({ name }) => name))];
}

function partitionProjectMounts(
  binds: string[],
  dataVolume: string | undefined,
  dataVolumeRoot: string | undefined,
): { binds: string[]; volumeMounts: VolumeMount[] } {
  if (
    dataVolume === undefined ||
    dataVolume.length === 0 ||
    dataVolumeRoot === undefined ||
    dataVolumeRoot.length === 0
  ) {
    return { binds, volumeMounts: [] };
  }
  const root = dataVolumeRoot.replace(/\/+$/, '');
  const outBinds: string[] = [];
  const volumeMounts: VolumeMount[] = [];
  for (const bind of binds) {
    // host + target are absolute paths (no colons); an optional trailing mode is
    // `ro`/`rw`. `host:target`, `host:target:ro`.
    const parts = bind.split(':');
    const host = parts[0] ?? '';
    const target = parts[1] ?? '';
    const readOnly = parts[2] === 'ro';
    if (host === root) {
      // A mount source that IS the volume root would expose the WHOLE volume (every
      // project's workspace + all secrets) into one sandbox — never intended. No
      // current call site produces this (clone/secret paths are always subdirs);
      // refuse it defensively rather than silently mounting the whole volume.
      throw new Error(
        `refusing to mount the entire data volume root '${root}' into a sandbox (target ${target})`,
      );
    }
    if (host.startsWith(`${root}/`)) {
      volumeMounts.push({
        volume: dataVolume,
        target,
        subpath: host.slice(root.length + 1),
        readOnly,
      });
    } else {
      outBinds.push(bind);
    }
  }
  return { binds: outBinds, volumeMounts };
}

export async function stopAndRemoveExistingContainer(
  docker: DockerClient,
  containerName: string,
): Promise<void> {
  for (const operation of [
    () => docker.stopContainer(containerName),
    () => docker.removeContainer(containerName),
  ]) {
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
    }
  }
}

export class ProvisionerImpl implements Provisioner {
  private readonly git: GitRunner;
  private readonly containerCommand: ContainerCommandRunner;
  private readonly isDir: (p: string) => boolean;
  private readonly localConfigState: (clonePath: string) => LocalConfigState;
  /** In-process single-flight gate: at most ONE provisioning run per project.
   *  The DB row lock only serializes the short state transitions — the long
   *  clone/create/exec I/O runs outside it, so two concurrent repair requests
   *  used to drive full container phases in parallel against the SAME container
   *  name: the loser's failure handler then stopped+removed the winner's
   *  freshly started container, and both surfaced misleading errors. Concurrent
   *  `provision` calls now coalesce onto the running attempt's promise. */
  private readonly inFlightProvisions = new Map<string, Promise<ProjectRecord>>();
  /** Per-project tail promises serialize managed-checkout fetch/reset operations.
   *  Unlike provisioning single-flight, every queued synchronization must run:
   *  a later request may correspond to a newer merge that was not visible when
   *  the preceding fetch began. */
  private readonly projectCheckoutOperationTails = new Map<string, Promise<void>>();

  private async serializeProjectCheckoutOperation<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.projectCheckoutOperationTails.get(projectId) ?? Promise.resolve();
    const attempt = previous.then(operation);
    // The stored tail always settles successfully so a failed operation does not
    // poison later queued work. The caller still observes `attempt`'s own error.
    const tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    this.projectCheckoutOperationTails.set(projectId, tail);
    try {
      return await attempt;
    } finally {
      if (this.projectCheckoutOperationTails.get(projectId) === tail) {
        this.projectCheckoutOperationTails.delete(projectId);
      }
    }
  }

  /**
   * ADR 0006 D1 attestation for images Verity did not build (see
   * `runner-boundary-attestation.ts`). Returns `undefined` when no attestation
   * applies — the managed default image is trusted by construction, and a
   * deployment that already relaxed the boundary (privilege escalation or added
   * capabilities) is denied by {@link runnerSupervisorBoundarySafe} regardless,
   * so collecting a stopped image snapshot would only add work.
   */
  private async attestRunnerBoundary(args: {
    imageRef: string;
    skip: boolean;
    user?: string | undefined;
  }): Promise<RunnerBoundaryAttestation | undefined> {
    if (args.skip) return undefined;
    if (this.opts.sandboxAllowPrivilegeEscalation === true) return undefined;
    if (this.opts.sandboxCapAdd !== undefined && this.opts.sandboxCapAdd.length > 0) {
      return undefined;
    }
    const dockerHost = this.opts.dockerHostForBuild;
    if (dockerHost === undefined) {
      return { ok: false, reason: 'no Docker host is configured for trusted image attestation' };
    }
    return attestRunnerSupervisorBoundary({
      imageRef: args.imageRef,
      dockerHost,
      runnerUid: this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID,
      runtimeGid: this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID,
      ...(args.user !== undefined ? { user: args.user } : {}),
      ...(this.opts.imageEvidenceCollector !== undefined
        ? { evidenceCollector: this.opts.imageEvidenceCollector }
        : {}),
      ...(this.opts.runnerBoundaryFeatureDir !== undefined
        ? { featureDir: this.opts.runnerBoundaryFeatureDir }
        : {}),
    });
  }

  private prepareRunnerRuntime(projectId: string, enabled: boolean): string | undefined {
    if (!enabled) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(projectId)) {
      throw new ProvisioningError('Runner supervisor received an invalid project id');
    }
    const root = this.opts.dataVolumeRoot;
    if (root === undefined || root.length === 0) {
      throw new ProvisioningError('Runner supervisor requires dataVolumeRoot');
    }
    const path = join(root, 'runners', projectId);
    const uid = this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID;
    const gid = this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID;
    if (this.opts.prepareRunnerRuntime !== undefined) {
      this.opts.prepareRunnerRuntime(path, { uid, gid });
    } else {
      const rootStats = lstatSync(root);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new ProvisioningError('Runner supervisor dataVolumeRoot is not a real directory');
      }
      const runners = join(root, 'runners');
      try {
        mkdirSync(runners, { mode: 0o750 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const runnersStats = lstatSync(runners);
      if (!runnersStats.isDirectory() || runnersStats.isSymbolicLink()) {
        throw new ProvisioningError('Runner supervisor parent is not a real directory');
      }
      try {
        mkdirSync(path, { mode: 0o770 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const serverUid = process.getuid?.();
      const serverGid = process.getgid?.();
      if (serverUid === undefined || serverGid === undefined) {
        throw new ProvisioningError('Runner supervisor ownership requires numeric server ids');
      }
      const pathStats = lstatSync(path);
      if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) {
        throw new ProvisioningError('Runner supervisor runtime is not a directory');
      }
      if (pathStats.uid === serverUid && (pathStats.mode & 0o400) === 0) {
        // Existing hardened runtimes clear the owner read bit (legacy 0070, current
        // 0170): the Server still owns the inode but cannot open it for reading on
        // this no-follow fd until owner read is briefly restored.
        chmodSync(path, 0o700);
      }
      // Pre-create the Server-written runtime subdirectories HERE, while the owner
      // still has write. The hardening below leaves the Server — which owns the
      // inode — with a bare traverse bit, so a LAZY mkdir from the turn path fails
      // with EACCES for the rest of the runtime's life: `ServerCodexTranscript`
      // materializes rollouts into "<runtime>/codex-sessions" via `mkdir -p` at
      // resume time, which killed every Codex turn for the project. Owner-only
      // 0700 is deliberate and matches what "<runtime>/claude" already relies on —
      // the sandbox agent shares uid 1000 with the Server, so it reaches these
      // through the owner bits, and the Runner gid gains nothing it needs.
      for (const child of [RUNNER_CLAUDE_HOME_DIRNAME, RUNNER_CODEX_SESSIONS_DIRNAME]) {
        const childPath = join(path, child);
        try {
          mkdirSync(childPath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        // An existing entry is NOT trusted: the Runner gid has write on the parent,
        // so it can plant a symlink here that would redirect the Server's transcript
        // and rollout writes outside the runtime. Reject anything that is not a real,
        // Server-owned directory (no-follow, like every other check on this path) and
        // reconcile the mode instead of inheriting whatever was left behind.
        const childStats = lstatSync(childPath);
        if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
          throw new ProvisioningError('Runner supervisor runtime subdirectory is not a directory');
        }
        if (childStats.uid !== serverUid) {
          throw new ProvisioningError('Runner supervisor runtime subdirectory is not Server-owned');
        }
        chmodSync(childPath, 0o700);
      }
      const fd = openSync(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      try {
        if (!fstatSync(fd).isDirectory()) {
          throw new ProvisioningError('Runner supervisor runtime is not a directory');
        }
        // The non-root Server does not receive effective CAP_CHOWN even when the
        // container is created with cap_add. Keep the directory Server-owned and
        // grant read/write only through the Runner runtime gid. The owner keeps a
        // bare traverse bit (0170, --x): no read, no write. The sandbox agent
        // shares uid 1000 with the Server, and the runner-supervisor path points
        // CLAUDE_CONFIG_DIR at "<runtime>/claude" (stage-5b transcript capture), so
        // the agent must be able to descend to that Server-created subdirectory —
        // without --x it cannot traverse in, and every session-env mkdir there
        // fails with EACCES. Traverse-only still denies the agent any read/write of
        // the Runner's own control files here (they are group-1101 owned).
        fchownSync(fd, -1, gid);
        fchmodSync(fd, 0o170);
      } finally {
        closeSync(fd);
      }
    }
    return path;
  }

  constructor(private readonly opts: ProvisionerOptions) {
    if (opts.docker.ensureNetwork === undefined) {
      throw new ProvisioningError('project relay provisioning requires Docker network creation');
    }
    try {
      const gateway = new URL(opts.claudeEgressGatewayUrl);
      if (gateway.protocol !== 'https:' || gateway.hostname === '') throw new Error('invalid');
      const codexGateway = resolvedCodexGatewayUrl(
        opts.claudeEgressGatewayUrl,
        opts.codexEgressGatewayUrl,
      );
      if (codexGateway.protocol !== 'https:' || codexGateway.hostname === '')
        throw new Error('invalid');
    } catch (cause) {
      throw new ProvisioningError('project relay gateway URL is invalid', cause);
    }
    this.git = opts.git ?? defaultGitRunner;
    this.containerCommand = opts.containerCommand ?? defaultContainerCommandRunner;
    this.isDir =
      opts.isDirectory ??
      ((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    this.localConfigState = opts.localConfigState ?? inspectLocalConfig;
  }

  async reconcileRunnerSupervisors(projects: readonly ProjectRecord[]): Promise<void> {
    const runtimeRoot = this.opts.dataVolumeRoot;
    const supervisorEnabled = this.opts.runnerSupervisor === true && runtimeRoot !== undefined;
    const connectorEnabled =
      this.opts.claudeEgressIdentity !== undefined &&
      this.opts.claudeEgressGatewayUrl !== undefined &&
      this.opts.claudeConnectorPort !== undefined &&
      this.opts.gitSecretRoot !== undefined;
    if ((!supervisorEnabled && !connectorEnabled) || this.opts.dockerHostForBuild === undefined)
      return;
    const dockerHost = this.opts.dockerHostForBuild;
    const outcomes = await Promise.all(
      projects
        .filter((project) => project.state === 'active' && project.kind !== 'control_plane')
        .map(async (project) => {
          const hasRunnerRuntime =
            supervisorEnabled &&
            runtimeRoot !== undefined &&
            this.isDir(join(runtimeRoot, 'runners', project.id));
          if (!hasRunnerRuntime && !connectorEnabled) return undefined;
          try {
            await this.containerCommand({
              containerName: project.containerName,
              dockerHost,
              user: hasRunnerRuntime
                ? `0:${String(this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`
                : `${String(this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID)}:${String(this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`,
              workdir: hasRunnerRuntime ? RUNNER_RUNTIME_TARGET : '/',
              command: hasRunnerRuntime
                ? 'verity-runner-stack-start'
                : 'verity-egress-connector-start --standalone',
              timeoutMs: 12_000,
            });
            return undefined;
          } catch (error) {
            return error;
          }
        }),
    );
    const failures = outcomes.filter((outcome) => outcome !== undefined);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Runner supervisor reconciliation failed for ${String(failures.length)} project(s)`,
      );
    }
  }

  /** Late-bound "is a turn in flight for this project?" probe. server.ts owns the
   *  conductor, so it attaches this after the app is built. Until it does — and if
   *  it ever throws — migration treats the project as BUSY, so an automated
   *  recreate can never stop a sandbox out from under a session it cannot prove
   *  idle (SBX-1). */
  private projectBusyProbe?: (
    projectId: string,
    exceptSessionIds?: ReadonlySet<string>,
  ) => Promise<boolean>;

  /** Per project, how many consecutive reconcile ticks have deferred an ORPHAN
   *  repair because the project was busy. Bounds that deferral (see
   *  `ORPHAN_DEFER_TICK_LIMIT`). Each pass rewrites the map to exactly the
   *  projects that deferred on it against a CONFIRMED turn, so a tick the project
   *  sat out for any other reason — repaired, healthy, inactive, provisioning,
   *  errored, gone from the project list, or busy only because the probe could not
   *  answer — breaks the streak and can never leave a stale entry behind.
   *  In-memory on purpose: the incoming process re-probes and resumes each relay,
   *  so a stale deferral count would carry no useful evidence across a restart. */
  private readonly orphanDeferrals = new Map<string, number>();

  /** Per project, how many recreates this process has already spent on env drift
   *  ALONE. Bounds that recreate (see `ENV_DRIFT_RECREATE_LIMIT`), because it is
   *  the one repair with no proof that it fixes what it is repairing: unlike a
   *  network or generation, the env a recreated sandbox comes back with is decided
   *  by this deployment's configuration, not by the recreate. Unlike
   *  {@link orphanDeferrals} the count is CUMULATIVE, not a consecutive streak —
   *  the failure mode it guards against is a project recreated over and over, and
   *  an intervening healthy tick that resets the counter would just be the loop
   *  taking a breath. Cleared when the project classifies `migrated`, which is the
   *  one observation that says the drift is actually gone — and by nothing else, so
   *  that a project which merely sat a reconcile pass out is not refunded.
   *
   *  In-memory, so a restart hands every project a fresh budget. That is a real
   *  limit and is accepted: the budget's job is to stop a once-a-minute timer from
   *  rebuilding the fleet unattended between the moment a bad cohort ships and the
   *  moment somebody reads the `log.error` it raises, and it does that. A server
   *  restarting often enough to matter would be reporting far louder problems. */
  private readonly envDriftRecreates = new Map<string, number>();

  /** Projects whose exhausted drift budget has already been reported. Kept apart
   *  from {@link envDriftRecreates} rather than encoded as a count past the limit:
   *  the counter is written from two call sites that know nothing about reporting,
   *  so a sentinel value there would be one refactor away from suppressing the one
   *  error line that says a fleet-wide cohort is misdeclared. Cleared with the
   *  budget, by the sandbox coming back whole. */
  private readonly envDriftReported = new Set<string>();

  /** Has this project used up its env-drift recreates? Shared by the reconcile tick
   *  and the turn-time repair on purpose: the two are separate loop drivers over the
   *  same container, and a budget only one of them respects is not a budget. A
   *  session that retries a blocked turn would otherwise rebuild the sandbox on
   *  every attempt, which is the same churn from the client side. */
  private envDriftBudgetSpent(projectId: string): boolean {
    return (this.envDriftRecreates.get(projectId) ?? 0) >= ENV_DRIFT_RECREATE_LIMIT;
  }

  /** Charge one recreate to this project's drift budget. Call AFTER the recreate
   *  completed: a recreate that threw says nothing about the drift. */
  private noteEnvDriftRecreate(projectId: string): void {
    this.envDriftRecreates.set(projectId, (this.envDriftRecreates.get(projectId) ?? 0) + 1);
  }

  /** Projects whose sandbox the last reconcile pass classified `orphaned`: it is
   *  running and intact but cut off from the broker, so every brokered call from
   *  inside it — signing, GitHub token, secrets, egress — is refused. Either its
   *  `verity.container-generation` is no longer the one this process serves, or
   *  that generation's relay container has exited; the two are the same failure
   *  from inside the sandbox. Written by the reconciler that already computes the
   *  classification, so reading it costs a `Set.has` and never touches Docker.
   *
   *  Kept so the condition can be REPORTED, not only acted on. Acting on it is
   *  deferrable — a turn in flight holds the recreate off — and it is exactly
   *  then that an operator is staring at a session whose every brokered call
   *  fails for no visible reason. In-memory for the same reason as
   *  {@link orphanDeferrals}: the next process reclassifies from Docker. */
  private readonly disconnectedSandboxes = new Set<string>();

  /** Per project, how many CONSECUTIVE reconcile passes have tried to recreate its
   *  sandbox and failed. Past {@link SANDBOX_SELF_REPAIR_FAILURE_LIMIT} the
   *  automatic repair is reported as stalled, which is what turns a sandbox that
   *  is merely behind into one an operator has to look at.
   *
   *  Only a failed recreate counts. Deferring around a live turn is the repair
   *  working as designed, and a classify/probe that threw never produced a verdict
   *  to fail at — counting either would make the report fire on exactly the
   *  transient conditions it exists to filter out.
   *
   *  In-memory like its two neighbours: the next process establishes its own
   *  health verdict, so a failure streak from before it says nothing afterward. */
  private readonly sandboxRepairFailures = new Map<string, number>();

  /** Projects whose last automatic recreate persisted `state: failed`. Kept
   * separate from {@link sandboxRepairFailures}: a deferral or unknown probe must
   * break the CONSECUTIVE failure streak without making the failed project
   * ineligible for the next automatic retry. */
  private readonly pendingSandboxRepairRetries = new Set<string>();

  /** Projects whose sandbox the last completed reconcile pass looked at and left
   *  alone — classified `migrated`, `absent` or `foreign`, so `decideMigrationAction`
   *  returned something other than `migrate`/`defer`.
   *
   *  This set is what makes "Verity is still working on it" an honest claim rather
   *  than a hope. The reconciler decides from relay generation and network topology,
   *  NOT from image staleness: a sandbox with a live relay on its own network is
   *  `migrated` and stays untouched no matter how far its image has drifted from the
   *  current default. A Server update first resumes the existing generation so an
   *  active turn is not interrupted, then the update checker feeds image drift back
   *  into this queue for replacement once idle. A project in this set whose
   *  update check says `available` is exactly that case: behind, and not going to be
   *  repaired without someone acting. */
  private readonly settledSandboxes = new Set<string>();

  /** Turn-time sandbox repairs in flight, keyed by project. Several sessions can
   *  discover the same unusable Sandbox within the same second; they must share ONE
   *  recreate rather than each racing a stop/remove against the others. */
  private readonly turnSandboxRepairs = new Map<
    string,
    { promise: Promise<boolean>; requestingSessionIds: Set<string> }
  >();
  private readonly projectSandboxActivities = new Map<string, number>();

  attachProjectBusyProbe(
    probe: (projectId: string, exceptSessionIds?: ReadonlySet<string>) => Promise<boolean>,
  ): void {
    this.projectBusyProbe = probe;
  }

  /**
   * Make a project's Sandbox usable for a turn that needs its relay, and report
   * whether it now is.
   *
   * The periodic reconciler already repairs legacy and orphaned sandboxes, but it
   * runs on a timer and DEFERS around in-flight turns — so a turn that is itself
   * blocked by the broken Sandbox cannot be rescued by it: the turn keeps the
   * project busy, the repair keeps deferring. Repairing on demand closes that loop
   * by excluding the requesting session from the busy probe. Any OTHER active
   * session still blocks the recreate, so one turn can never tear the Sandbox down
   * under unrelated work.
   *
   * Idle-safe and idempotent: an already-migrated Sandbox is reported ready without
   * touching it, a `foreign` container is never touched at all, and a provision or
   * recreate already in flight is awaited instead of raced.
   */
  async repairSandboxForTurn(
    projectId: string,
    requestingSessionId: string,
    queuedSessionIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    const existing = this.turnSandboxRepairs.get(projectId);
    if (existing !== undefined) {
      existing.requestingSessionIds.add(requestingSessionId);
      for (const sessionId of queuedSessionIds ?? []) {
        existing.requestingSessionIds.add(sessionId);
      }
      return existing.promise;
    }
    const requestingSessionIds = new Set([requestingSessionId, ...(queuedSessionIds ?? [])]);
    const attempt = this.repairSandboxForTurnOnce(projectId, requestingSessionIds);
    this.turnSandboxRepairs.set(projectId, { promise: attempt, requestingSessionIds });
    try {
      return await attempt;
    } finally {
      this.turnSandboxRepairs.delete(projectId);
    }
  }

  async waitForTurnSandboxRepair(projectId: string, requestingSessionId: string): Promise<void> {
    // This is an admission barrier, not a repair result consumer. The Claude turn
    // that owns the repair reports its failure; unrelated queued turns merely need
    // to wait until container mutation has stopped, then perform their own normal
    // readiness checks.
    const repair = this.turnSandboxRepairs.get(projectId);
    if (repair === undefined) return;
    // A turn admitted after repair ownership was established cannot enter the
    // Sandbox: it is waiting on this promise. Register it as a participant so the
    // live busy probe does not mistake that queued turn for unrelated work and
    // cancel the repair it is already waiting for.
    repair.requestingSessionIds.add(requestingSessionId);
    await repair.promise.catch(() => undefined);
  }

  turnSandboxRepairInFlight(projectId: string): boolean {
    return this.turnSandboxRepairs.has(projectId);
  }

  tryBeginProjectSandboxActivity(projectId: string): boolean {
    if (this.turnSandboxRepairs.has(projectId)) return false;
    this.projectSandboxActivities.set(
      projectId,
      (this.projectSandboxActivities.get(projectId) ?? 0) + 1,
    );
    return true;
  }

  endProjectSandboxActivity(projectId: string): void {
    const remaining = (this.projectSandboxActivities.get(projectId) ?? 1) - 1;
    if (remaining <= 0) this.projectSandboxActivities.delete(projectId);
    else this.projectSandboxActivities.set(projectId, remaining);
  }

  async withProjectExclusiveMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    if (this.turnSandboxRepairs.has(projectId) || this.inFlightProvisions.has(projectId)) {
      throw new ProvisioningError(`project ${projectId} already has a mutation in progress`);
    }
    let releaseBarrier!: (result: boolean) => void;
    const barrier = new Promise<boolean>((resolve) => {
      releaseBarrier = resolve;
    });
    // Install synchronously before the first await. New backend admissions now
    // wait; the checks below account for work that entered before this barrier.
    this.turnSandboxRepairs.set(projectId, {
      promise: barrier,
      requestingSessionIds: new Set(),
    });
    try {
      if ((this.projectSandboxActivities.get(projectId) ?? 0) > 0) {
        throw new ProvisioningError(`project ${projectId} has a turn in flight`);
      }
      if (this.projectBusyProbe && (await this.projectBusyProbe(projectId))) {
        throw new ProvisioningError(`project ${projectId} has a turn in flight`);
      }
      return await mutation();
    } finally {
      releaseBarrier(true);
      const current = this.turnSandboxRepairs.get(projectId);
      if (current?.promise === barrier) this.turnSandboxRepairs.delete(projectId);
    }
  }

  private async repairSandboxForTurnOnce(
    projectId: string,
    requestingSessionIds: ReadonlySet<string>,
  ): Promise<boolean> {
    const project = await this.opts.store.getProject(projectId);
    if (project === undefined || project.kind === 'control_plane') return false;
    const { classification, envDriftOnly } = await this.classifyProjectSandbox(project);
    if (classification === 'migrated') return true;
    // Someone else's container: never a Verity recreate target (spike §8).
    if (classification === 'foreign') return false;
    // The same budget the reconcile tick spends, and for the same reason: the loop
    // driver here is the client. A session that keeps retrying a blocked turn would
    // destroy and rebuild this sandbox on every attempt, so a drift that recreating
    // cannot fix has to stop being recreated from this side too.
    //
    // Reported as USABLE rather than as an unrepaired sandbox, which is the one
    // decision in this method worth arguing. A drift-only sandbox reaches its broker,
    // signs commits and runs Claude; exactly one leg is dead. Answering `false` would
    // convert that into "this project cannot run turns at all" — a total outage to
    // account for a partial one, and permanent, since a project that is never
    // recreated again never classifies `migrated` and never gets its budget back.
    // Nothing is admitted that shouldn't be: the caller re-runs its own relay check
    // on this answer, and a Codex turn into a sandbox with no Codex gateway still
    // fails — with the connector's 502, which names the actual fault.
    if (envDriftOnly && this.envDriftBudgetSpent(projectId)) return true;
    // The two busy branches answer "not rebuilt now", which for a structurally legacy
    // sandbox means unusable — but for a drift-only one means usable and left alone.
    // Same reasoning as the budget branch: a fault in one leg is not grounds to fail
    // the turn, and being unable to rebuild is not a worse fault than declining to.
    if ((this.projectSandboxActivities.get(projectId) ?? 0) > 0) return envDriftOnly;
    // The requesting turn cannot make progress in this sandbox, but another session
    // still might. Exclude only the caller from the project-wide busy check; never
    // tear the container down under an unrelated Claude/Codex/OpenCode turn.
    if ((await this.probeProjectBusy(projectId, requestingSessionIds)).busy) return envDriftOnly;
    const inFlight = this.inFlightProvisions.get(projectId);
    if (inFlight !== undefined) {
      // A provision/recreate already owns this container. Let it finish — its own
      // container phase produces exactly the relay-era Sandbox we want — then judge
      // the result below rather than starting a competing stop/remove.
      await inFlight.catch(() => undefined);
    } else {
      await this.recreateContainer(projectId, { confirmWarnings: true });
      // Charged only for a recreate this path actually performed and completed —
      // not for one it waited on, and not for one that threw.
      if (envDriftOnly) this.noteEnvDriftRecreate(projectId);
    }
    const repaired = await this.opts.store.getProject(projectId);
    if (repaired === undefined) return false;
    const after = await this.classifyProjectSandbox(repaired);
    // Drift that survived its own recreate is judged the same way as drift that ran
    // out of budget above: a partially dead sandbox is still a usable one.
    return after.classification === 'migrated' || after.envDriftOnly;
  }

  /** Ask the busy probe, keeping "busy" and "could not find out" apart. Both read
   *  as busy — that is the SBX-1 fail-safe — but only a `confirmed` answer proves
   *  a turn exists, and only a proven turn may spend an orphan's grace window. */
  private async probeProjectBusy(
    projectId: string,
    exceptSessionIds?: ReadonlySet<string>,
  ): Promise<{ busy: boolean; confirmed: boolean }> {
    if (this.projectBusyProbe === undefined) return { busy: true, confirmed: false };
    try {
      return { busy: await this.projectBusyProbe(projectId, exceptSessionIds), confirmed: true };
    } catch {
      return { busy: true, confirmed: false };
    }
  }

  private async isProjectBusy(projectId: string): Promise<boolean> {
    return (await this.probeProjectBusy(projectId)).busy;
  }

  /** Classify a project's current sandbox for Stage 5 migration. A failed inspect
   *  (e.g. no such container) is treated as `absent` — nothing to migrate. */
  private async classifyProjectSandbox(
    project: ProjectRecord,
  ): Promise<{ classification: ProjectContainerClass; envDriftOnly: boolean }> {
    const inspect = await this.opts.docker
      .inspectContainer(project.containerName)
      .catch(() => null);
    // The kill switch rides on the classifier input, so every question asked below —
    // the classification, the drift attribution, the budget — is asked with drift out
    // of scope and answers exactly as it did before drift was a reason to recreate
    // anything. Not by withholding `inspect.env`: that also worked, but only for the
    // caller that remembered to withhold it.
    const input = {
      inspect,
      projectId: project.id,
      projectNetwork: projectNetworkName(project.id),
      relayHealthy: await this.isRelayHealthy(project, containerGenerationOf(inspect)),
      considerEnvDrift: this.opts.recreateEnvDriftedSandboxes !== false,
    };
    const classification = classifyProjectContainer(input);
    // Every path that asks this question also answers "can a session in this
    // sandbox reach the broker?", so record it here rather than at each caller:
    // the reconcile tick, the provision path, and the turn-blocked repair all
    // keep the report current without a Docker call of their own.
    if (classification === 'orphaned') this.disconnectedSandboxes.add(project.id);
    else this.disconnectedSandboxes.delete(project.id);
    // A sandbox that came back whole starts its drift budget over — otherwise a
    // project that drifted once, was repaired, and drifts again years later would
    // be born already out of attempts.
    //
    // "Came back whole" is only knowable when drift was in scope. With the switch
    // off every sandbox classifies `migrated`, drifted or not, so an unguarded clear
    // would refund a budget on evidence it never gathered. Costs nothing today —
    // the switch is read once at startup, so a process that clears this way never
    // spends the budget anyway — and stops the refund being real the moment the
    // flag becomes per-project or reloadable.
    if (classification === 'migrated' && input.considerEnvDrift) {
      this.envDriftRecreates.delete(project.id);
      this.envDriftReported.delete(project.id);
    }
    // Reported alongside, never instead: an env-drifted sandbox classifies `legacy`
    // like a pre-relay one, and the recreate is the same, but the first deploy of a
    // new cohort recreates the whole fleet at once and the logs have to say why.
    // Asks whether drift is the SOLE reason rather than merely a reason, so a
    // pre-relay sandbox carrying Claude-era vars is not blamed on the new cohort —
    // and so the bound below can never suppress a structural repair.
    return { classification, envDriftOnly: envDriftIsSoleReason(input) };
  }

  /**
   * Projects whose sandbox is cut off from the broker, as of the last
   * classification. Reading it is a `Set` handoff: the answer was computed by
   * the reconcile tick, never by the caller.
   *
   * Reports rather than repairs. The repair already exists and already runs —
   * but it can be deferred behind a live turn, and a session whose brokered
   * calls all fail is precisely what keeps a turn alive to defer it.
   */
  disconnectedSandboxProjects(): ReadonlySet<string> {
    return this.disconnectedSandboxes;
  }

  /**
   * Projects whose sandbox this reconciler is NOT going to bring up to date.
   *
   * A Server restart first resumes running generations, then automatically replaces
   * stale images after their projects become idle. What is worth surfacing is a gap
   * that automatic repair will not close, which happens two ways and only these two:
   *
   * - the recreate has been attempted and FAILED on
   *   {@link SANDBOX_SELF_REPAIR_FAILURE_LIMIT} consecutive passes, or
   * - the last pass looked and decided there was nothing to recreate
   *   ({@link settledSandboxes}) and no update target was supplied for it.
   *
   * A project the reconciler has not reached yet, or is deferring around a live
   * turn, is in neither set: that is the repair working, and it reports as
   * converging.
   */
  unrepairedSandboxes(): ReadonlySet<string> {
    const unrepaired = new Set(this.settledSandboxes);
    for (const [projectId, failures] of this.sandboxRepairFailures) {
      if (failures >= SANDBOX_SELF_REPAIR_FAILURE_LIMIT) unrepaired.add(projectId);
    }
    return unrepaired;
  }

  /** Is the relay behind a sandbox of this generation still live? Reported only
   *  when the sandbox carries a generation and the relay control can answer;
   *  otherwise the health stays UNKNOWN (undefined), never `false`. A probe that
   *  throws also reads unknown: a flaky Docker call must not be able to condemn a
   *  working sandbox to a recreate. */
  private async isRelayHealthy(
    project: ProjectRecord,
    containerGeneration: string | undefined,
  ): Promise<boolean | undefined> {
    const isHealthy = this.opts.projectRelay.isHealthy;
    if (isHealthy === undefined || containerGeneration === undefined) return undefined;
    try {
      if (await isHealthy({ projectId: project.id, containerGeneration })) return true;
      if (this.opts.projectRelay.resume === undefined) return false;
      if (!(await this.opts.projectRelay.resume(this.relayBinding(project, containerGeneration))))
        return false;
      return await isHealthy({ projectId: project.id, containerGeneration });
    } catch {
      return undefined;
    }
  }

  private relayBinding(project: ProjectRecord, containerGeneration: string): ProjectRelayBinding {
    const { selected: projectClaudeGateway, url: claudeGateway } =
      this.resolveRelayClaudeGateway(project);
    const codexGateway = resolvedCodexGatewayUrl(
      this.opts.claudeEgressGatewayUrl,
      this.opts.codexEgressGatewayUrl,
    );
    return {
      projectId: project.id,
      owner: project.owner,
      repo: project.repo,
      containerGeneration,
      claudeGateway: {
        host:
          projectClaudeGateway === undefined
            ? (this.opts.claudeEgressGatewayConnectHost ?? '127.0.0.1')
            : claudeGateway.hostname,
        port: claudeGateway.port === '' ? 443 : Number(claudeGateway.port),
      },
      codexGateway: {
        host: codexGateway.hostname,
        port: codexGateway.port === '' ? 443 : Number(codexGateway.port),
      },
    };
  }

  /**
   * Stage 5 reconciliation (Temporary Public Previews spike §6/§7.5). Once relay
   * mode is on, existing shared-network sandboxes must be RECREATED onto their own
   * relay + project network, never silently reused. For each active project this:
   *   - migrates an idle legacy sandbox by recreating it (the fail-closed relay
   *     sequence a fresh provision runs);
   *   - repairs an idle ORPHANED sandbox the same way: one whose relay died with a
   *     server restart or exited under it, leaving it running but cut off from the
   *     broker. Nothing else recovers those — a sandbox is wired to its relay at
   *     creation (hostname in its env, capabilities on its disk), so re-running the
   *     container phase is the only path back;
   *   - defers either with a turn in flight (recreating would kill the live
   *     docker-exec agent) and reports it so the deferral is visible — for an
   *     ORPHAN only until `ORPHAN_DEFER_TICK_LIMIT` consecutive ticks have passed,
   *     after which the repair wins: the turn holding the project busy is itself
   *     unable to reach the broker, so waiting it out never ends;
   *   - leaves healthy migrated, absent, and FOREIGN containers untouched.
   * A failed recreate leaves that project `failed` (fail-closed, non-public) via
   * the recreate path's own state write; failures are aggregated so the caller can
   * log them and the next tick retries.
   */
  async reconcileRelays(
    projects: readonly ProjectRecord[],
    callbacks: {
      onDeferred?: (projectId: string, info: { imageUpdate: boolean }) => void;
      onMigrated?: (projectId: string, info: { envDrift: boolean; imageUpdate: boolean }) => void;
      updateAvailable?: ReadonlySet<string>;
      /** A sandbox whose ONLY fault is env drift has exhausted
       *  `ENV_DRIFT_RECREATE_LIMIT` recreates without coming back whole, and the
       *  reconciler has stopped recreating it. Fired once per project per budget:
       *  the drift is now a standing condition to be fixed in the provisioner, not
       *  something another recreate will resolve. */
      onEnvDriftUnresolved?: (projectId: string, info: { attempts: number }) => void;
      onEnvDriftThrottled?: (info: {
        deferred: number;
        attempted: number;
        projectIds: readonly string[];
      }) => void;
      onRepaired?: (projectId: string, info: { interruptedTurn: boolean }) => void;
    } = {},
  ): Promise<void> {
    const failures: unknown[] = [];
    /** Projects that deferred an orphan repair on THIS pass. Everything else —
     *  skipped, migrated, healthy, errored, or no longer in `projects` at all —
     *  is pruned below, which is what keeps the count consecutive rather than
     *  cumulative and stops the map from retaining deleted projects. */
    const deferredThisPass = new Set<string>();
    /** Drift-only recreates already spent on this pass, and the projects a full
     *  pass turned away. Both are pass-local: nothing about being throttled is
     *  remembered, so a project skipped here is simply reconsidered next tick. */
    let driftRecreatesThisPass = 0;
    const driftThrottledThisPass: string[] = [];
    // Each project owns its own relay, network and container, so the migrations are
    // independent — only the shared bookkeeping below is touched, and that is
    // per-project keys. Bounded concurrency keeps a real legacy/broken fleet repair
    // to roughly its slowest batches while capping container creates on the host.
    const pending = projects.filter(
      (project) =>
        project.kind !== 'control_plane' &&
        (project.state === 'active' || this.pendingSandboxRepairRetries.has(project.id)),
    );
    let cursor = 0;
    const migrateNext = async (): Promise<void> => {
      for (;;) {
        const project = pending[cursor++];
        if (project === undefined) return;
        // A provision/recreate already in flight owns this project's container; let
        // it finish rather than racing a second stop/remove against it. Checked when
        // the work actually starts, not when the pass was planned.
        if (this.inFlightProvisions.has(project.id)) {
          // For the same reason the `defer` branch retracts below: a provision in
          // flight IS the repair, so whatever this project reported before, it is
          // converging now. Without this a project that hit the stall limit and is
          // finally being rebuilt keeps reporting "stuck" for the whole rebuild.
          this.sandboxRepairFailures.delete(project.id);
          this.settledSandboxes.delete(project.id);
          continue;
        }
        let attemptedRecreate = false;
        try {
          const { classification, envDriftOnly } = await this.classifyProjectSandbox(project);
          const { busy, confirmed } = await this.probeProjectBusy(project.id);
          const imageUpdate =
            classification === 'migrated' && callbacks.updateAvailable?.has(project.id) === true;
          // A failed automatic recreate may already have removed the old container
          // before its pull/create phase failed. `absent` normally means there is
          // nothing for relay migration to do, but for a repair we explicitly owe it
          // means "resume provisioning" — and creating a missing container cannot
          // interrupt a live turn, so no busy deferral is needed.
          const action = imageUpdate
            ? decideMigrationAction({
                // Image updates use legacy's unbounded busy deferral: unlike an
                // orphan, this sandbox is fully usable and must never interrupt a turn.
                classification: 'legacy',
                busy,
                busyConfirmed: confirmed,
              })
            : classification === 'absent' && this.pendingSandboxRepairRetries.has(project.id)
              ? 'migrate'
              : decideMigrationAction({
                  classification,
                  busy,
                  busyConfirmed: confirmed,
                  orphanDeferrals: this.orphanDeferrals.get(project.id),
                });
          if (action === 'defer') {
            // Only a confirmed turn spends the window; a tick that merely could not
            // reach the probe defers without counting, and lets the streak lapse.
            if (classification === 'orphaned' && confirmed) {
              this.orphanDeferrals.set(project.id, (this.orphanDeferrals.get(project.id) ?? 0) + 1);
              deferredThisPass.add(project.id);
            }
            // A deferral is the repair working as designed — it waits for the turn
            // and the wait is bounded. Whatever this project reported before, it is
            // converging again, so retract both verdicts rather than leaving a stale
            // "stuck" up for the whole life of the turn.
            this.sandboxRepairFailures.delete(project.id);
            this.settledSandboxes.delete(project.id);
            callbacks.onDeferred?.(project.id, { imageUpdate });
            continue;
          }
          if (action !== 'migrate') {
            // This pass looked and decided there is nothing to recreate. Any earlier
            // failure streak is over regardless of what ended it (this reconciler, a
            // manual recreate, a deprovision) — and, crucially, this reconciler will
            // NOT come back for this project on its own: it acts on relay generation
            // and network topology, never on image staleness. So if the update
            // checker separately reports this sandbox as behind, nothing is going to
            // close that gap. See {@link settledSandboxes}.
            this.sandboxRepairFailures.delete(project.id);
            this.pendingSandboxRepairRetries.delete(project.id);
            // A foreign container is deliberately outside Verity's repair authority.
            // Never turn it into an Update action: recreateContainer replaces by
            // name, so offering that action would risk deleting somebody else's
            // container. Unknown ownership stays silent rather than "stuck".
            if (classification === 'foreign') this.settledSandboxes.delete(project.id);
            else this.settledSandboxes.add(project.id);
            continue;
          }
          this.settledSandboxes.delete(project.id);
          // The one recreate that is not self-evidently terminating: if the cohort
          // is declared wrong, the sandbox comes back drifted and this loop would
          // rebuild the fleet every tick forever. Spend a bounded budget, then stop
          // and say so — a Codex leg that stays 502 is far cheaper than a server
          // that recreates every idle sandbox in perpetuity.
          if (envDriftOnly && this.envDriftBudgetSpent(project.id)) {
            // Reported exactly once, on the tick the budget runs out. Tracked in a
            // set of its own rather than by pushing the counter to a sentinel: the
            // counter is incremented from two other call sites, and overloading it
            // would mean any future path past the limit silently suppresses this
            // report forever.
            this.settledSandboxes.add(project.id);
            if (!this.envDriftReported.has(project.id)) {
              this.envDriftReported.add(project.id);
              callbacks.onEnvDriftUnresolved?.(project.id, {
                attempts: this.envDriftRecreates.get(project.id) ?? 0,
              });
            }
            continue;
          }
          // Blast radius, as opposed to repetition. The slot is claimed BEFORE the
          // recreate and never given back, including when it throws: a throttle that
          // refunds on failure lets a fleet-wide fault through at full width, which
          // is exactly the case it exists for. Skipped projects are not deferred or
          // remembered — the next tick simply finds them still drifted.
          if (envDriftOnly) {
            if (driftRecreatesThisPass >= ENV_DRIFT_RECREATES_PER_TICK) {
              driftThrottledThisPass.push(project.id);
              continue;
            }
            driftRecreatesThisPass++;
          }
          attemptedRecreate = true;
          await this.recreateContainer(project.id, { confirmWarnings: true });
          // Counted only once the recreate actually happened. A recreate that THREW
          // — daemon down, image pull failed — proves nothing about the drift, and
          // charging it would let three unrelated outages disqualify a project from
          // a repair that would have worked, permanently: only classifying
          // `migrated` clears the count, and a still-drifted sandbox never does.
          if (envDriftOnly) this.noteEnvDriftRecreate(project.id);
          // The repair itself is past. Anything that throws below is a CALLER's
          // callback, and charging that to the streak would report a sandbox as
          // stuck twice over after two rebuilds that both worked.
          attemptedRecreate = false;
          // Repaired: the recreate issued a fresh generation and a fresh relay,
          // so retract the report now rather than leaving it up for a tick.
          this.disconnectedSandboxes.delete(project.id);
          this.sandboxRepairFailures.delete(project.id);
          this.pendingSandboxRepairRetries.delete(project.id);
          if (classification === 'orphaned')
            callbacks.onRepaired?.(project.id, {
              interruptedTurn: busy,
            });
          else callbacks.onMigrated?.(project.id, { envDrift: envDriftOnly, imageUpdate });
        } catch (error) {
          // Only a failed RECREATE counts against the streak. A classify or probe
          // that threw leaves the verdict unknown — the pass never decided the
          // sandbox needed repairing, so it cannot report that repairing it fails.
          if (attemptedRecreate) {
            this.pendingSandboxRepairRetries.add(project.id);
            this.sandboxRepairFailures.set(
              project.id,
              (this.sandboxRepairFailures.get(project.id) ?? 0) + 1,
            );
          } else {
            // Consecutive means consecutive completed recreate attempts. A tick
            // that cannot even classify or probe the sandbox breaks the streak;
            // carrying it across an unknown tick could turn two isolated failures
            // into a false "stuck" verdict.
            this.sandboxRepairFailures.delete(project.id);
          }
          failures.push(error);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RELAY_MIGRATION_CONCURRENCY, pending.length) }, migrateNext),
    );
    // Never a silent cap: a throttled pass looks exactly like a finished one from
    // the outside — some sandboxes rebuilt, no errors — and reading that as "the
    // fleet is repaired" is precisely the wrong conclusion while N projects are
    // still drifted and waiting for the next tick. Named, not just counted: a count
    // says the fleet is not done, the ids say which projects are still answering 502
    // — the question anyone reading this line actually has. `attempted`, not
    // `recreated`: the slot is charged when the recreate throws (see above), so a
    // pass whose four rebuilds all failed would otherwise report four repairs.
    if (driftThrottledThisPass.length > 0) {
      callbacks.onEnvDriftThrottled?.({
        deferred: driftThrottledThisPass.length,
        attempted: driftRecreatesThisPass,
        projectIds: [...driftThrottledThisPass],
      });
    }
    for (const projectId of this.orphanDeferrals.keys()) {
      if (!deferredThisPass.has(projectId)) this.orphanDeferrals.delete(projectId);
    }
    // Drop reports for projects this pass no longer reconciles at all — deleted,
    // deprovisioned, or no longer `active`. Unlike `orphanDeferrals` the entries
    // are NOT rewritten from scratch each pass: they persist across ticks until a
    // pass has a reason to change them, so a verdict survives a tick that merely
    // could not reach a decision.
    const reconciled = new Set(pending.map((project) => project.id));
    for (const projectId of [...this.disconnectedSandboxes]) {
      if (!reconciled.has(projectId)) this.disconnectedSandboxes.delete(projectId);
    }
    for (const projectId of [...this.sandboxRepairFailures.keys()]) {
      if (!reconciled.has(projectId)) this.sandboxRepairFailures.delete(projectId);
    }
    for (const projectId of [...this.pendingSandboxRepairRetries]) {
      if (!reconciled.has(projectId)) this.pendingSandboxRepairRetries.delete(projectId);
    }
    for (const projectId of [...this.settledSandboxes]) {
      if (!reconciled.has(projectId)) this.settledSandboxes.delete(projectId);
    }
    // `envDriftRecreates` is deliberately NOT pruned here. The two maps look alike
    // and their safety runs opposite ways: dropping a `disconnectedSandboxes` entry
    // retracts a claim that something is broken, which is the conservative direction,
    // while dropping a budget entry restores unbounded recreates. Any rule of the form
    // "not in this pass" refunds the budget for a project that merely sat a tick out —
    // a provision in flight, a momentarily short project list — and the loop the budget
    // exists to stop resumes three recreates at a time, forever. It is cleared by the
    // one event that actually means something — the sandbox coming back whole, in
    // `classifyProjectSandbox` — and otherwise left to sit: one integer per project
    // that ever drifted, against a fleet-wide rebuild loop.
    //
    // Project DELETION would be a safe moment to prune, unlike "absent from this
    // pass" — but deprovisioning lives on `DeprovisionerImpl`, which holds none of
    // this instance's state, and coupling the two to reclaim an integer per deleted
    // project is not worth it. Ids are uuids, so a stale entry is never read again.
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Relay migration failed for ${String(failures.length)} project(s)`,
      );
    }
  }

  /**
   * Provision hard-stop (Stage 5): a project row that is already `active` normally
   * short-circuits provisioning for idempotency. But once relay mode is on, a
   * sandbox created before the cutover still speaks the legacy shared-network path,
   * so handing it back unchanged would silently reuse it. When the project is
   * provably idle we migrate it in place onto its relay + project network (the same
   * container phase a fresh provision runs); when it is busy — or relay mode is off,
   * or the sandbox is already migrated/foreign/absent — we return it unchanged and
   * leave migration to the busy-aware reconciler.
   */
  private async reuseOrMigrateActive(
    project: ProjectRecord,
    opts: { confirmWarnings?: boolean },
  ): Promise<ProjectRecord> {
    const { classification, envDriftOnly } = await this.classifyProjectSandbox(project);
    const busy = await this.isProjectBusy(project.id);
    if (decideMigrationAction({ classification, busy }) !== 'migrate') return project;
    // The third loop driver over the same container, and the only one a client can
    // spin by hand: a provision that keeps being retried would otherwise rebuild the
    // sandbox on every attempt with no ceiling, which is the reconciler's runaway
    // seen from the API. So it spends the SAME budget as the tick and the turn-time
    // repair — a budget one caller ignores is not a budget. When it is gone this
    // path degrades to precisely what it did before drift was a reason to rebuild
    // anything: hand the active sandbox back unchanged. That is the right direction
    // for a provision, which must not fail a project over a Codex leg.
    if (envDriftOnly && this.envDriftBudgetSpent(project.id)) return project;
    const migrated = await this.runContainerPhase(project, false, opts);
    if (envDriftOnly) this.noteEnvDriftRecreate(project.id);
    // Same retraction as the reconciler's repair above, and needed for the same
    // reason: this path can classify a sandbox `orphaned`, rebuild it onto a
    // fresh generation, and would otherwise leave its sessions reported unusable
    // until the next reconcile tick happens to reclassify.
    this.disconnectedSandboxes.delete(project.id);
    return migrated;
  }

  private async defaultImageRef(forceRefresh = false): Promise<string> {
    return typeof this.opts.defaultImageRef === 'function'
      ? await this.opts.defaultImageRef(forceRefresh)
      : this.opts.defaultImageRef;
  }

  private async devcontainerFeature(): Promise<
    { ref: string; version: string; identity: string } | undefined
  > {
    return typeof this.opts.devcontainerFeature === 'function'
      ? await this.opts.devcontainerFeature()
      : this.opts.devcontainerFeature;
  }

  /**
   * Single provisioning attempt. The lock (`SELECT … FOR UPDATE`) only
   * protects the **state-machine transitions** — check the current state
   * and set it to `cloning`. The actual long-running I/O (git clone, docker
   * create+start) runs OUTSIDE the lock so a `ProvisioningError` throw after
   * a failed clone/start doesn't roll back the `state='failed'` write (which
   * happened via `this.opts.store.updateProjectState` on the outer connection,
   * would be inside the tx's savepoint scope in pglite and get rolled back on
   * the throw). The lock is a short critical section around state-read +
   * state-write; the clone/docker calls are unguarded because ON CONFLICT +
   * docker-name-uniqueness are the daemon-level collision backstops.
   */
  async provision(
    projectId: string,
    opts: { confirmWarnings?: boolean } = {},
  ): Promise<ProjectRecord> {
    // Coalesce onto an already-running attempt (see inFlightProvisions). The
    // joining caller's own `opts` are intentionally ignored — it observes the
    // running attempt's outcome, exactly as if its request had arrived while
    // that attempt's 202 was still in flight.
    const running = this.inFlightProvisions.get(projectId);
    if (running !== undefined) return running;
    const attempt = this.provisionOnce(projectId, opts);
    this.inFlightProvisions.set(projectId, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlightProvisions.delete(projectId);
    }
  }

  private async provisionOnce(
    projectId: string,
    opts: { confirmWarnings?: boolean },
  ): Promise<ProjectRecord> {
    // Phase 1: acquire lock, check state, transition to `cloning` (or
    // short-circuit if already `active`/mid-transition).
    const project = await this.claimForCloning(projectId);
    if (project.state === 'active') return this.reuseOrMigrateActive(project, opts);
    if (project.state === 'container_starting') {
      return this.runContainerPhase(project, false, opts);
    }

    // Phase 2: run the clone (OUTSIDE the lock).
    try {
      await this.serializeProjectCheckoutOperation(project.id, () => this.doClone(project));
    } catch (cause) {
      if (cause instanceof ProvisioningError) throw cause;
      const message = `git clone failed: ${failureMessage(cause)}`;
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }

    // Phase 3: container start (also outside the lock).
    return this.runContainerPhase(project, false, opts);
  }

  async recreateContainer(
    projectId: string,
    opts: RecreateContainerOptions = {},
  ): Promise<ProjectRecord> {
    // Unlike `provision`, a recreate does NOT coalesce: it promises a fresh
    // container + forced image pull, which a run already past those steps
    // cannot deliver. Reject instead — same contract as the state check below.
    if (this.inFlightProvisions.has(projectId)) {
      throw new ProvisioningError(`project ${projectId} is already provisioning`);
    }
    const attempt = this.recreateContainerOnce(projectId, opts);
    this.inFlightProvisions.set(projectId, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlightProvisions.delete(projectId);
    }
  }

  /** Whether this process still owns provisioning/replacement work for a project.
   * Durable rebuild notices are cleared by reconciliation only when no such work
   * survived in this server process (notably after a restart). */
  isProjectProvisioning(projectId: string): boolean {
    return this.inFlightProvisions.has(projectId);
  }

  private async recreateContainerOnce(
    projectId: string,
    opts: RecreateContainerOptions,
  ): Promise<ProjectRecord> {
    const project = await this.opts.store.getProject(projectId);
    if (project === undefined) {
      throw new ProvisioningError('project gone mid-recreate');
    }
    if (project.state === 'cloning' || project.state === 'container_starting') {
      throw new ProvisioningError(`project ${projectId} is already provisioning`);
    }
    if (project.state === 'absent') {
      throw new ProvisioningError(`project ${projectId} is absent; provision it instead`);
    }

    const warning = this.devcontainerWarningForProject(project);
    if (warning !== null && opts.confirmWarnings !== true) {
      throw new ProvisioningWarning([warning]);
    }

    // A cacheless devcontainer build can take minutes. Complete it while the
    // current container is still serving traffic; only retire that container
    // after the replacement image exists. runContainerPhase resolves the same
    // derived tag again below, but with forceRebuild cleared that second lookup
    // is a cheap cache hit rather than another build.
    let containerPhaseOpts = opts;
    if (opts.forceRebuild === true) {
      const dirs = projectDirs(this.opts.hostCloneRoot, project);
      await this.opts.store.updateProjectState(
        project.id,
        project.state,
        project.provisionError,
        PROJECT_IMAGE_REBUILDING_WARNING,
      );
      try {
        await this.resolveOrBuildImage(project, dirs, true);
      } catch (cause) {
        const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
        const detail = redactSensitive(buildFailureMessage(cause), [
          token,
          process.env.GH_TOKEN,
          process.env.VERITY_REGISTRY_AUTH,
        ]);
        const message = `devcontainer build failed: ${detail}`;
        await this.opts.store.updateProjectState(
          project.id,
          project.state,
          project.provisionError,
          message,
        );
        throw new ProvisioningError(message, cause);
      }
      containerPhaseOpts = { ...opts, forceRebuild: false };
    }
    let containerPhaseStarted = false;
    let replacementStarted = false;
    const replace = async (): Promise<ProjectRecord> => {
      this.resolveRelayClaudeGateway(project);
      replacementStarted = true;
      await stopAndRemoveExistingContainer(this.opts.docker, project.containerName);

      // ADR 0004 — "Update & restart" must actively fetch. Force a fresh pull of
      // the target image so a moved tag / updated image already present locally is
      // re-fetched (the ADR-0003 stale-image class). The normal provision path
      // keeps its lazy pull-on-miss behavior.
      containerPhaseStarted = true;
      return this.runContainerPhase(project, true, containerPhaseOpts);
    };
    try {
      return await (this.opts.withContainerReplace
        ? this.opts.withContainerReplace(project, replace)
        : replace());
    } catch (cause) {
      if (opts.forceRebuild === true && !containerPhaseStarted) {
        const restoredState = replacementStarted ? 'failed' : project.state;
        const replacementError = `container replacement failed: ${failureMessage(cause)}`;
        await this.opts.store.updateProjectState(
          project.id,
          restoredState,
          replacementStarted
            ? replacementError
            : restoredState === 'failed'
              ? project.provisionError
              : null,
          project.provisionWarning,
        );
      }
      throw cause;
    }
  }

  async provisionWarnings(projectId: string): Promise<string[]> {
    const project = await this.opts.store.getProject(projectId);
    if (project === undefined) return [];
    const warning = this.devcontainerWarningForProject(project);
    return warning === null ? [] : [warning];
  }

  /** Lock the project row, read its state, decide what to do next:
   *  - `active` → return (no-op).
   *  - `cloning` → another worker is mid-clone; return the row so the caller
   *    re-enters the clone phase (idempotent: clone into an existing repo
   *    falls through to fetch+reset).
   *  - `container_starting` → return the row so the caller enters the
   *    container phase directly (a previous clone completed but the start
   *    didn't).
   *  - `absent` / `failed` → transition to `cloning`, return the row.
   */
  private async claimForCloning(projectId: string): Promise<ProjectRecord> {
    return withProjectLock(this.opts.db, projectId, async (tx) => {
      const project = await getProjectInTx(tx, projectId);
      if (project === undefined) {
        throw new ProvisioningError('project gone mid-lock (deprovision race?)');
      }
      if (project.state === 'active') return project;
      if (project.state === 'cloning' || project.state === 'container_starting') {
        return project;
      }
      // `absent` or `failed` → claim.
      const updated = await updateProjectStateInTx(tx, project.id, 'cloning');
      return updated ?? project;
    });
  }

  /** Clone (or fetch+reset for a re-provision-after-keep). Does NOT touch
   *  `projects.state` — the caller is responsible for the `failed` transition
   *  on error. On success, the caller transitions to `container_starting`.
   *
   *  A `local` project has no remote to clone from, so it gets an empty git repo
   *  instead — see {@link initLocalRepo}. Once such a project is LINKED to a
   *  GitHub repo its `kind` flips to `github` and it re-enters the fetch branch
   *  below, which is why the link path must have set `origin` first. */
  private async doClone(project: ProjectRecord): Promise<void> {
    const dirs = projectDirs(this.opts.hostCloneRoot, project);
    const settings = await this.opts.store.getProjectSettingsRaw(project.id);
    const configuredDefaultBranch = settings?.defaultBranch?.trim() || undefined;
    if (isLocalProject(project)) {
      await this.initLocalRepo(dirs.clonePath, configuredDefaultBranch ?? 'main');
      return;
    }
    if (this.isDir(dirs.clonePath) && this.isRepoDir(dirs.clonePath)) {
      // The minted token is used for THIS server-side fetch only — it is never
      // written into the sandbox (the sandbox redeems its capability at the token
      // broker instead), so nothing is persisted to a `.gh-token` file.
      const token = await this.resolveProjectToken(project);
      const authHeader = gitAuthHeader(token);
      try {
        await this.git([
          '-C',
          dirs.clonePath,
          '-c',
          `http.extraheader=${authHeader}`,
          'fetch',
          'origin',
        ]);
      } catch (cause) {
        const safeCause = new Error(
          redactSensitive(commandFailureMessage(cause), [token, authHeader]),
        );
        // eslint-disable-next-line preserve-caught-error -- raw git errors can include Authorization headers.
        throw new Error(safeCause.message, { cause: safeCause });
      }
      let defaultBranch = configuredDefaultBranch;
      if (!defaultBranch) {
        try {
          const remoteHead = await this.git([
            '-C',
            dirs.clonePath,
            'symbolic-ref',
            '--short',
            'refs/remotes/origin/HEAD',
          ]);
          defaultBranch = remoteHead.stdout.trim().replace(/^origin\//, '') || 'main';
        } catch {
          defaultBranch = 'main';
        }
      }
      await this.git(['-C', dirs.clonePath, 'reset', '--hard', `origin/${defaultBranch}`]);
    } else {
      const token = await this.resolveProjectToken(project);
      const authHeader = gitAuthHeader(token);
      const url = `https://github.com/${project.owner}/${project.repo}`;
      try {
        const cloneArgs = [
          '-c',
          `http.extraheader=${authHeader}`,
          'clone',
          ...(configuredDefaultBranch ? ['--branch', configuredDefaultBranch] : []),
          url,
          dirs.clonePath,
        ];
        await this.git(cloneArgs);
      } catch (cause) {
        const safeCause = new Error(
          redactSensitive(commandFailureMessage(cause), [token, authHeader]),
        );
        // eslint-disable-next-line preserve-caught-error -- raw git errors can include Authorization headers.
        throw new Error(safeCause.message, { cause: safeCause });
      }
      await this.git(['-C', dirs.clonePath, 'remote', 'set-url', 'origin', url]);
    }
  }

  /**
   * Create the empty git repository a project without a GitHub repo starts from.
   * Idempotent: a re-provision — or a repair after a failed container start —
   * finds the repo already there and leaves it alone, along with everything
   * committed into it since.
   *
   * The initial commit is not cosmetic. `git worktree add` refuses to branch off
   * an unborn HEAD, so without it the FIRST session spawned into the project
   * would fail. It is deliberately EMPTY rather than seeded with a README: the
   * repository is the operator's, and Verity should not author its first file.
   *
   * Identity and signing are pinned per-invocation rather than inherited from
   * the server's git config — the server container carries no `user.email`, and
   * an inherited `commit.gpgsign=true` would route this bootstrap commit to a
   * signing path that holds no key for it.
   */
  private async initLocalRepo(clonePath: string, defaultBranch: string): Promise<void> {
    const repoExists = this.isDir(clonePath) && this.isRepoDir(clonePath);
    if (repoExists) {
      try {
        await this.git(['-C', clonePath, 'rev-parse', '--verify', 'HEAD']);
        return;
      } catch {
        // An interrupted first attempt can leave `.git` behind with an unborn
        // HEAD. Finish the bootstrap commit instead of treating it as complete.
      }
    } else {
      await this.git(['init', '-b', defaultBranch, clonePath]);
    }
    await this.git([
      '-C',
      clonePath,
      '-c',
      'user.name=Verity',
      '-c',
      'user.email=verity@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'chore: initialize project',
    ]);
  }

  /**
   * Reduce a `local` clone's `.git/config` to {@link FROZEN_LOCAL_CONFIG_KEYS} before
   * the container that gets it read-only is created.
   *
   * The read-only mount stops the sandbox from writing that file — it does not undo what
   * an EARLIER session already wrote. A project provisioned before the mount existed can
   * carry `core.hooksPath`, a `filter.*` or a `merge.*.driver` from back then, and the
   * server still runs git against that clone (`worktree add` applies smudge filters and
   * fires `post-checkout`), so freezing an unexamined file would preserve exactly the
   * execution this is meant to remove — and make it permanent.
   *
   * Runs on every container phase, which is the last moment before the file is frozen,
   * and on the recreate path that is how an existing project first gets the mount: there
   * the old container is already stopped and removed, so nothing can write the file back.
   *
   * Only keys the file itself carries are unset, which is why no "nothing to unset" case
   * has to be tolerated: `--file` does not follow `include.path`, so every listed key is
   * present in that file — and the include directive itself is one of the keys dropped.
   * Reading and rewriting config is the one git operation that runs no repository code:
   * the server's cwd is not the repository, and `--file` reads nothing else.
   *
   * A key that survives the pass fails the provision, and so does a config that is not a
   * plain file (see {@link LocalConfigState}). Mounting a config that still holds
   * something unrecognized would hand it to git with Verity's own privileges.
   */
  private async sanitizeLocalCloneConfig(
    project: ProjectRecord,
    clonePath: string,
    state: LocalConfigState,
  ): Promise<void> {
    if (!isLocalProject(project) || state === 'absent') return;
    const file = `${clonePath}/.git/config`;
    if (state === 'unsafe') {
      throw new Error(`${file} is not a regular file inside the clone`);
    }
    const listEntries = async (): Promise<ConfigEntry[]> => {
      // NUL-separated: a value git allows to span lines cannot then be read as a key.
      const { stdout } = await this.git(['config', '--file', file, '--list', '-z']);
      return stdout
        .split('\0')
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const split = entry.indexOf('\n'); // `key\nvalue`, or just `key` without one
          return split === -1
            ? { name: entry }
            : { name: entry.slice(0, split), value: entry.slice(split + 1) };
        });
    };
    for (const key of configKeysToDrop(await listEntries())) {
      await this.git(['config', '--file', file, '--unset-all', key]);
    }
    const left = configKeysToDrop(await listEntries());
    if (left.length > 0) {
      throw new Error(`git config keys could not be removed: ${left.join(', ')}`);
    }
  }

  /**
   * Point a project's clone at a GitHub repository and publish its history there
   * (the "connect this local project to GitHub later" path). Runs BEFORE the
   * project row is rewritten, so a rejected push leaves a still-local project
   * with no half-applied GitHub identity.
   *
   * The push is plain and non-forced. If the target already has history, its
   * default branch is merged into the local branch first. Unrelated histories
   * are allowed and local files win conflicting hunks, while conflict-free
   * remote content and the remote ancestry are retained.
   */
  async linkCloneToGitHub(
    project: ProjectRecord,
    target: { owner: string; repo: string },
    token: string | undefined,
  ): Promise<LinkCloneToGitHubResult> {
    const clonePath = projectClonePath(this.opts.hostCloneRoot, project);
    if (!this.isDir(clonePath) || !this.isRepoDir(clonePath)) {
      throw new ProvisioningError('project clone is missing; repair the project first');
    }
    const url = `https://github.com/${target.owner}/${target.repo}`;
    const authHeader = gitAuthHeader(token);
    const branch = (
      await this.git(['-C', clonePath, 'symbolic-ref', '--short', 'HEAD'])
    ).stdout.trim();
    const localHead = (
      await this.git(['-C', clonePath, 'rev-parse', '--verify', 'HEAD'])
    ).stdout.trim();
    let originMatchesTarget = false;
    let originExists = false;
    try {
      const existingOrigin = (
        await this.git(['-C', clonePath, 'remote', 'get-url', 'origin'])
      ).stdout.trim();
      originExists = true;
      originMatchesTarget = existingOrigin === url || existingOrigin === `${url}.git`;
      if (!originMatchesTarget) {
        throw new ProvisioningError(
          'origin already points to another repository; remove or rename it before linking',
        );
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
    }
    let remoteRefs: Awaited<ReturnType<GitRunner>>;
    try {
      remoteRefs = await this.git([
        '-c',
        `http.extraheader=${authHeader}`,
        'ls-remote',
        '--heads',
        '--tags',
        url,
      ]);
    } catch (cause) {
      const safeCause = new Error(
        redactSensitive(commandFailureMessage(cause), [token, authHeader]),
      );
      throw new ProvisioningError('inspecting the existing GitHub repository failed', safeCause);
    }
    const refs = remoteRefs.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const remoteHeads = refs.filter((line) => /\srefs\/heads\//.test(line));
    let destinationBranch = branch;
    let mergedExistingHistory = false;
    if (remoteHeads.length > 0) {
      const [sha, ref, extra] = refs.length === 1 ? refs[0]!.split(/\s+/) : [];
      // Crash recovery: the prior attempt may have completed the push but died
      // before persisting the GitHub identity. Only the exact single branch at
      // our current HEAD is accepted as that idempotent continuation.
      if (
        originMatchesTarget &&
        extra === undefined &&
        sha === localHead &&
        ref === `refs/heads/${branch}`
      ) {
        return {};
      }
    }
    if (!originExists) {
      await this.git(['-C', clonePath, 'remote', 'add', 'origin', url]);
    }
    if (remoteHeads.length > 0) {
      let localStatus: string;
      try {
        // Tracked changes only, mirroring `hasTrackedChanges` in branches.ts: the
        // project clone permanently carries the untracked `.verity-sessions/`
        // directory its session worktrees live in, so counting untracked files
        // would block every project that has ever run a session. They are also the
        // ones not at risk below — `git merge` refuses on its own rather than
        // clobbering an untracked file, and the `reset --merge` rollback ignores them.
        localStatus = (
          await this.git(['-C', clonePath, 'status', '--porcelain', '--untracked-files=no'])
        ).stdout.trim();
      } catch (cause) {
        if (!originExists) {
          await this.git(['-C', clonePath, 'remote', 'remove', 'origin']);
        }
        const safeCause = new Error(
          redactSensitive(commandFailureMessage(cause), [token, authHeader]),
        );
        throw new ProvisioningError('checking the local project status failed', safeCause);
      }
      if (localStatus !== '') {
        if (!originExists) {
          await this.git(['-C', clonePath, 'remote', 'remove', 'origin']);
        }
        throw new ProvisioningError(
          'the local project has uncommitted changes; commit, stash, or discard them before linking GitHub',
        );
      }
      let remoteBranch: string | undefined;
      try {
        const remoteHead = await this.git([
          '-c',
          `http.extraheader=${authHeader}`,
          'ls-remote',
          '--symref',
          url,
          'HEAD',
        ]);
        remoteBranch = remoteHead.stdout
          .split('\n')
          .map((line) => line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)?.[1])
          .find((candidate) => candidate !== undefined);
      } catch (cause) {
        if (!originExists) {
          await this.git(['-C', clonePath, 'remote', 'remove', 'origin']);
        }
        const safeCause = new Error(
          redactSensitive(commandFailureMessage(cause), [token, authHeader]),
        );
        throw new ProvisioningError(
          'determining the GitHub repository default branch failed',
          safeCause,
        );
      }
      remoteBranch ??= refs
        .map((line) => line.split(/\s+/))
        .find(([, ref]) => ref === `refs/heads/${branch}`)?.[1]
        ?.replace(/^refs\/heads\//, '');
      if (remoteBranch === undefined) {
        if (!originExists) {
          await this.git(['-C', clonePath, 'remote', 'remove', 'origin']);
        }
        throw new ProvisioningError('the GitHub repository default branch could not be determined');
      }
      destinationBranch = remoteBranch;
      try {
        await this.git([
          '-C',
          clonePath,
          '-c',
          `http.extraheader=${authHeader}`,
          'fetch',
          'origin',
          `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`,
        ]);
      } catch (cause) {
        if (!originExists) {
          await this.git(['-C', clonePath, 'remote', 'remove', 'origin']);
        }
        const safeCause = new Error(
          redactSensitive(commandFailureMessage(cause), [token, authHeader]),
        );
        throw new ProvisioningError(
          'fetching the existing GitHub repository history failed',
          safeCause,
        );
      }
      try {
        // Identity and signing are pinned per-invocation exactly as `initLocalRepo`
        // and the session merge in branches.ts pin them: the server container carries
        // no `user.email`, and an unset one aborts this merge commit outright, while
        // an inherited `commit.gpgsign=true` would route Verity's own merge through a
        // signing path that holds no key for it.
        await this.git([
          '-C',
          clonePath,
          '-c',
          'user.name=Verity',
          '-c',
          'user.email=verity@localhost',
          '-c',
          'commit.gpgsign=false',
          'merge',
          '--allow-unrelated-histories',
          '--no-edit',
          '-X',
          'ours',
          `refs/remotes/origin/${remoteBranch}`,
        ]);
        mergedExistingHistory = true;
      } catch (cause) {
        // A merge that never started leaves no MERGE_HEAD, and `git merge --abort`
        // then fails with "there is no merge to abort". Only abort a merge that
        // actually touched the tree: reporting the abort failure as damage would
        // send the operator to repair a clone that was never modified.
        let midMerge = true;
        try {
          await this.git(['-C', clonePath, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
        } catch {
          midMerge = false;
        }
        let abortCause: unknown;
        if (midMerge) {
          try {
            await this.git(['-C', clonePath, 'merge', '--abort']);
          } catch (error) {
            abortCause = error;
          }
        }
        if (abortCause !== undefined) {
          const failure = `${commandFailureMessage(cause)}; aborting the merge also failed: ${commandFailureMessage(abortCause)}`;
          const safeCause = new Error(redactSensitive(failure, [token, authHeader]));
          throw new AmbiguousGitPushError(
            'merging GitHub history failed and the local project needs repair before retrying',
            safeCause,
          );
        }
        if (!originExists) {
          await this.git(['-C', clonePath, 'remote', 'remove', 'origin']);
        }
        const safeCause = new Error(
          redactSensitive(commandFailureMessage(cause), [token, authHeader]),
        );
        throw new ProvisioningError(
          'merging the existing GitHub repository into the local project failed',
          safeCause,
        );
      }
    }
    // Everything about to be pushed has to be verifiable, and until this moment
    // none of it needed to be: a local project is never pushed, so the commits
    // Verity writes for it — the bootstrap commit, the session merges, the merge
    // just above — carry no signature and commit as `verity@localhost`. Against a
    // repository whose ruleset requires verified signatures that push is rejected
    // outright, and "retry to recover" cannot help, because every attempt rebuilds
    // the same unsigned merge. Repair it here, where the history has never been
    // published and a rewrite still costs nothing.
    //
    // Best-effort by design: a fleet without a signing key configured, or with no
    // git identity to commit under, is a fleet whose repositories do not demand
    // signatures either. Failing the link over it would block the operators this
    // does not apply to. When it IS configured and the rewrite fails, the push
    // below fails on its own and reports what GitHub actually objected to.
    try {
      const linkSettings = await this.opts.veritySettings?.();
      const signingKey = resolveSigningPrivateKey(linkSettings);
      const committerName = linkSettings?.gitUserName?.trim();
      const committerEmail = linkSettings?.gitUserEmail?.trim();
      if (
        signingKey !== null &&
        committerName !== undefined &&
        committerName.length > 0 &&
        committerEmail !== undefined &&
        committerEmail.length > 0
      ) {
        await signHistoryForPush(
          this.git,
          clonePath,
          { privateKey: signingKey, committerName, committerEmail },
          // The merge above put the repository's own published history under
          // HEAD. It has to keep its object ids: rewriting it would leave the
          // import branch sharing no ancestry with the branch the pull request
          // targets, and the whole repository would read as republished.
          mergedExistingHistory
            ? { publishedRef: `refs/remotes/origin/${destinationBranch}` }
            : undefined,
        );
      }
    } catch {
      // ignore — see above; the push is the authority on whether this mattered
    }
    // A repository that already has history keeps its default branch under whatever
    // protection the operator put on it: publish onto an import branch and let a
    // pull request carry the history in. A straight push onto the default branch is
    // reserved for the empty repository this flow was written for — there is nothing
    // to review there, and nothing a ruleset would reject. Where a rule does exist,
    // the direct push fails with "retry to recover", which no retry ever satisfies.
    let importBranch: string | undefined;
    if (mergedExistingHistory) {
      const mergedHead = (
        await this.git(['-C', clonePath, 'rev-parse', '--verify', 'HEAD'])
      ).stdout.trim();
      const remoteShaByBranch = new Map(
        remoteHeads
          .map((line) => line.split(/\s+/))
          .flatMap(([sha, ref]) =>
            sha !== undefined && ref !== undefined && ref.startsWith('refs/heads/')
              ? [[ref.slice('refs/heads/'.length), sha] as const]
              : [],
          ),
      );
      // Reuse the branch when it already carries this exact merge — a retry after a
      // pull request that failed to open must not litter the repository with
      // `-2`, `-3`, … copies of the same import.
      const base = `verity/import-${branch}`;
      importBranch = base;
      for (
        let attempt = 2;
        remoteShaByBranch.has(importBranch) && remoteShaByBranch.get(importBranch) !== mergedHead;
        attempt++
      ) {
        importBranch = `${base}-${String(attempt)}`;
      }
    }
    const pushTarget =
      importBranch === undefined
        ? destinationBranch === branch
          ? branch
          : `${branch}:${destinationBranch}`
        : `HEAD:refs/heads/${importBranch}`;
    try {
      await this.git([
        '-C',
        clonePath,
        '-c',
        `http.extraheader=${authHeader}`,
        'push',
        // `-u` only where the pushed branch IS the project's lasting upstream. The
        // import branch is transport for one pull request; pointing the local branch
        // at it would outlive the merge that retires it.
        ...(importBranch === undefined ? ['-u'] : []),
        'origin',
        pushTarget,
      ]);
    } catch (cause) {
      // The push result is ambiguous: GitHub may have accepted it before the
      // connection failed. Restore the local branch while preserving dirty
      // working-tree changes, but retain origin + the identity reservation so
      // a retry can fetch an accepted merge or recreate a rejected one.
      let rollbackCause: unknown;
      if (mergedExistingHistory) {
        try {
          await this.git(['-C', clonePath, 'reset', '--merge', localHead]);
        } catch (error) {
          rollbackCause = error;
        }
      }
      // Keep a matching origin even when this command reports failure. The
      // server cannot know whether GitHub accepted the update before the network
      // broke; the next attempt uses origin + exact remote HEAD to recover.
      const failure =
        rollbackCause === undefined
          ? commandFailureMessage(cause)
          : `${commandFailureMessage(cause)}; restoring the local branch also failed: ${commandFailureMessage(rollbackCause)}`;
      const safeCause = new Error(redactSensitive(failure, [token, authHeader]));
      throw new AmbiguousGitPushError(
        `pushing ${importBranch ?? branch} to ${target.owner}/${target.repo} failed; retry to recover`,
        safeCause,
      );
    }
    if (importBranch === undefined) return {};
    // The branch is published. A pull request that cannot be opened is REPORTED,
    // never rolled back: the operator can open it by hand from a branch that is
    // already on GitHub, whereas failing the link here would strand that branch
    // behind a project that still believes it is local.
    if (this.opts.openPullRequest === undefined || token === undefined) {
      return { importBranch, pullRequestError: 'opening pull requests is not configured' };
    }
    try {
      const pullRequest = await this.opts.openPullRequest(target, token, {
        head: importBranch,
        base: destinationBranch,
        title: `Import the ${project.repo} project history`,
        body:
          `Verity linked the local project \`${project.repo}\` to this repository.\n\n` +
          `\`${importBranch}\` carries the project's history, merged with the existing ` +
          `\`${destinationBranch}\` (unrelated histories; the project's own files win any ` +
          `conflict). Merging this pull request publishes it.`,
      });
      return { importBranch, pullRequest };
    } catch (cause) {
      return {
        importBranch,
        pullRequestError: redactSensitive(
          cause instanceof Error ? cause.message : 'opening the pull request failed',
          [token, authHeader],
        ),
      };
    }
  }

  async syncProjectCheckout(projectId: string): Promise<void> {
    await this.serializeProjectCheckoutOperation(projectId, async () => {
      const project = await this.opts.store.getProject(projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      await this.doClone(project);
    });
  }

  /** Container create + start, then transition to `active`. On failure
   *  transitions to `failed` and throws — the `failed` write is OUTSIDE the
   *  lock so a throw doesn't roll it back.
   *
   *  `forcePull` (ADR 0004): the recreate ("Update & restart") path passes
   *  `true` so the target image is actively re-fetched before create; the
   *  normal provision path leaves it `false` and keeps its lazy pull-on-miss
   *  behavior. */
  private async runContainerPhase(
    project: ProjectRecord,
    forcePull = false,
    opts: RecreateContainerOptions = {},
  ): Promise<ProjectRecord> {
    const run = () => this.runContainerPhaseUnlocked(project, forcePull, opts);
    return !forcePull && this.opts.withContainerReplace
      ? this.opts.withContainerReplace(project, run)
      : run();
  }

  private async runContainerPhaseUnlocked(
    project: ProjectRecord,
    forcePull = false,
    opts: RecreateContainerOptions = {},
  ): Promise<ProjectRecord> {
    const relayAttempt = { started: false };
    try {
      return await this.runContainerPhaseAttempt(project, forcePull, opts, relayAttempt);
    } catch (error) {
      if (relayAttempt.started) {
        try {
          await this.opts.projectRelay.stop(project.id);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `project relay rollback failed: ${project.id}`,
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
  }

  private async runContainerPhaseAttempt(
    project: ProjectRecord,
    forcePull = false,
    opts: RecreateContainerOptions = {},
    relayAttempt: { started: boolean } = { started: false },
  ): Promise<ProjectRecord> {
    await this.opts.store.updateProjectState(project.id, 'container_starting');
    const dirs = projectDirs(this.opts.hostCloneRoot, project);
    const preflightWarning = this.devcontainerWarningForProject(project);
    if (preflightWarning !== null && opts.confirmWarnings !== true) {
      await this.opts.store.updateProjectState(
        project.id,
        'failed',
        `provision requires confirmation: ${preflightWarning}`,
      );
      throw new ProvisioningWarning([preflightWarning]);
    }
    let image: ProjectImage;
    try {
      image = await this.resolveOrBuildImage(project, dirs, opts.forceRebuild === true);
    } catch (cause) {
      // The build runs with `{ ...process.env, DOCKER_HOST }`, so its stderr can
      // echo a token that lives in the server env. Redact before it lands in the
      // operator-visible `provision_error` — mirrors the git-clone failure path.
      const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
      const detail = redactSensitive(buildFailureMessage(cause), [
        token,
        process.env.GH_TOKEN,
        process.env.VERITY_REGISTRY_AUTH,
      ]);
      const message = `devcontainer build failed: ${detail}`;
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }
    const settings = await this.opts.store.getProjectSettings(project.id);
    // Central settings carry git identity/signing material. Doppler credentials
    // stay broker-side and are never part of project provisioning.
    let veritySettings: VeritySettingsRecord | undefined;
    try {
      veritySettings = await this.opts.veritySettings?.();
    } catch (cause) {
      if (!(cause instanceof SealedError)) throw cause;
      veritySettings = undefined;
    }
    const signingKey = resolveSigningPrivateKey(veritySettings);
    if (signingKey !== null && this.opts.gitSecretRoot === undefined) {
      throw new ProvisioningError(
        'project relay signing requires gitSecretRoot for capability material',
      );
    }
    await this.opts.store.reconcileDevServerHostPorts(project.id);
    const devServers = await this.opts.store.listDevServers(project.id);
    const portBindings = projectPortBindings(
      devServers.length > 0
        ? devServers.map((server) => ({
            devServerHostPort: server.hostPort,
            devServerContainerPort: server.containerPort,
          }))
        : settings,
    );
    const pathMode = image.usesDevcontainerImage ? 'neutral' : 'home';
    const devcontainerRuntime = image.usesDevcontainerImage
      ? devcontainerRuntimeSettings(join(dirs.clonePath, '.devcontainer'))
      : {};
    const devcontainerWarning = image.usesDevcontainerImage
      ? devcontainerProvisionWarning(devcontainerRuntime)
      : null;
    const usesManagedDefaultImage =
      !image.usesDevcontainerImage &&
      !image.usesConfiguredOverride &&
      this.opts.runnerSupervisorTrustedDefaultImage === true;
    // ADR 0006 D1: an image Verity did not build may still carry the boundary —
    // the toolkit Feature installs the same reserved identities into a project
    // devcontainer. It has to PROVE it. Attestation uses one stopped container
    // per provision, and only on the path that would otherwise be denied outright.
    const runnerBoundaryAttestation = await this.attestRunnerBoundary({
      imageRef: image.imageRef,
      skip: usesManagedDefaultImage || this.opts.runnerSupervisor !== true,
      ...(devcontainerRuntime.remoteUser !== undefined
        ? { user: devcontainerRuntime.remoteUser }
        : {}),
    });
    // Content identity of the toolkit THIS provisioning *verified* the image
    // against, recorded alongside the image so a later reader can tell an image
    // whose toolkit still matches from one whose toolkit is merely unknown.
    // Taken from the verdict itself, so it names exactly the bytes that were
    // compared. Only a pass earns one; everything else records `null`:
    //
    // - Skipped — the managed default image is trusted by configuration, not by
    //   comparison, and its toolkit was baked whenever that image was built.
    //   Claiming it matches this Server's bundle is precisely the false
    //   all-clear the drift report exists to remove.
    // - Failed — the image WAS compared and carries something else. What that
    //   is, is unknown; the provision already warns about it.
    // - Supervisor off — nothing was compared.
    //
    // `null` overwrites a previously recorded value on purpose: a verdict
    // belongs to one image, and this provisioning installed a new one.
    const recordedToolkitIdentity =
      runnerBoundaryAttestation?.ok === true ? runnerBoundaryAttestation.toolkitIdentity : null;
    const runnerBoundarySafe = runnerSupervisorBoundarySafe({
      usesManagedDefaultImage,
      allowPrivilegeEscalation: this.opts.sandboxAllowPrivilegeEscalation === true,
      capAdd: this.opts.sandboxCapAdd,
      ...(runnerBoundaryAttestation !== undefined
        ? { attestedBoundary: runnerBoundaryAttestation.ok }
        : {}),
    });
    const runnerRuntimeEnabled = this.opts.runnerSupervisor === true && runnerBoundarySafe;
    const runnerBoundaryWarning =
      this.opts.runnerSupervisor === true && !runnerBoundarySafe
        ? runnerBoundaryAttestation !== undefined && !runnerBoundaryAttestation.ok
          ? `Runner supervisor is disabled for this Sandbox because the ADR 0006 boundary attestation failed: ${runnerBoundaryAttestation.reason}.`
          : 'Runner supervisor is disabled for this Sandbox because the ADR 0006 security boundary rejects added capabilities or privilege escalation.'
        : null;
    const provisionWarning =
      [devcontainerWarning, runnerBoundaryWarning]
        .filter((warning): warning is string => warning !== null)
        .join(' ') || null;
    const { selected: projectClaudeGateway, url: claudeGateway } =
      this.resolveRelayClaudeGateway(project);
    const codexGateway = resolvedCodexGatewayUrl(
      this.opts.claudeEgressGatewayUrl,
      this.opts.codexEgressGatewayUrl,
    );
    const canonicalClaudeGatewayUrl = claudeGateway.href;
    const canonicalCodexGatewayUrl = codexGateway.href;
    const sandboxNetwork = projectNetworkName(project.id);
    await this.opts.docker.ensureNetwork!(sandboxNetwork, {
      labels: { 'verity.project-id': project.id },
    });
    // Capabilities are currently one-row-per-project, so two generations cannot
    // authenticate concurrently. Fail closed: retire the old Sandbox before
    // revoking its relay, then construct the complete replacement generation.
    if (!forcePull) await stopAndRemoveExistingContainer(this.opts.docker, project.containerName);
    await this.opts.projectRelay.stop(project.id);
    const relayActivation = await this.opts.projectRelay.start(
      this.relayBinding(project, randomUUID()),
    );
    relayAttempt.started = true;
    const effectiveBrokerUrl = this.opts.projectRelay.brokerUrl(relayActivation);
    const effectiveClaudeGatewayUrl = this.opts.projectRelay.claudeGatewayUrl(relayActivation);
    const effectiveCodexGatewayUrl =
      this.opts.projectRelay.codexGatewayUrl?.(relayActivation) ??
      `https://${new URL(effectiveClaudeGatewayUrl).hostname}:8444`;
    // A relay terminates TLS with the SAME gateway leaf (CN/SAN = the configured
    // gateway server name) while the URL above addresses it by container name.
    // Dropping the pin here would leave the connector verifying the certificate
    // against `verity-relay-<id>`, which no SAN covers — every Claude turn then
    // fails the handshake and the connector reports a 502.
    const effectiveClaudeServerName =
      projectClaudeGateway?.serverName ?? this.opts.claudeEgressServerName;
    // Commit-signing broker (audit H1): active when the deployment configured a
    // broker URL, a signing key exists, and Verity can materialize bind-mounted
    // secrets. Then the private key is NOT mounted; the sandbox signs via
    // POST /internal/git/sign, authenticating with a file-mounted token derived
    // from the key (the server re-derives + checks the same value).
    // The effective signing key — DB contents OR the file at gitSshPrivateKeyPath
    // (the fleet default). Broker mode needs a key server-side; the sandbox never
    // gets it. Derive the sandbox token from THIS same resolution so it matches the
    // /internal/git/sign endpoint (which resolves identically).
    // Signing is broker-only. If a signing key is configured but no broker is wired,
    // fail closed — we refuse to fall back to mounting the key into the sandbox
    // (that legacy compatibility path is gone). Never a silent key mount.
    if (signingKey !== null && effectiveBrokerUrl === undefined) {
      const message =
        'a git signing key is configured but no signing broker is wired ' +
        'through the project relay. Signing is broker-only — the key is never ' +
        'mounted into a sandbox.';
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message);
    }
    // Named-volume fail-closed (security review follow-up). When a data volume is
    // configured, EVERY per-project mount source must live under dataVolumeRoot so
    // partitionProjectMounts turns it into a volume subpath a sibling can resolve.
    // A source outside the volume root would SILENTLY stay a host bind and the
    // sibling would boot with an empty mount (no repo / missing signing material).
    // Assert the roots + any file-path-based git material up front instead.
    if (this.opts.dataVolume !== undefined && this.opts.dataVolumeRoot !== undefined) {
      const root = this.opts.dataVolumeRoot.replace(/\/+$/, '');
      const underRoot = (p: string | null | undefined): boolean =>
        p === null || p === undefined || p.length === 0 || p === root || p.startsWith(`${root}/`);
      const offenders: string[] = [];
      if (!underRoot(this.opts.hostCloneRoot))
        offenders.push(`hostCloneRoot=${this.opts.hostCloneRoot}`);
      if (!underRoot(this.opts.gitSecretRoot))
        offenders.push(`gitSecretRoot=${this.opts.gitSecretRoot}`);
      // Path-based (non-inline) git material is mounted from its own host path; with
      // a data volume it must also live under the root (or use inline DB material).
      for (const [name, value] of [
        ['gitSshPublicKeyPath', veritySettings?.gitSshPublicKeyPath],
        ['gitKnownHostsPath', veritySettings?.gitKnownHostsPath],
        ['gitAllowedSignersPath', veritySettings?.gitAllowedSignersPath],
      ] as const) {
        if (!underRoot(value)) offenders.push(`${name}=${value}`);
      }
      if (offenders.length > 0) {
        const message =
          `data volume '${this.opts.dataVolume}' is configured but these mount sources are ` +
          `outside its root '${root}': ${offenders.join(', ')}. They would silently become ` +
          `host binds a sibling container cannot resolve. Put them under the data root, or ` +
          `use inline DB-stored git material instead of file paths.`;
        await this.opts.store.updateProjectState(project.id, 'failed', message);
        throw new ProvisioningError(message);
      }
    }
    const signingBrokerToken = signingKey === null ? undefined : relayActivation.signingCapability;
    const brokerMode = signingBrokerToken !== undefined && this.opts.gitSecretRoot !== undefined;
    // The private signing key is NEVER mounted (broker-only, H4/H5) — gitSettingsBinds
    // only mounts the non-secret public key + known_hosts + allowed_signers.
    const gitBinds = gitSettingsBinds(veritySettings, this.opts.gitSecretRoot, pathMode);
    const gitEnv = gitSettingsEnv(veritySettings);
    // The sandbox authenticates to the broker with a token derived from the signing
    // key, delivered as a read-only FILE mount (#662) — NOT env, so it never shows up
    // in `docker inspect`. The wrapper reads it from SIGNING_BROKER_TOKEN_FILE.
    const signingBrokerTokenPath =
      brokerMode && signingBrokerToken !== undefined && this.opts.gitSecretRoot !== undefined
        ? writeSecretFile(
            this.opts.gitSecretRoot,
            `signing_broker_token.${signingBrokerTokenHash(signingBrokerToken)}`,
            signingBrokerToken,
            'git',
            0o644,
          )
        : undefined;
    const signingBrokerBinds =
      signingBrokerTokenPath !== undefined
        ? [`${signingBrokerTokenPath}:${SIGNING_BROKER_TOKEN_FILE}:ro`]
        : [];
    const signingBrokerTokenDigest =
      brokerMode && signingBrokerToken !== undefined
        ? signingBrokerTokenHash(signingBrokerToken)
        : undefined;
    const signingBrokerEnv = brokerMode
      ? [
          `VERITY_SIGNING_URL=${effectiveBrokerUrl}`,
          `VERITY_SIGNING_DOCKER_CONTAINER=${project.containerName}`,
          // The actual GIT_CONFIG_* entries are assembled below together with
          // the GitHub credential helper. Keep this block to broker endpoint env
          // only so both features can coexist without clobbering indexes.
        ]
      : [];
    // GitHub-token broker (security review): issue a per-container capability and
    // mount it (plus the endpoint URL) so the sandbox's credential helper / gh
    // wrapper redeem it on demand at POST /internal/github/token — no GitHub token
    // is written into the sandbox. The capability is a read-only FILE (like the
    // signing token, #662), so it never shows up in `docker inspect`; the URL is
    // non-secret env. Requires the broker URL (same internal listener as signing)
    // and a secret root to materialize the file into.
    let ghTokenCapabilityPath: string | undefined;
    if (
      this.opts.ghTokenCapabilities !== undefined &&
      effectiveBrokerUrl !== undefined &&
      this.opts.gitSecretRoot !== undefined
    ) {
      // issue() persists the capability hash (DB) before we materialize the raw
      // secret into the sandbox, so a redeem right after start always resolves.
      const capability = relayActivation.githubCapability;
      ghTokenCapabilityPath = writeSecretFile(
        this.opts.gitSecretRoot,
        `gh_token_capability.${project.id}`,
        capability,
        'git',
        0o644,
      );
    }
    const ghTokenBrokerBinds =
      ghTokenCapabilityPath !== undefined
        ? [`${ghTokenCapabilityPath}:${GH_TOKEN_CAPABILITY_FILE}:ro`]
        : [];
    const ghTokenBrokerEnv =
      ghTokenCapabilityPath !== undefined
        ? [
            `VERITY_GH_TOKEN_URL=${effectiveBrokerUrl.replace(/\/+$/, '')}/internal/github/token`,
            `VERITY_GH_TOKEN_DOCKER_CONTAINER=${project.containerName}`,
            `VERITY_GH_TOKEN_CAPABILITY_FILE=${GH_TOKEN_CAPABILITY_FILE}`,
            // Per-project agent memory broker (ADR 0008). Same internal listener and
            // per-container capability as the gh-token broker; `verity-memory` redeems
            // the capability to append to this project's memory (POST /internal/project/memory).
            `VERITY_PROJECT_MEMORY_URL=${effectiveBrokerUrl.replace(/\/+$/, '')}/internal/project/memory`,
          ]
        : [];
    // Loopback MCP gateway (ADR 0014 D1). Same internal listener again, but no
    // capability file: the bearer that authenticates a call is minted per TURN and
    // handed to the ACP agent with `session/new`, and a container-lifetime file would
    // outlive the turn it belongs to. Having no capability is also why this is gated on
    // the broker URL alone — the brokered tools have nothing to do with GitHub, so a
    // project with no gh-token capability still gets them.
    const mcpGatewayEnv =
      effectiveBrokerUrl !== undefined
        ? [`VERITY_MCP_GATEWAY_URL=${effectiveBrokerUrl.replace(/\/+$/, '')}/internal/mcp`]
        : [];
    // Claude-egress mTLS projection (ADR 0006 D10): materialize ONLY the public CA
    // + this project's own client identity and hand the connector its coordinates.
    // The CA private key and the OAuth token never cross this boundary. Gated
    // all-or-nothing (identity service + gateway URL + connector port + secret
    // root) so it stays dormant until a deployment opts in; starts NO gateway. The
    // three PEMs are read-only FILE mounts (never env, like the gh-token/signing
    // secrets), and the key is chowned to the Runner uid so the connector — which
    // drops to that uid — reads it while the agent uid cannot.
    //
    // The Codex gateway pair is built in the same env array below, so this
    // Claude-shaped gate also decides whether Codex routing reaches the
    // container at all. That coupling is deliberate, not an oversight: the
    // connector presents the SAME client identity on both legs (one `tls: {ca,
    // cert, key}` for /v1/messages and /codex/responses alike), so the material
    // these binds project is what authenticates Codex too. A deployment without
    // a Claude egress identity has nothing to authenticate a Codex forward with
    // either, and shipping the Codex URLs alone would only move the failure from
    // "unconfigured" to a TLS rejection at the gateway.
    let claudeEgressBinds: string[] = [];
    let egressConnectorEnv: string[] = [];
    if (
      this.opts.claudeEgressIdentity !== undefined &&
      effectiveClaudeGatewayUrl !== undefined &&
      this.opts.claudeConnectorPort !== undefined &&
      this.opts.gitSecretRoot !== undefined
    ) {
      const material = await this.opts.claudeEgressIdentity.sandboxMaterial(project.id);
      const caPath = writeSecretFile(
        this.opts.gitSecretRoot,
        `egress_ca.${project.id}.crt`,
        material.caCertPem,
        'claude-egress',
        0o644,
      );
      const certPath = writeSecretFile(
        this.opts.gitSecretRoot,
        `egress_client.${project.id}.crt`,
        material.clientCertPem,
        'claude-egress',
        0o644,
      );
      const keyPath = writeSecretFile(
        this.opts.gitSecretRoot,
        `egress_client.${project.id}.key`,
        material.clientKeyPem,
        'claude-egress',
        0o600,
      );
      (this.opts.chownRunnerFile ?? defaultChownRunnerFile)(keyPath, {
        uid: this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID,
        gid: this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID,
      });
      const port = String(this.opts.claudeConnectorPort);
      claudeEgressBinds = [
        `${caPath}:${CLAUDE_EGRESS_CA_FILE}:ro`,
        `${certPath}:${CLAUDE_EGRESS_CERT_FILE}:ro`,
        `${keyPath}:${CLAUDE_EGRESS_KEY_FILE}:ro`,
      ];
      egressConnectorEnv = [
        `VERITY_RUNNER_RUNTIME_UID=${String(this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID)}`,
        `VERITY_RUNNER_RUNTIME_GID=${String(this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`,
        `VERITY_CLAUDE_CONNECTOR_PORT=${port}`,
        `VERITY_CLAUDE_CONNECTOR_AUTHORITY=127.0.0.1:${port}`,
        `VERITY_CLAUDE_EGRESS_URL=${effectiveClaudeGatewayUrl.replace(/\/+$/, '')}`,
        `VERITY_CLAUDE_EGRESS_AUTHORITY=${new URL(canonicalClaudeGatewayUrl).host}`,
        `VERITY_CODEX_EGRESS_URL=${effectiveCodexGatewayUrl.replace(/\/+$/, '')}`,
        `VERITY_CODEX_EGRESS_AUTHORITY=${new URL(canonicalCodexGatewayUrl).host}`,
        `VERITY_CLAUDE_EGRESS_CA=${CLAUDE_EGRESS_CA_FILE}`,
        `VERITY_CLAUDE_EGRESS_CERT=${CLAUDE_EGRESS_CERT_FILE}`,
        `VERITY_CLAUDE_EGRESS_KEY=${CLAUDE_EGRESS_KEY_FILE}`,
        ...(effectiveClaudeServerName !== undefined
          ? [`VERITY_CLAUDE_EGRESS_SERVERNAME=${effectiveClaudeServerName}`]
          : []),
      ];
    }
    const gitRuntimeConfig: Array<{ key: string; value: string }> = [];
    if (brokerMode) {
      // Point git's SSH signing program at the broker wrapper via GIT_CONFIG_*
      // env (image-agnostic: no per-image bake needed). The wrapper is
      // transparent without broker env, but we only inject it in broker mode.
      gitRuntimeConfig.push({
        key: 'gpg.ssh.program',
        value: '/opt/agent-seed/bin/verity-git-sign',
      });
    }
    if (ghTokenCapabilityPath !== undefined) {
      // Do not rely on verity-agent-run having already reconciled ~/.gitconfig:
      // devcontainer-derived sandboxes can carry an older entrypoint while the
      // server/provisioner has moved to the broker capability model. Injecting
      // the helper here makes every git invocation in agent sessions work
      // immediately, including `docker exec` turns and interactive shells.
      gitRuntimeConfig.push({
        key: 'credential.https://github.com.helper',
        value: '/opt/agent-seed/bin/verity-gh-cred',
      });
    }
    const gitRuntimeConfigEnv =
      gitRuntimeConfig.length === 0
        ? []
        : [
            `GIT_CONFIG_COUNT=${gitRuntimeConfig.length}`,
            ...gitRuntimeConfig.flatMap((entry, index) => [
              `GIT_CONFIG_KEY_${index}=${entry.key}`,
              `GIT_CONFIG_VALUE_${index}=${entry.value}`,
            ]),
          ];
    // On the runner-supervisor path the Claude config/transcript home lives on
    // the shared runner-runtime mount (RUNNER_RUNTIME_TARGET ↔
    // <dataVolumeRoot>/runners/<projectId>), so the in-sandbox Claude worker
    // writes projects/<encodeCwd(cwd)>/<sessionId>.jsonl exactly where the
    // server-side tail persists it (`<dataVolumeRoot>/runners/<projectId>/claude`,
    // PR #938). Auth is the CLAUDE_CODE_OAUTH_TOKEN env (egress placeholder), not
    // a file under this dir, and nothing is bind-mounted into it, so the move is
    // credential-safe. Off the runner-supervisor path this is byte-identical to
    // today (`/run/verity/claude` for neutral devcontainer images, otherwise
    // `/home/dev/.claude`).
    const claudeConfigDir = runnerRuntimeEnabled
      ? `${RUNNER_RUNTIME_TARGET}/claude`
      : pathMode === 'neutral'
        ? '/run/verity/claude'
        : '/home/dev/.claude';
    const codexHome = '/run/verity/codex';
    if (runnerRuntimeEnabled && this.opts.dockerHostForBuild === undefined) {
      const message = 'Runner supervisor requires dockerHostForBuild';
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message);
    }
    let runnerRuntimePath: string | undefined;
    try {
      runnerRuntimePath = this.prepareRunnerRuntime(project.id, runnerRuntimeEnabled);
    } catch (cause) {
      const message = `Runner runtime preparation failed: ${failureMessage(cause)}`;
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }
    const agentSeedHostPath = this.opts.agentSeedHostPath ?? '/opt/agent-seed';
    // Strip the local clone's config down to what Verity recognizes BEFORE the mount
    // below freezes it, so an entry an earlier session wrote is removed rather than
    // preserved for good. Failing here fails the provision on purpose. Probed once:
    // the sanitizer and the mount have to be talking about the same file.
    const localConfig = isLocalProject(project)
      ? this.localConfigState(dirs.clonePath)
      : ('absent' as LocalConfigState);
    try {
      await this.sanitizeLocalCloneConfig(project, dirs.clonePath, localConfig);
    } catch (cause) {
      const message = `local clone config could not be sanitized: ${failureMessage(cause)}`;
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }
    // Per-project data (the /work clone + materialized secrets) lives under the
    // data volume, so those mounts become named-volume subpaths a sibling can
    // resolve by name; deploy-level mounts (agent-seed, /dev/null, devcontainer)
    // stay host binds. With no data volume configured, everything stays a bind.
    const { binds: specBinds, volumeMounts } = partitionProjectMounts(
      [
        `${dirs.clonePath}:/work`,
        ...localCloneConfigBind(project, dirs.clonePath, localConfig),
        ...(runnerRuntimePath !== undefined
          ? [`${runnerRuntimePath}:${RUNNER_RUNTIME_TARGET}`]
          : []),
        `${agentSeedHostPath}:/opt/agent-seed:ro`,
        '/dev/null:/etc/profile.d/gh-token.sh:ro',
        ...ghTokenBrokerBinds,
        ...claudeEgressBinds,
        ...agentConfigBinds(this.opts, pathMode),
        ...gitBinds,
        ...signingBrokerBinds,
        ...codexGatewayConfigBind(
          this.opts.gitSecretRoot,
          codexHome,
          this.opts.claudeConnectorPort,
        ),
        ...(devcontainerRuntime.binds ?? []),
      ],
      this.opts.dataVolume,
      this.opts.dataVolumeRoot,
    );
    // Bound once, then used for BOTH `Memory` and `MemorySwap` below, so the two can
    // never drift apart when someone changes where the ceiling comes from.
    const sandboxMemoryBytes = this.opts.sandboxMemoryBytes ?? DEFAULT_SANDBOX_MEMORY_BYTES;
    const spec: ContainerSpec = {
      image: image.imageRef,
      name: dirs.containerName,
      binds: specBinds,
      ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
      labels: {
        [PROJECT_ID_LABEL]: project.id,
        ...(effectiveClaudeGatewayUrl === undefined
          ? {}
          : { [CLAUDE_EGRESS_GATEWAY_URL_LABEL]: effectiveClaudeGatewayUrl }),
        // Stamp the relay generation onto the sandbox (Stage 5) so migration can
        // tell a relay-era sandbox apart from a pre-relay legacy one. Only a
        // relay-activated generation carries it; the shared-network legacy path
        // leaves it absent, which is exactly what classifyProjectContainer keys on.
        ...(relayActivation !== undefined
          ? { [CONTAINER_GENERATION_LABEL]: relayActivation.identity.containerGeneration }
          : {}),
        ...(signingBrokerTokenDigest !== undefined
          ? { [SIGNING_BROKER_TOKEN_HASH_LABEL]: signingBrokerTokenDigest }
          : {}),
      },
      env: [
        `CLAUDE_CONFIG_DIR=${claudeConfigDir}`,
        `CODEX_HOME=${codexHome}`,
        'VERITY_CODEX_PLACEHOLDER=verity-codex-gateway-placeholder-v1',
        ...(runnerRuntimePath !== undefined
          ? [
              `VERITY_RUNNER_RUNTIME=${RUNNER_RUNTIME_TARGET}`,
              `VERITY_RUNNER_RUNTIME_UID=${String(this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID)}`,
              `VERITY_RUNNER_RUNTIME_GID=${String(this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`,
              `VERITY_AGENT_UID=${String(RUNNER_AGENT_UID)}`,
              `VERITY_AGENT_GID=${String(RUNNER_AGENT_GID)}`,
            ]
          : []),
        // Claude Code: ask it to skip its own bubblewrap bash sandbox since THIS
        // container already is the sandbox. NOTE: in practice this hint is not
        // honored reliably — wherever `bwrap` is on PATH, Claude spawns it before
        // every command anyway. It is kept as a harmless best effort (honored by
        // some versions), never as the mechanism; the seccomp + AppArmor
        // relaxation on securityOpt below is what actually makes bwrap survive.
        //
        // The baked verity-sandbox image deliberately ships NO bubblewrap —
        // features/verity-sandbox-toolkit/install.sh installs none — so on the
        // default image nothing spawns it at all. Do not "fix" a bwrap warning by
        // adding the package: that would switch ON an inner sandbox that is
        // redundant with this container and is documented in
        // to break sessions — it either fails the unprivileged user-namespace
        // clone or loses the injected
        // /etc/resolv.conf, taking DNS with it. Only a project whose own
        // devcontainer installs bubblewrap gets the inner sandbox, and it is the
        // securityOpt relaxation below that keeps the first of those two from
        // happening there.
        //
        // Codex needs no env hint: codex-acp starts turns with
        // sandbox 'danger-full-access', so Codex never spawns
        // its own sandbox. Its "Codex could not find bubblewrap on PATH." line —
        // logged at ERROR level on every start — is therefore noise, not an
        // unmet prerequisite. It has already once been mistaken for the cause of
        // a turn that actually died on a broken egress route.
        'IS_SANDBOX=1',
        // GitHub-token broker: endpoint URL (non-secret env) + the capability file
        // path. The sandbox redeems the capability for a repo-scoped token; no
        // GitHub token is materialized into the container.
        ...ghTokenBrokerEnv,
        // Loopback MCP gateway: endpoint URL only. The per-turn bearer arrives with
        // `session/new`, so nothing about this one is container-lifetime.
        ...mcpGatewayEnv,
        // Egress connector coordinates (non-secret: ports, gateway URLs, and the
        // three container FILE PATHS). The PEMs themselves ride the read-only
        // file mounts above, never env.
        //
        // BOTH legs, despite the VERITY_CLAUDE_* prefixes: the connector serves
        // /v1/messages and /codex/responses from one process, so the Codex
        // gateway pair rides here too. Those prefixes are a container/Feature
        // contract and cannot be renamed casually — which is exactly why this
        // array must not read as Claude-only. Naming it that way is how the
        // Codex vars came to be omitted from the launcher's env -i allowlist,
        // leaving every Codex turn to 502 against a gateway the Sandbox had.
        // That allowlist was fixed in #1632; the name is corrected here so the
        // next var added for a non-Claude leg is not dropped the same way.
        ...egressConnectorEnv,
        ...(pathMode === 'neutral'
          ? ['XDG_CONFIG_HOME=/run/verity/xdg', 'PI_CONFIG_DIR=/run/verity/pi']
          : []),
        'PATH=/opt/agent-seed/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        // Commit-signing broker (audit H1): the endpoint URL is env, while the
        // key-derived bearer token is mounted as a secret file. Present only in
        // broker mode; the sandbox never receives the private key.
        ...signingBrokerEnv,
        ...gitRuntimeConfigEnv,
        ...gitEnv,
      ],
      ...(devcontainerRuntime.remoteUser !== undefined
        ? { user: devcontainerRuntime.remoteUser }
        : {}),
      ...(portBindings.length > 0 ? { portBindings } : {}),
      ...(image.usesDevcontainerImage
        ? {
            entrypoint: DEVCONTAINER_TOOLKIT_ENTRYPOINT,
            command: devcontainerToolkitCommand(
              devcontainerRuntime.postCreateCommand !== undefined,
            ),
          }
        : {}),
      restartPolicy: 'unless-stopped',
      // Runtime hardening (security review C1): contain a malicious dependency by
      // default rather than launching with Docker's permissive defaults. Drop all
      // capabilities, block privilege escalation (setuid), and cap PIDs (fork-bomb
      // guard); apply memory/CPU ceilings when configured. A project whose
      // devcontainer needs sudo or a capability can relax this per deployment via
      // VERITY_SANDBOX_ALLOW_PRIVILEGE_ESCALATION / VERITY_SANDBOX_CAP_ADD.
      capDrop: ['ALL'],
      ...(runnerRuntimeEnabled
        ? { capAdd: [...RUNNER_BROKER_CAPABILITIES] }
        : this.opts.sandboxCapAdd?.length
          ? { capAdd: this.opts.sandboxCapAdd }
          : {}),
      // seccomp=unconfined + apparmor=unconfined are what let an agent's own
      // bubblewrap sandbox run inside this container. Docker's default seccomp
      // profile blocks the unprivileged user-namespace clone, and the
      // docker-default AppArmor profile blocks bwrap's mount-propagation setup
      // ("Failed to make / slave"). IS_SANDBOX=1 (set in env above) was meant to
      // make the agents skip bwrap entirely — but Claude does NOT honor it
      // reliably: where bwrap exists it runs before every command and fails
      // ("No permissions to create a new namespace"), which made the whole
      // sandbox unusable. cap-drop ALL + no-new-privileges are kept, so the
      // container still cannot gain capabilities or escalate via setuid; only
      // the seccomp + AppArmor syscall/LSM filters are lifted (the container +
      // per-project network isolation + pidsLimit remain the boundary).
      // Verified: cap-drop ALL + no-new-privileges + these two unconfines is the
      // minimal combo under which `bwrap --unshare-user` succeeds.
      //
      // That verification dates from the retired dev-base image, which shipped
      // bubblewrap. The current verity-sandbox image does not, so on the default
      // image these two relaxations currently guard nobody — they still matter
      // for a project devcontainer that installs bubblewrap itself. Re-confining
      // seccomp/AppArmor is therefore a live option, but it is a deliberate
      // security decision (and would break exactly those projects), not a
      // cleanup to fold into an unrelated change.
      securityOpt: [
        ...(this.opts.sandboxAllowPrivilegeEscalation === true ? [] : ['no-new-privileges:true']),
        'seccomp=unconfined',
        'apparmor=unconfined',
      ],
      pidsLimit: this.opts.sandboxPidsLimit ?? 512,
      memoryBytes: sandboxMemoryBytes,
      // Pin the combined memory+swap ceiling TO the memory ceiling, which is how a
      // cgroup is told the container may not swap. Leaving it out is not neutral:
      // Docker then grants twice the memory limit as the combined ceiling, so every
      // sandbox silently gained an extra 4 GiB of swap allowance (observed in prod:
      // mem=4G/memswap=8G on all five sandboxes, against 4 GiB of host swap in total).
      // The effect is the opposite of what the memory cap is for — a runaway test run
      // does not OOM inside its own cgroup where the session can see it and report it,
      // it swaps, gets orders of magnitude slower, never finishes, and drags every
      // other container on the host down with it through the shared swap device.
      // Raise VERITY_SANDBOX_MEMORY if a project legitimately needs more headroom;
      // do not give the swap back.
      memorySwapBytes: sandboxMemoryBytes,
      // No core dumps. `kernel.core_pattern` is a shared host setting and is commonly
      // a relative filename, in which case the kernel writes the dump into the crashing
      // process's cwd — for an agent that is the session worktree, hundreds of MB per
      // crashed worker into a git checkout on a disk that is already the scarce resource.
      ulimits: [{ name: 'core', soft: 0, hard: 0 }],
      nanoCpus: this.opts.sandboxNanoCpus ?? DEFAULT_SANDBOX_NANO_CPUS,
      // Join the resolved sandbox network (per-project when H2 isolation is on, else
      // the shared internal network when configured) so — in broker mode — the
      // sandbox reaches the control-plane signing broker by service DNS name.
      ...(sandboxNetwork ? { network: sandboxNetwork } : {}),
    };
    try {
      let containerId: string;
      try {
        const shouldForcePull = forcePull && !image.usesDevcontainerImage;
        const created = await this.createContainerPullingIfMissing(spec, shouldForcePull);
        containerId = created.id;
      } catch (cause) {
        if (cause instanceof DockerError && cause.kind === 'conflict') {
          const inspect = await this.opts.docker
            .inspectContainer(dirs.containerName)
            .catch(() => null);
          containerId = inspect?.id ?? dirs.containerName;
        } else {
          throw cause;
        }
      }
      await this.opts.docker.startContainer(containerId);
    } catch (cause) {
      const message = `docker start failed: ${failureMessage(cause)}`;
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }
    try {
      await this.opts.onContainerStarted?.(project);
    } catch (cause) {
      const message = `post-start projection failed: ${failureMessage(cause)}`;
      await this.opts.docker.stopContainer(dirs.containerName).catch(() => undefined);
      await this.opts.docker.removeContainer(dirs.containerName).catch(() => undefined);
      // sandboxMaterial() may have issued a client certificate before container
      // creation. Once the running container is rolled back, revoke that identity
      // too so a failed/nonexistent sandbox cannot remain authorized.
      await this.opts.claudeEgressIdentity?.revokeProject(project.id).catch(() => undefined);
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }
    if (runnerRuntimePath !== undefined || egressConnectorEnv.length > 0) {
      try {
        if (this.opts.dockerHostForBuild === undefined) {
          throw new Error('Sandbox egress connector requires a Docker exec host');
        }
        if (runnerRuntimePath === undefined) {
          await this.containerCommand({
            containerName: dirs.containerName,
            dockerHost: this.opts.dockerHostForBuild,
            user: '0:0',
            workdir: '/',
            command: `test "$(stat -c %u /proc/1)" -ne ${String(this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID)}`,
          });
        }
        await this.containerCommand({
          containerName: dirs.containerName,
          dockerHost: this.opts.dockerHostForBuild,
          user:
            runnerRuntimePath !== undefined
              ? `0:${String(this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`
              : `${String(this.opts.runnerRuntimeUid ?? RUNNER_RUNTIME_UID)}:${String(this.opts.runnerRuntimeGid ?? RUNNER_RUNTIME_GID)}`,
          workdir: runnerRuntimePath !== undefined ? RUNNER_RUNTIME_TARGET : '/',
          command:
            runnerRuntimePath !== undefined
              ? 'verity-runner-stack-start'
              : 'verity-egress-connector-start --standalone',
        });
      } catch (cause) {
        const component =
          runnerRuntimePath !== undefined ? 'Runner supervisor' : 'Sandbox egress connector';
        const message = `${component} failed to start: ${commandFailureMessage(cause)}`;
        await this.opts.docker.stopContainer(dirs.containerName).catch(() => undefined);
        await this.opts.docker.removeContainer(dirs.containerName).catch(() => undefined);
        await this.opts.claudeEgressIdentity?.revokeProject(project.id).catch(() => undefined);
        await this.opts.store.updateProjectState(project.id, 'failed', message);
        throw new ProvisioningError(message, cause);
      }
    }
    let lifecycleFailureLabel = 'postCreateCommand';
    try {
      if (image.usesDevcontainerImage && this.opts.dockerHostForBuild !== undefined) {
        if (devcontainerRuntime.remoteUser !== undefined) {
          lifecycleFailureLabel = 'remoteUser secret access check';
          // The PRIVATE signing key is never mounted (broker-only signing), and the
          // gh token is no longer a mounted file — the sandbox holds only a broker
          // CAPABILITY, and only when one was issued for this project. So the probe
          // verifies the (still-mounted) signing PUBLIC key, plus the capability file
          // when present; a capability-less project must not fail readiness on it.
          const readinessChecks = gitBinds.some((bind) =>
            bind.includes(':/run/verity/ssh/id_ed25519.pub:'),
          )
            ? ['test -r /run/verity/ssh/id_ed25519.pub']
            : [];
          if (ghTokenCapabilityPath !== undefined) {
            readinessChecks.unshift(`test -r ${GH_TOKEN_CAPABILITY_FILE}`);
          }
          if (readinessChecks.length > 0) {
            await this.containerCommand({
              containerName: dirs.containerName,
              command: readinessChecks.join(' && '),
              dockerHost: this.opts.dockerHostForBuild,
              user: devcontainerRuntime.remoteUser,
              workdir: '/work',
            });
          }
        }
        if (devcontainerRuntime.postCreateCommand === undefined) {
          await this.opts.store.deleteProjectSessionBackendStates(project.id);
          await this.opts.store.recordProjectImageRef(
            project.id,
            image.imageRef,
            recordedToolkitIdentity,
          );
          return (await this.opts.store.updateProjectState(
            project.id,
            'active',
            null,
            provisionWarning,
          )) as ProjectRecord;
        }
        lifecycleFailureLabel = 'postCreateCommand';
        await this.containerCommand({
          containerName: dirs.containerName,
          command: devcontainerRuntime.postCreateCommand,
          dockerHost: this.opts.dockerHostForBuild,
          user: devcontainerRuntime.remoteUser,
          workdir: '/work',
        });
        await this.containerCommand({
          containerName: dirs.containerName,
          command: `touch ${DEVCONTAINER_POST_CREATE_READY_FILE}`,
          dockerHost: this.opts.dockerHostForBuild,
          user: devcontainerRuntime.remoteUser,
          workdir: '/work',
        });
      }
    } catch (cause) {
      const message = `devcontainer ${lifecycleFailureLabel} failed: ${commandFailureMessage(cause)}`;
      await this.opts.docker.stopContainer(dirs.containerName).catch(() => undefined);
      await this.opts.docker.removeContainer(dirs.containerName).catch(() => undefined);
      await this.opts.claudeEgressIdentity?.revokeProject(project.id).catch(() => undefined);
      await this.opts.store.updateProjectState(project.id, 'failed', message);
      throw new ProvisioningError(message, cause);
    }
    await this.opts.store.deleteProjectSessionBackendStates(project.id);
    await this.opts.store.recordProjectImageRef(
      project.id,
      image.imageRef,
      recordedToolkitIdentity,
    );
    return (await this.opts.store.updateProjectState(
      project.id,
      'active',
      null,
      provisionWarning,
    )) as ProjectRecord;
  }

  /** Decide the image the project container runs on (ADR 0003 R3.1). The default
   *  is the base image (`resolveImage`); a project only diverges when its clone
   *  carries a `.devcontainer/` directory AND the build path is wired
   *  (`devcontainerBuild` + `dockerHostForBuild`).
   *
   *  When it does:
   *   1. content-hash `(the .devcontainer/ dir + the resolved base image ref)`
   *      → a derived tag `verity-devc-<owner>-<repo>:<hash12>`;
   *   2. if that tag already exists on the daemon → return it (cache hit, no
   *      build) — same devcontainer + same base ⇒ same hash ⇒ hit;
   *   3. else build it via the official `@devcontainers/cli` (onto the same
   *      daemon) and return the tag.
   *
   *  A base-image change ⇒ different hash ⇒ automatic rebuild on the new base.
   *  A build failure throws; the caller marks the project `failed`. If the build
   *  seam is absent (feature not wired) but a `.devcontainer/` exists, we fall
   *  back to the base image rather than failing. If the build seam is wired but
   *  the bundled toolkit Feature is absent, a repo with `.devcontainer/` fails
   *  closed before build so Verity never starts a project-specific image without
   *  the shared agent tooling. Runtime-only devcontainer settings also fail
   *  closed: this path builds an image, then starts it through Verity's Docker
   *  create contract, so it must not silently ignore user/runtime semantics.
   *
   *  `forceRebuild` is the operator's "Rebuild image" action. The cache above is
   *  content-addressed over the `.devcontainer/` directory alone, which is the
   *  right default and also its blind spot: a devcontainer that references a
   *  Dockerfile or build context OUTSIDE that directory keeps its hash — and
   *  therefore its cached tag — while the thing it builds from changes. There is
   *  no automatic signal for that, so the escape hatch skips step 2 entirely and
   *  builds with `--no-cache`, overwriting the derived tag in place (the hash is
   *  unchanged, so the tag is the same one every later provision resolves to). */
  private async resolveOrBuildImage(
    project: ProjectRecord,
    dirs: ProvisioningDirectory,
    forceRebuild = false,
  ): Promise<ProjectImage> {
    // Resolve the CURRENT default digest (bypassing the resolver's staleness
    // cache) so a freshly created — or recreated — container is pinned to the
    // newest published image, not a digest the poll cache happened to hold. This
    // is the one-shot provision/recreate path, so the extra registry lookup is
    // cheap and keeps the container ref in sync with what the update checker
    // resolves, avoiding a phantom "update available" on a brand-new project.
    // `image_override_ref` is configuration; `image_ref` records what the last
    // provisioning attempt actually selected. Only resolve the live default when
    // no explicit override is configured.
    const configuredOverride = await this.opts.db
      .selectFrom('projects')
      .select('image_override_ref')
      .where('id', '=', project.id)
      .executeTakeFirst();
    const overrideRef = configuredOverride?.image_override_ref ?? null;
    const usesDefaultImage = overrideRef === null;
    const baseImageRef = overrideRef ?? (await this.defaultImageRef(true));
    const devcontainerDir = join(dirs.clonePath, '.devcontainer');
    const build = this.opts.devcontainerBuild;
    const dockerHost = this.opts.dockerHostForBuild;
    if (build === undefined || dockerHost === undefined || !this.isDir(devcontainerDir)) {
      return {
        imageRef: baseImageRef,
        usesDevcontainerImage: false,
        usesConfiguredOverride: !usesDefaultImage,
      };
    }
    const feature = await this.devcontainerFeature();
    if (feature === undefined) {
      throw new Error(
        'verity-sandbox-toolkit devcontainer Feature ref is required for project devcontainer builds',
      );
    }
    const unsupportedKeys = unsupportedDevcontainerRuntimeKeys(devcontainerDir);
    if (unsupportedKeys.length > 0) {
      throw new Error(
        `unsupported devcontainer runtime settings: ${unsupportedKeys.join(', ')}. ` +
          'Verity currently builds devcontainer images but starts them through its own Docker create path.',
      );
    }
    const hash = devcontainerContentHash(
      devcontainerDir,
      baseImageRef,
      `${DEVCONTAINER_NODE_FEATURE_REF}:${JSON.stringify(DEVCONTAINER_NODE_FEATURE_OPTIONS)}\n${feature.identity}:${JSON.stringify(DEVCONTAINER_TOOLKIT_FEATURE_OPTIONS)}`,
    );
    const derivedTag = devcontainerImageTag(project.owner, project.repo, hash);
    // Cache check: the derived tag on the daemon means an identical
    // (devcontainer + base) was already built — reuse it, skip the build.
    // A forced rebuild is precisely the request to not trust that conclusion.
    if (!forceRebuild && this.opts.docker.imageExists !== undefined) {
      const exists = await this.opts.docker.imageExists(derivedTag);
      if (exists)
        return {
          imageRef: derivedTag,
          usesDevcontainerImage: true,
          usesConfiguredOverride: !usesDefaultImage,
        };
    }
    // Mint a ghcr token (GitHub App installation, packages:read) so the build can
    // resolve the PRIVATE verity-sandbox-toolkit Feature + pull the base image as
    // the App. Best-effort: a mint failure/undefined degrades to no-auth (public).
    let registryToken: string | undefined;
    if (this.opts.registryTokenMint !== undefined) {
      try {
        registryToken = await this.opts.registryTokenMint();
      } catch {
        registryToken = undefined;
      }
    }
    // Build the derived image onto the target daemon. A non-zero exit rejects
    // with the build stderr, which the caller truncates into provision_error.
    await build({
      workspaceFolder: dirs.clonePath,
      imageName: derivedTag,
      dockerHost,
      additionalFeatures: feature.ref,
      ...(registryToken !== undefined ? { registryToken } : {}),
      ...(forceRebuild ? { noCache: true } : {}),
    });
    return {
      imageRef: derivedTag,
      usesDevcontainerImage: true,
      usesConfiguredOverride: !usesDefaultImage,
    };
  }

  /** Create the container, pulling the image on demand when it's missing (ADR
   *  0003 R6 / #299). Happy path (image already present) is a single create —
   *  no proactive pull. On `image_not_found`, pull the pinned image, then retry
   *  create ONCE; if the pull fails or the retry still can't find the image, the
   *  original/typed DockerError propagates so `runContainerPhase`'s catch marks
   *  the project `failed` with a clear `docker …` message. `conflict` (name
   *  taken) is NOT handled here — it flows up to the caller's existing
   *  inspect-and-reuse path.
   *
   *  `forcePull` (ADR 0004 — "Update & restart" must actively fetch): when set
   *  AND `pullImage` is available, proactively pull the target image BEFORE the
   *  first create, so a moved tag / updated image already present locally is
   *  re-fetched (the ADR-0003 stale-image class). The recreate path passes
   *  `true`; the normal provision path leaves it `false` and keeps its lazy
   *  behavior (pull only on `image_not_found`). If `forcePull` is set but
   *  `pullImage` is unavailable (an optional DockerClient capability), recreate
   *  degrades to the lazy create-first path — best-effort, no hard failure. A
   *  force-pull failure propagates as a DockerError → surfaced as a provision
   *  failure. After a force-pull the
   *  on-demand fallback would be redundant (we just pulled), so we don't retry
   *  a second pull; a create that STILL reports `image_not_found` after a
   *  successful force-pull surfaces the DockerError as-is. */
  private async createContainerPullingIfMissing(
    spec: ContainerSpec,
    forcePull = false,
  ): Promise<CreateContainerResult> {
    if (forcePull && this.opts.docker.pullImage !== undefined) {
      // Proactive fetch of the target image (blocks until the stream ends). A
      // failure here is a DockerError → provision failure. Having force-pulled,
      // we go straight to create; a still-missing image surfaces below without
      // a redundant second pull.
      await this.opts.docker.pullImage(spec.image);
      return await this.opts.docker.createContainer(spec);
    }
    try {
      return await this.opts.docker.createContainer(spec);
    } catch (cause) {
      if (!(cause instanceof DockerError) || cause.kind !== 'image_not_found') throw cause;
      if (this.opts.docker.pullImage === undefined) throw cause;
      // Pull the missing image (blocks until the stream ends), then retry create
      // exactly once. A pull failure or a still-missing image after pull
      // propagates as a DockerError → surfaced as a provision failure.
      await this.opts.docker.pullImage(spec.image);
      return await this.opts.docker.createContainer(spec);
    }
  }

  private devcontainerWarningForProject(project: ProjectRecord): string | null {
    const dirs = projectDirs(this.opts.hostCloneRoot, project);
    const devcontainerDir = join(dirs.clonePath, '.devcontainer');
    if (!this.isDir(devcontainerDir)) return null;
    return devcontainerProvisionWarning(devcontainerRuntimeSettings(devcontainerDir));
  }

  /** Synchronous `.git` directory probe — used by the clone-phase to decide
   *  whether an existing path is a repo to fetch+reset on (re-provision after
   *  `deprovision-keep` §19.8) or a stray non-repo to clone into. The async git
   *  runner can't be awaited inside the sync decision (the clone-phase body is
   *  async), so this stat is the cheaper probe. NO fs-permission elevation —
   *  the clone path is the operator-side bind-mount root. */
  /** The token for a SERVER-SIDE clone/fetch: a fresh App-minted, repo-scoped token
   *  when the mint is configured, else the fleet fallback (`this.opts.token`). The
   *  token is used only for this server-side git operation and is NEVER written
   *  into the sandbox — the sandbox authenticates to GitHub via the token broker. */
  private async resolveProjectToken(project: ProjectRecord): Promise<string | undefined> {
    if (this.opts.projectTokenMint !== undefined) {
      const token = await this.opts.projectTokenMint(project);
      if (token !== undefined) return token;
    }
    return typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
  }

  private resolveRelayClaudeGateway(project: ProjectRecord): {
    selected: { url: string; serverName?: string } | undefined;
    url: URL;
  } {
    const selected = this.opts.claudeEgressGatewayForProject?.(project);
    try {
      const url = new URL(selected?.url ?? this.opts.claudeEgressGatewayUrl);
      if (url.protocol !== 'https:' || url.hostname === '') {
        throw new Error('gateway must use HTTPS with a hostname');
      }
      return { selected, url };
    } catch (cause) {
      throw new ProvisioningError('project relay Claude gateway URL is invalid', cause);
    }
  }

  private isRepoDir(path: string): boolean {
    try {
      return statSync(`${path}/.git`).isDirectory();
    } catch {
      return false;
    }
  }
}

/** Wraps a provisioning failure with the surfaced message plus the original
 *  cause (never exposed to the client — the body is logged server-side). */
export class ProvisioningError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

function resolvedCodexGatewayUrl(claudeUrl: string, configured?: string): URL {
  if (configured !== undefined) return new URL(configured);
  const url = new URL(claudeUrl);
  url.port = '9444';
  return url;
}

/** A push command failed after it may already have updated the remote. Callers
 * must retain durable target ownership so the same project can probe/retry. */
export class AmbiguousGitPushError extends ProvisioningError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AmbiguousGitPushError';
  }
}

/** Deprovision a project (§19.8): stop + remove the container, transition the
 *  store row back to `state='absent'`. Optionally `purge=true` ALSO removes the
 *  bind-mount clone path (irreversibly — the operator explicitly chose this;
 *  the design says keep is the default, force-clean is explicit). */
export interface Deprovisioner {
  deprovision(projectId: string, opts: { purge: boolean }): Promise<ProjectRecord>;
}

/** Run `task` under a deadline. A task that never settles keeps running — there
 *  is nothing to cancel it with — but it stops being awaited, which is what the
 *  caller needs: a teardown that hangs must not hold the deletion open forever.
 *
 *  `task` is invoked INSIDE the promise chain so a synchronous throw surfaces as
 *  a rejection rather than escaping past the deadline. */
async function withTimeout(task: () => unknown, ms: number, label: string): Promise<void> {
  const running = (async () => {
    await task();
  })();
  // The race is over once the deadline wins, so a rejection arriving after it
  // has no handler left. Claim it here to keep it off `unhandledRejection`.
  running.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class DeprovisionerImpl implements Deprovisioner {
  constructor(
    private readonly store: EventStore,
    private readonly db: Kysely<Database>,
    private readonly docker: DockerClient,
    private readonly cloneRoot: string,
    /** Probe used only by the purge steps. "Nothing there" is the normal answer
     *  for an already-cleaned project, but any OTHER stat failure — EACCES on a
     *  parent directory, an I/O error — means a directory may well exist and be
     *  left behind, so it propagates to the purge step's reporter instead of
     *  passing for "already gone". */
    private readonly isDir: (p: string) => boolean = (p) => {
      try {
        return statSync(p).isDirectory();
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw cause;
      }
    },
    private readonly removeDir: (p: string) => void = (p) =>
      rmSync(p, { recursive: true, force: true }),
    /** GitHub-token broker registry (security review). When present, deprovision
     *  revokes the project's capability so a leaked capability stops redeeming at
     *  the broker immediately on teardown, not only on server restart. */
    private readonly ghTokenCapabilities?: GhTokenCapabilityRegistry | undefined,
    /** Persistent per-project Runner roots. Purge removes the matching project
     * directory; keep-mode deliberately retains it for later reattach/reprovision. */
    private readonly runnerRuntimeRoot?: string | undefined,
    /** Claude-egress identity service. When present, deprovision drops the
     *  project's client certificate so a copy that leaked out of the torn-down
     *  sandbox can no longer authenticate to the egress gateway. */
    private readonly claudeEgressIdentity?: ClaudeEgressIdentityService | undefined,
    /** Stop the generation-bound relay before completing deprovision. */
    private readonly projectRelay?: Pick<ProjectRelayControl, 'stop'> | undefined,
    /** Fence externally reachable generation-bound resources through teardown. */
    private readonly withTeardown?:
      | ((project: ProjectRecord, mutation: () => Promise<ProjectRecord>) => Promise<ProjectRecord>)
      | undefined,
    /** Report a resource-cleanup step that failed. Those steps are best-effort
     *  (see {@link deprovisionProject}), so this is the only place their failure
     *  becomes visible — wire it to the server log. Credential revocation is not
     *  reported here: it stays fail-closed and surfaces as a rejected request. */
    private readonly onTeardownFailure?:
      ((project: ProjectRecord, step: string, cause: unknown) => void) | undefined,
    /** Commit-signing capability registry. Revoked fail-closed on teardown so a
     *  leaked capability cannot keep signing once the project is gone — the
     *  relay's own revocation rides on a best-effort `stop`, so this repeats it. */
    private readonly signingCapabilities?: SigningCapabilityRegistry | undefined,
    /** Per-step budget for teardown. A step that never settles would block the
     *  deletion exactly as durably as one that throws — the relay's `stop` queues
     *  behind an in-flight start, and a filesystem call can block on stuck I/O —
     *  so every step is bounded and the deprovision moves on. Generous by
     *  design: the Docker client already caps its own calls at 30s. */
    private readonly teardownStepTimeoutMs: number = 60_000,
  ) {}

  async deprovision(projectId: string, opts: { purge: boolean }): Promise<ProjectRecord> {
    // Read the row up front (unlocked) to know what to tear down.
    const project = await this.store.getProject(projectId);
    if (project === undefined) {
      throw new ProvisioningError('project gone mid-deprovision');
    }
    const teardown = () => this.deprovisionProject(projectId, project, opts);
    return this.withTeardown ? this.withTeardown(project, teardown) : teardown();
  }

  private async deprovisionProject(
    projectId: string,
    project: ProjectRecord,
    opts: { purge: boolean },
  ): Promise<ProjectRecord> {
    // Best-effort teardown runs OUTSIDE the `SELECT … FOR UPDATE` lock — the
    // same rule the provision path follows (git clone + docker create/start are
    // unlocked, §19.3). Docker stop/remove can BLOCK for a long time on a stuck
    // container or a busy daemon; holding those awaits inside the lock would pin
    // the projects-row lock `idle in transaction`, pile up every other project
    // write behind it, and exhaust the server's DB pool — hanging even simple
    // reads (e.g. /onboarding/status, the app's launch gate).
    //
    // Teardown splits into two classes, and the split is a security boundary.
    //
    // (1) RESOURCE CLEANUP is best-effort. Stopping a container, closing the
    // relay's listeners, and removing the clone/runtime directories reclaim
    // host resources; none of them is what authorizes a sandbox. These are also
    // the steps that fail for reasons no retry can fix — a wedged Docker daemon,
    // a clone directory whose files the sandbox user owns (EACCES). Letting one
    // of those throw used to abort the whole request: `DELETE /projects/:id`
    // hides the row only AFTER this resolves, so the project was never deleted,
    // and every retry re-ran the same failing step — permanently undeletable.
    // Failures are reported through `onTeardownFailure` so the leftover
    // container or directory is visible in the log and can be cleaned up by
    // hand. A 404 (container already gone) is not a failure at all.
    //
    // (2) CREDENTIAL REVOCATION below stays fail-closed and DOES abort the
    // deprovision. Those are the authorities a copy that leaked out of the
    // sandbox can still redeem, so hiding a project whose capabilities are
    // unrevoked would turn a delete into silent, lasting access. Each is a
    // DELETE against the very database the state transition and `hideProject`
    // must write to next, so a failure that persists across retries is a
    // database outage — under which the deletion could not have completed
    // anyway. Blocking here therefore costs no deletability that was not
    // already lost, and it is deliberately NOT relaxed to keep a project
    // removable.
    const bounded = (step: string, run: () => unknown): Promise<void> =>
      withTimeout(run, this.teardownStepTimeoutMs, `teardown step '${step}'`);
    const bestEffort = async (
      step: string,
      run: () => unknown,
      ignore: (cause: unknown) => boolean = () => false,
    ): Promise<void> => {
      try {
        await bounded(step, run);
      } catch (cause) {
        if (ignore(cause)) return;
        // The reporter is the last thing standing between a swallowed failure
        // and the log; a throwing logger must not resurrect the abort this
        // whole branch exists to prevent.
        try {
          this.onTeardownFailure?.(project, step, cause);
        } catch {
          // Nowhere left to report to.
        }
      }
    };
    const containerGone = (cause: unknown): boolean =>
      cause instanceof DockerError && cause.kind === 'container_not_found';

    await bestEffort(
      'container-stop',
      () => this.docker.stopContainer(project.containerName),
      containerGone,
    );
    await bestEffort(
      'container-remove',
      () => this.docker.removeContainer(project.containerName),
      containerGone,
    );
    // `stop` revokes the relay's signing + GitHub capabilities AND closes its
    // listeners/runtime, reporting either kind of failure as one AggregateError,
    // so its throw does not say which half failed. Swallow it for the listeners'
    // sake and re-run both capability revocations below, fail-closed — a relay
    // socket that outlives a revoked capability serves nothing.
    //
    // The bound frees THIS request, not the relay: `ProjectRelayLifecycle`
    // serializes per project id, and a `stop` that never settles leaves that
    // project's tail unresolved. So a later restore of the same id (the row and
    // its id survive the soft delete) queues its relay start behind the wedged
    // tail, and `close()` — which drains every tail — waits on it too. Both
    // follow from the wedge itself and predate this branch: any relay operation
    // that hangs does the same, whoever started it. What changes here is that
    // the deletion no longer joins the queue, and the timeout is reported
    // through `onTeardownFailure`, so the wedged relay is in the log instead of
    // showing up later as an unexplained hang.
    await bestEffort('relay-stop', () => this.projectRelay?.stop(project.id));
    // The purge seams are synchronous by type (`statSync`/`rmSync` by default),
    // and no timer in the process — including this step's own bound — fires
    // while a synchronous call blocks the event loop. The bound therefore
    // covers only what an injected async seam awaits; a filesystem call that
    // truly wedges would have to be moved off the main thread to be
    // interruptible at all, which is a separate change and not one this branch
    // regresses (the same `rmSync` ran here before). What this branch does fix
    // is the failure mode that actually occurs: a purge that THROWS — EACCES on
    // files owned by the sandbox user is the common one — is reported and no
    // longer aborts the deletion.
    if (opts.purge) {
      const clonePath = projectClonePath(this.cloneRoot, project);
      await bestEffort('clone-purge', () => {
        if (this.isDir(clonePath)) this.removeDir(clonePath);
      });
      if (this.runnerRuntimeRoot !== undefined) {
        const runtimePath = join(this.runnerRuntimeRoot, project.id);
        await bestEffort('runner-runtime-purge', () => {
          if (this.isDir(runtimePath)) this.removeDir(runtimePath);
        });
      }
    }

    // Every authority the sandbox held, revoked together. Each call is STARTED
    // before any one of them is awaited (the rule `ProjectRelayLifecycle.teardown`
    // follows): these registries are independent, so a wedged one must not stop
    // the others from being revoked — sequential awaits would leave a leaked
    // GitHub capability redeeming just because the signing registry was slow.
    // Failures are aggregated and rethrown so the caller still fails closed.
    //
    //  - signing: a leaked copy stops signing through the broker. Redundant with
    //    a successful `relay.stop`, which is exactly the point — that call is
    //    best-effort above, so this is the one that has to hold.
    //  - github: a capability that leaked out of the (now torn-down) sandbox can
    //    no longer redeem installation tokens.
    //  - claude-egress: a leaked client key can no longer authenticate to the
    //    egress gateway.
    // Each call goes through a thunk: a registry that throws SYNCHRONOUSLY —
    // before it ever returns the promise its signature advertises — would
    // otherwise escape while the array is still being built, and take the
    // revocations after it with it. The same bound as the cleanup steps applies,
    // but it resolves the opposite way: a revocation that never settles becomes
    // a failure, so the deletion is refused rather than hanging the request.
    const revoke = (name: string, run: () => Promise<void> | undefined): Promise<void> =>
      withTimeout(run, this.teardownStepTimeoutMs, `${name} revocation`);
    const revocations = await Promise.allSettled([
      revoke('signing capability', () => this.signingCapabilities?.revokeProject(project.id)),
      revoke('github capability', () => this.ghTokenCapabilities?.revokeProject(project.id)),
      revoke('claude-egress identity', () => this.claudeEgressIdentity?.revokeProject(project.id)),
    ]);
    const revocationFailures = revocations.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (revocationFailures.length > 0) {
      throw new AggregateError(
        revocationFailures,
        `project credential revocation failed: ${project.id}`,
      );
    }

    // Only the state-machine transition runs under the row lock — a short
    // critical section with no external I/O, so it cannot hang the pool.
    return withProjectLock(this.db, projectId, async (tx) => {
      const current = await getProjectInTx(tx, projectId);
      if (current === undefined) {
        throw new ProvisioningError('project gone mid-deprovision');
      }
      const updated = await updateProjectStateInTx(tx, projectId, 'absent');
      return updated as ProjectRecord;
    });
  }
}
