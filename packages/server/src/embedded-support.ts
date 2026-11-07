import { sandboxNotReadyError } from '@verity/events';
import { isRunnerSupervisorBackend, type Backend } from '@verity/session';
import {
  EventStore,
  ProjectIdentityClaimConflict,
  type VeritySettingsPatch,
  type ProjectRecord,
} from '@verity/store';
import { existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { CONTROL_PLANE_PROJECT_ID } from './control-plane-project.js';
import {
  createGitWorktreeProvisioner,
  type WorktreeProvisioner,
  type GitWorktreeOptions,
} from './worktree.js';
import { type GitHubInstallationService } from './github.js';
import { type GitHubProjectTokenMint } from './github-app-token.js';
import {
  gitAuthHeader,
  defaultDevcontainerBuildSpawner,
  type DevcontainerFeatureSource,
} from './provisioner.js';
import { containerNameFor } from './canonical.js';
import { dockerHostFor } from './project-backend.js';
import { type ProjectEnvironmentSettings } from './project-settings-env.js';
import { createClaudeOAuthTokenProvider, type ClaudeOAuthTokenProvider } from './claudeUsage.js';
import { type CodexCredentialUpdate } from './agent-gateway-control.js';
import { DEFAULT_TOOLKIT_FEATURE_FALLBACK } from './sandbox-artifacts.js';

export async function resolveInstallationListToken(
  dbTokenMint: () => Promise<string | undefined>,
): Promise<string | undefined> {
  return dbTokenMint();
}

export async function resolveRepoWorktreeFetchAuthHeader(
  repoIdentity: () => Promise<RepoIdentity | null>,
  dbTokenMint: GitHubProjectTokenMint,
): Promise<string | undefined> {
  const identity = await repoIdentity();
  const token = identity ? await dbTokenMint(identity) : undefined;
  return token ? gitAuthHeader(token) : undefined;
}

export type RepoIdentity = { owner: string; repo: string };

export interface ProjectSettingsReader {
  getProjectSettings(projectId: string): Promise<ProjectEnvironmentSettings | undefined>;
}

export function isProjectSettingsReader(value: unknown): value is ProjectSettingsReader {
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

export interface ClaudeCredentialStore {
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
  getAccessToken: ClaudeOAuthTokenProvider;
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
  const getAccessToken: ClaudeOAuthTokenProvider = (): Promise<string | undefined> =>
    exclusive(async () => {
      if (closed) return undefined;
      // Only this queue is allowed to consume the rotating refresh token. Claude
      // children receive the resulting access token through their environment and
      // therefore never race each other at the provider refresh endpoint.
      return tokenProvider();
    });
  if (tokenProvider.statusForCredentials !== undefined) {
    getAccessToken.statusForCredentials = tokenProvider.statusForCredentials;
  }
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
  const safeInheritedKeys = new Set([
    'CI',
    'COLORTERM',
    'FORCE_COLOR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'NO_COLOR',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TZ',
  ]);
  const safeInheritedEnv = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    Object.fromEntries(
      Object.entries(source).filter(
        ([key]) =>
          safeInheritedKeys.has(key) ||
          key === 'GIT_CONFIG_COUNT' ||
          /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key),
      ),
    );
  const mergeEnv = async (env: NodeJS.ProcessEnv | undefined): Promise<NodeJS.ProcessEnv> => {
    const inherited = {
      ...safeInheritedEnv(process.env),
      ...safeInheritedEnv(env ?? {}),
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

/** Repair the dedicated Runner's identity before using its socket as the
 * availability signal. On a fresh managed install, unlock and the Updater's
 * volume preparation can race; the first identity publish may therefore fail
 * before the directory has its final group/mode. The turn is the next safe
 * retry point, but only if publishing happens before the socket check. */
export async function prepareControlPlaneRunnerForTurn(options: {
  enabled: boolean;
  dataVolumeRoot?: string | undefined;
  refreshIdentity?: (() => Promise<void>) | undefined;
  awaitIdentity?: (() => Promise<void>) | undefined;
  socketExists?: ((path: string) => boolean) | undefined;
}): Promise<boolean> {
  if (!options.enabled || options.dataVolumeRoot === undefined) return false;
  await options.refreshIdentity?.();
  await options.awaitIdentity?.();
  return (options.socketExists ?? existsSync)(
    join(options.dataVolumeRoot, 'runners', CONTROL_PLANE_RUNNER_PROJECT_ID, 'supervisor.sock'),
  );
}

export function isUntaggedImageRepository(repository: string): boolean {
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
export const SWEEP_SHUTDOWN_WAIT_MS = 5_000;

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
  const bytes = Math.floor(Number(m[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`invalid byte size "${value}": value is outside the supported range`);
  }
  return bytes;
}

/** Parse a swap allowance (`VERITY_SANDBOX_SWAP`) into bytes. Same syntax as
 *  {@link parseByteSize}, plus `0` for "no swap" — the one value a memory ceiling
 *  must never take, and the default here. Unset/empty → `undefined` (default). */
export function parseSwapSize(value: string | undefined): number | undefined {
  if (value !== undefined && /^0+(?:\.0+)?\s*[kmgt]?b?$/i.test(value.trim())) return 0;
  return parseByteSize(value);
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

export function devcontainerBuildOptionsForDockerBaseUrl(dockerBaseUrl: string): {
  devcontainerBuild: typeof defaultDevcontainerBuildSpawner;
  dockerHostForBuild: string;
} {
  return {
    devcontainerBuild: defaultDevcontainerBuildSpawner,
    dockerHostForBuild: dockerHostFor(dockerBaseUrl),
  };
}

// Reached when neither `VERITY_SANDBOX_TOOLKIT_FEATURE_REF` nor a caller-supplied
// ref names one — `main.ts` always resolves one, so this is the embedder default.
// It named 1.14.1, one train older than the 1.14.9 the other fallback named and
// just as gone: the reset deleted the toolkit Feature package outright, so every
// tag of it 404s. Shared with the rest rather than re-derived here, which is how
// this one came to lag the other by eight patch versions unnoticed.
const DEFAULT_SANDBOX_TOOLKIT_FEATURE_REF = DEFAULT_TOOLKIT_FEATURE_FALLBACK;

export function rejectLatestImageRef(ref: string, label: string): string {
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
  session: { projectId: string | null; worktree?: string },
  getProject: (projectId: string) => Promise<Pick<ProjectRecord, 'kind'> | undefined>,
): Promise<boolean> {
  if (session.worktree?.split('/').includes('.verity-document-sessions')) return false;
  if (session.projectId === null) return true;
  const project = await getProject(session.projectId);
  return project?.kind !== 'control_plane' && project?.kind !== 'local';
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
        // Transient by construction: something else is making this Sandbox ready
        // right now. The background resolution declines to queue behind it, which
        // must not end up as a `crashed` badge on a session that is fine.
        throw sandboxNotReadyError('project Sandbox preparation is already in progress');
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

  // Repeated overview polls must not acquire the global knowledge lifecycle
  // lock and rewrite every unchanged repository, starving unrelated reads.
  const existing = new Map(
    (await eventStore.listProjects({ includeHidden: true }))
      .filter(
        (project) =>
          (project.kind === undefined || project.kind === 'github') &&
          (project.forgeConnectionId ?? 'legacy-github') === 'legacy-github' &&
          // The sync maintains each repository's first project; further projects
          // of the same repository follow its archive state in the store.
          (project.repositoryInstance ?? 1) === 1,
      )
      .map((project) => [`${project.owner.toLowerCase()}/${project.repo.toLowerCase()}`, project]),
  );

  // The container_name is the canonical hyphen-slug form derived from the
  // (owner, repo) — `upsertProject` lowercases again on its side, this is just
  // pre-derivation so the input matches what will be persisted.
  const { randomUUID } = await import('node:crypto');
  for (const r of live) {
    const containerName = containerNameFor({
      owner: r.owner.toLowerCase(),
      repo: r.repo.toLowerCase(),
    });
    const owner = r.owner.toLowerCase();
    const repo = r.repo.toLowerCase();
    const current = existing.get(`${owner}/${repo}`);
    const legacyNames = [`dev-${owner}--${repo}`, `dev-${owner}-${repo}`];
    if (
      current &&
      current.archived === (r.archived ?? false) &&
      !legacyNames.includes(current.containerName)
    ) {
      continue;
    }
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
 * per-project token FILE to rewrite — the sandbox obtains a repo-scoped token on
 * demand via its capability. This warms the supplied mint's cache (when present)
 * and surfaces failures to the caller; it never writes into the clone dir, so no
 * token lands in the sandbox's /work.
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

export function createProjectWorktreeFactory(
  mint: GitHubProjectTokenMint,
  forgeConnection?: (
    project: ProjectRecord,
  ) => ReturnType<NonNullable<GitWorktreeOptions['fetchConnection']>>,
): (
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
      ...(project.kind === 'forgejo'
        ? {
            fetchConnection: async () => {
              if (!forgeConnection) throw new Error('Forgejo connection unavailable');
              return forgeConnection(project);
            },
          }
        : {}),
      fetchAuthHeader: async () => {
        if (project.kind === 'forgejo') return undefined;
        // On-demand mint only — no project-clone `.gh-token` file exists anymore
        // (it would sit in the sandbox's /work; the sandbox uses the token broker).
        const token = await mint(project);
        return token ? gitAuthHeader(token) : undefined;
      },
    });
}
