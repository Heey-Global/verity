export const SUPERVISOR_PROTOCOL_VERSION: number;
export const MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION: number;
export const DEFAULT_RUNTIME_DIR: string;
/** Kept 1:1 with `MAX_SUPERVISOR_REQUEST_BYTES` in @verity/session. */
export const MAX_START_REQUEST_BYTES: number;
export const SUPERVISED_WORKER_BACKENDS: readonly string[];
/** {@link SUPERVISED_WORKER_BACKENDS} narrowed to the adapters this image installed. */
export function installedWorkerBackends(exists?: (path: string) => boolean): readonly string[];
export function supervisorWorkerEnv(environment: NodeJS.ProcessEnv): Record<string, string>;
export function redactTrustedCliText(
  bytes: Uint8Array,
  secrets: string | readonly string[],
): string;
export function runTrustedCliViaBroker(
  request: {
    turnId: string;
    secrets: {
      secretAlias: string;
      env: string;
      injection?: 'env' | 'file';
      secret: string;
    }[];
    command: string[];
  },
  options?: {
    runtimeDir?: string;
    brokerSocket?: string;
    timeoutMs?: number;
    killGraceMs?: number;
    onSpawned?: () => void;
    authorize?: (request: { turnId: string }) => boolean | Promise<boolean>;
  },
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
}>;
export function supervisorRequestTimeoutMs(request: unknown): number;

/**
 * Write the terminal `result` frame for a worker that died before emitting one.
 * Returns `false` when the stream already holds frames — the worker owns the
 * sequence then, and appending under the supervisor's instance id would break the
 * `turnId` → `runnerInstanceId` binding (ADR 0006 D3).
 *
 * The frame carries no `result.sessionId`: that is the agent's conversation id, and
 * a worker that never emitted a frame never learned one.
 */
export function writeSyntheticTerminalFrame(
  turnDir: string,
  detail: {
    turnId: string;
    runnerInstanceId: string;
    workerExitCode?: number | null;
    workerSignal?: NodeJS.Signals | null;
    workerError?: string;
    aborted?: boolean;
  },
): Promise<boolean>;

export interface SupervisorTurnState {
  protocolVersion: number;
  turnId: string;
  startCommandId: string;
  runnerInstanceId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  workerPid?: number;
  workerExitCode?: number | null;
  workerSignal?: NodeJS.Signals | null;
  workerError?: string;
  adoptedAt?: number;
  workerLock?: true;
}

export interface AmbiguousSupervisorTurnState {
  turnId: string;
  status: 'ambiguous';
  reason: 'missing-state' | 'invalid-state';
}

export function validateRuntimeDirectory(
  runtimeDir: string,
  expected?: { uid?: number; gid?: number },
): Promise<void>;
export function validateRuntimeStats(
  stats: {
    uid: number;
    gid: number;
    mode: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
  expected?: { uid?: number; gid?: number },
): void;
export function acquireSingleton(
  runtimeDir: string,
  instanceId?: string,
): Promise<{ instanceId: string; release(): Promise<void> }>;
export function readTurnState(
  runtimeDir: string,
  turnId: string,
): Promise<SupervisorTurnState | undefined>;
export function claimTurn(
  runtimeDir: string,
  request: { turnId: string; startCommandId: string },
  runnerInstanceId: string,
): Promise<{
  outcome: 'created' | 'already-running' | 'terminal' | 'ambiguous' | 'conflict';
  reason?: string;
  state?: SupervisorTurnState;
}>;
export function listTurns(
  runtimeDir: string,
): Promise<Array<SupervisorTurnState | AmbiguousSupervisorTurnState>>;
export function createTurnStarter(
  runtimeDir: string,
  runnerInstanceId: string,
  options: {
    workerCommand?: string;
    workerArgs?: string[];
    workerBackends?: string[];
    workerEnv?: NodeJS.ProcessEnv;
    spawnWorker?: (
      command: string,
      args: readonly string[],
      options: import('node:child_process').SpawnOptions,
    ) => import('node:child_process').ChildProcess;
    shutdownGraceMs?: number;
    brokerSocket?: string;
    adoptedTurns?: Set<string>;
    maxConcurrentStarts?: number;
    maxQueuedStarts?: number;
  },
): {
  /**
   * Accepts (or refuses) the start synchronously and hands back the work still in
   * flight. Throws for a refusal — a closing supervisor, an invalid frame, a full
   * start queue — so a caller may only acknowledge acceptance after this returns.
   */
  start(request: Record<string, unknown>): {
    accepted: true;
    pending: Promise<Record<string, unknown>>;
  };
  cancel(turnId: string): Promise<Record<string, unknown>>;
  runTrustedCli(
    request: Record<string, unknown>,
    onSpawned?: () => void,
  ): Promise<Record<string, unknown>>;
  getNativeToolCall(turnId: string, callId: string): Promise<unknown>;
  notifyNativeToolResult(turnId: string, callId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};
export function handleSupervisorRequest(
  runtimeDir: string,
  runnerInstanceId: string,
  request: unknown,
  turnStarter?: {
    start(request: Record<string, unknown>): {
      accepted: true;
      pending: Promise<Record<string, unknown>>;
    };
    runTrustedCli?(
      request: Record<string, unknown>,
      onSpawned?: () => void,
    ): Promise<Record<string, unknown>>;
  },
  onTrustedCliStarted?: () => void,
  /** Invoked once the start has been accepted and queued, before the worker is up. */
  onStartAccepted?: () => void,
): Promise<Record<string, unknown>>;
export function createTurnAdopter(
  runtimeDir: string,
  options?: { adoptionPollMs?: number; adoptedTurns?: Set<string> },
): {
  adopt(): Promise<void>;
  close(): Promise<void>;
};
export function runSupervisor(options?: {
  runtimeDir?: string;
  uid?: number;
  gid?: number;
  workerCommand?: string;
  workerArgs?: string[];
  workerBackends?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  spawnWorker?: (
    command: string,
    args: readonly string[],
    options: import('node:child_process').SpawnOptions,
  ) => import('node:child_process').ChildProcess;
  shutdownGraceMs?: number;
  adoptionPollMs?: number;
  brokerSocket?: string;
  maxConcurrentStarts?: number;
  maxQueuedStarts?: number;
}): Promise<{
  runtimeDir: string;
  socketPath: string;
  instanceId: string;
  close(): Promise<void>;
}>;
export function validateStartTurnRequest(request: unknown): Record<string, unknown> & {
  attachments?: Array<{ kind: 'image'; mediaType: string; data: string }>;
};
export function probeSupervisor(runtimeDir?: string, timeoutMs?: number): Promise<boolean>;
