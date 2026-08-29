import type { ChildProcess, SpawnOptions } from 'node:child_process';

export const AGENT_SPAWN_PROTOCOL_VERSION: number;
export const DEFAULT_RUNTIME_DIR: string;
export const DEFAULT_CONTROL_DIR: string;
export const DEFAULT_WORKTREE_ROOT: string;
export const SHARED_SESSION_ROOT: string;
export const TRUSTED_CLI_ARGV_POLICY_SUFFIX: string;
/** The privilege-reducing `setpriv` flags both launch specs are built from. */
export const PRIVILEGE_DROP_FLAGS: readonly string[];
/** {@link PRIVILEGE_DROP_FLAGS}, with `--clear-groups` substituted by
 *  `--groups=<gid>` when the ADR 0006 Amendment 1 Docker grant applies. Throws on a value
 *  that is not a positive integer, and on the Runner's own runtime gid, rather
 *  than degrading to `--clear-groups`. */
export function privilegeDropFlags(dockerGid?: string, runnerGid?: number): string[];
/** Resolve `VERITY_AGENT_DOCKER_GID` against the mounted socket instead of
 *  trusting it: a project image can declare the same variable, so the grant only
 *  survives if /var/run/docker.sock exists and is owned by the group claimed. */
export function resolveDockerGid(
  env: NodeJS.ProcessEnv,
  statSocketGid: (path: string) => number | undefined,
): string | undefined;

export interface AgentSpawnBrokerOptions {
  runtimeDir?: string;
  controlDir?: string;
  enforceRoot?: boolean;
  agentUid: number;
  agentGid: number;
  runnerUid?: number;
  runnerGid?: number;
  setprivPath?: string;
  claudeAcpPath?: string;
  codexPath?: string;
  codexAcpPath?: string;
  /** The root-owned `exec opencode acp "$@"` wrapper the Feature installs. Overridable
   *  for tests only — production resolves the one fixed path. */
  openCodeAcpPath?: string;
  scriptSandboxPath?: string;
  worktreeRoot?: string;
  /** The one additional tree a Runner may be given. Production passes only
   *  {@link SHARED_SESSION_ROOT}, gated on VERITY_AGENT_SHARED_SESSION_ROOT;
   *  tests pass a directory they own. Absent → `/work` alone. */
  sharedSessionRoot?: string;
  /** Overrides the /run/verity-runner/secrets default; tests need a directory they own. */
  secretDir?: string;
  /** Overrides the sibling broker-owned entry-script snapshot directory. */
  trustedCliEntryScriptDir?: string;
  /** ADR 0006 Amendment 1. The group owning the host Docker socket, granted to the agent
   *  child in place of `--clear-groups`. Set only by the control-plane Runner
   *  launcher, and only when a real socket is mounted; a project Sandbox leaves
   *  it unset and its argv is unchanged. */
  dockerGid?: string;
  env?: NodeJS.ProcessEnv;
  connectorUrl?: string;
  connectorConfigPath?: string;
  shutdownGraceMs?: number;
  maxFrameBytes?: number;
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function agentLaunchSpec(
  request: {
    command: 'claude-agent-acp' | 'codex-acp' | 'opencode-acp';
    args: string[];
    cwd: string;
  },
  options: AgentSpawnBrokerOptions,
): { command: string; args: string[]; spawnOptions: SpawnOptions };

export function trustedCliLaunchSpec(
  request: {
    kind: 'trusted-cli';
    command: string;
    args: string[];
    cwd: string;
    secrets: { name: string; value: string; injection?: 'env' | 'file' }[];
  },
  options: AgentSpawnBrokerOptions,
): { command: string; args: string[]; spawnOptions: SpawnOptions };

export function resolveAgentWorktreeRoots(
  options?: Pick<AgentSpawnBrokerOptions, 'worktreeRoot' | 'sharedSessionRoot'>,
): Promise<string[]>;

export function withinAgentWorktreeRoots(cwd: string, roots: readonly string[]): boolean;

export function validateTrustedCliArguments(
  command: string,
  args: readonly unknown[],
  cwd: string,
  executablePath?: string,
  mutableDataPaths?: readonly string[],
  approvedEntryScript?: {
    path: string;
    projectPath: string;
    sha256: string;
    loading: 'isolated' | 'dynamic';
    worktreeRoot?: string;
  },
  options?: {
    /** Test seam. Production always uses the immutable adjacent sidecar loader. */
    loadArgvPolicy?: (resolvedCommand: string) => Promise<unknown | undefined>;
  },
): Promise<void>;
export function matchesTrustedCliArgvPolicy(policy: unknown, args: readonly string[]): boolean;
export function loadTrustedCliArgvPolicy(
  resolvedCommand: string,
  options?: {
    lstat?: (path: string) => Promise<{ isFile(): boolean; size: number }>;
    validateImmutablePath?: (path: string) => Promise<void>;
    readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  },
): Promise<unknown | undefined>;
export function validateTrustedCliExecutable(command: string): Promise<void>;
export function materializeTrustedCliEntryScript(
  request: {
    args: string[];
    cwd: string;
    entryScript?: {
      path: string;
      projectPath: string;
      sha256: string;
      loading: 'isolated' | 'dynamic';
      worktreeRoot: string;
    };
  },
  options: Pick<AgentSpawnBrokerOptions, 'secretDir' | 'trustedCliEntryScriptDir'>,
): Promise<{
  args: string[];
  entrySandbox?: {
    root: string;
    cwd: string;
    loading: 'isolated' | 'dynamic';
  };
  cleanup: () => Promise<boolean>;
}>;

export const PROCESS_TREE_KILL_GRACE_MS: number;
/** Exported for the drift tripwire against `@verity/session`'s copy of the same walk. */
export function collectEscapedProcessTree(
  root: number,
  readProc?: (path: string) => string,
): Map<number, string>;
/** Clears the once-per-process "no children API on this kernel" latch. Tests only. */
export function resetProcessTreeWarnings(): void;
export function stopAgentProcessGroup(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>,
  signal: 'SIGTERM' | 'SIGKILL',
  options?: {
    kill?: (pid: number, signal: NodeJS.Signals) => unknown;
    readProc?: (path: string) => string;
  },
): void;
export function killExitedTrustedCliProcessGroup(
  child: Pick<ChildProcess, 'pid'>,
  kill?: (pid: number, signal: NodeJS.Signals) => unknown,
): void;

export function validateRunnerRuntimeStats(
  stats: { uid: number; gid: number; mode: number },
  options: Pick<AgentSpawnBrokerOptions, 'runnerUid' | 'runnerGid'>,
): void;

export function brokerSocketOwnership(
  options: Pick<AgentSpawnBrokerOptions, 'runnerUid' | 'runnerGid' | 'enforceRoot'>,
): { uid: number | undefined; gid: number | undefined; mode: number };

export function runAgentSpawnBroker(options: AgentSpawnBrokerOptions): Promise<{
  socketPath: string;
  close(): Promise<void>;
}>;

export function probeAgentSpawnBroker(controlDir?: string, timeoutMs?: number): Promise<boolean>;
