import { createConnection } from 'node:net';
import type { TrustedCliEntryScript } from '@verity/secret-contracts';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { PermissionRequest } from '@verity/adapter-claude';
import {
  isRunnerSupervisorBackend,
  type Backend,
  type BrokeredGrantChannel,
  type RunnerSupervisorBackend,
} from './backend.js';
import type { RunTurnOptions } from './backend-contract.js';
import type { EventBus } from './bus.js';
import { FileTailRunnerClient, type RunnerFrameStore } from './file-tail-runner-client.js';
import type {
  RunnerAttachTarget,
  RunnerClient,
  RunnerTurn,
  StartTurnHooks,
} from './runner-contract.js';
import type { RunnerRecovery, RunnerRecoveryOutcome } from './runner-contract.js';
import type { RunnerTranscriptSink } from './runner-transcript-sink.js';

const PROTOCOL_VERSION = 1;
/**
 * The oldest Runner protocol this Server still reads — ADR 0006 D9.
 *
 * D9 requires each Server release to support the immediately previous Runner
 * protocol, because a Server update routinely meets a Runner started from the
 * release before it. Strict equality would make the first genuine version bump a
 * fleet-wide outage: every already-running Sandbox would stop being readable the
 * moment the Server rolled, which is exactly the class of failure D9 forbids.
 *
 * Equal to {@link PROTOCOL_VERSION} today, so this changes no behaviour. That is
 * the point of adding it before it is needed — raising the version then means
 * deciding how far back to keep reading, rather than discovering that the range
 * D9 prescribes was never implemented.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/** Whether a frame this Server did not write is one it still understands. */
function supportedProtocolVersion(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SUPPORTED_PROTOCOL_VERSION &&
    value <= PROTOCOL_VERSION
  );
}
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SETTLED_RESULT_FRAME_BYTES = 1024 * 1024;
const MAX_WORKER_ERROR_BYTES = 16 * 1024;
/**
 * The largest request frame the Sandbox supervisor will read — kept 1:1 with
 * `MAX_START_REQUEST_BYTES` in `features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs`.
 *
 * It is a PROTOCOL constant, not this Server's own budget: the supervisor ships
 * inside the Sandbox image and rolls independently of the Server (ADR 0006 D9),
 * so a Server that decided to allow more would simply meet the old bound at the
 * far end. Raising the ceiling therefore starts in the image, not here.
 *
 * Checking it before the write is what makes an over-cap turn legible. The
 * supervisor refuses mid-stream and closes; the refusal and the Server's own
 * write then race, and the operator sees whichever loses — historically a bare
 * `write EPIPE` with no mention of size or attachments.
 */
export const MAX_SUPERVISOR_REQUEST_BYTES = 4 * 1024 * 1024;

function describeBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * One structured observation about a turn start, handed to
 * {@link SupervisorRunnerClientOptions.onTelemetry}.
 *
 * The incident this exists for looked, from the Server, like "start-turn timed
 * out" and nothing else: no way to tell a wedged supervisor from a merely slow
 * one, and no way to see that the Server's own event loop was the thing that was
 * late. Each record therefore carries BOTH ends — how long the supervisor took and
 * how blocked this process was while it waited.
 */
export type SupervisorStartTelemetry = {
  turnId: string;
  /** Milliseconds from issuing `start-turn` to the supervisor accepting it. */
  acceptMs?: number;
  /** Milliseconds from issuing `start-turn` to a usable start outcome. */
  startMs: number;
  /** Milliseconds spent waiting for the control socket + event stream after that. */
  artifactMs?: number;
  /**
   * Turn starts this client still has in flight, NOT counting the one this record
   * describes — that one is finished by the time it is emitted, on either path. So
   * `0` means this was the last start standing, whether it succeeded or failed.
   */
  activeStarts: number;
  /** Mean/max libuv event-loop delay on THIS process since the previous record. */
  eventLoopDelayMs?: { mean: number; max: number };
  outcome: 'created' | 'already-running' | 'terminal' | 'failed';
  /** Set when the first response was lost and the state had to be reconciled. */
  reconciled?: true;
  /** Present on `outcome: 'failed'`. */
  error?: string;
};

export interface SupervisorRunnerClientOptions {
  runtimeDir: string;
  store: RunnerFrameStore;
  bus: EventBus;
  /**
   * Budget for the small control requests — `get-turn`, `cancel-turn`. It no longer
   * governs `start-turn`, which has its own accept/result budgets
   * ({@link SupervisorRunnerClientOptions.startTimeoutMs}).
   */
  timeoutMs?: number;
  /** Budget for the supervisor to acknowledge that it accepted `start-turn`. */
  startAcceptTimeoutMs?: number;
  /** Budget for the supervisor to finish starting a worker once it accepted the request. */
  startTimeoutMs?: number;
  /** Budget for reconciling a `start-turn` whose response was lost. */
  reconcileTimeoutMs?: number;
  /** Budget for the control socket and event stream to appear after a successful start. */
  artifactTimeoutMs?: number;
  /** Structured start observations; never called with anything operator-secret. */
  onTelemetry?: ((telemetry: SupervisorStartTelemetry) => void) | undefined;
  /**
   * Stage 5b Slice 2 (opt-in): server-side verbatim transcript persistence. When
   * present, this client materializes a resumed session's `.jsonl` back onto the
   * shared runner-runtime mount BEFORE the supervisor starts the worker, and tails
   * that `.jsonl` into the durable store for the life of the turn — so the Sandbox
   * worker needs no database. Omit it to keep the transport untouched. The sink's
   * runtime dir MUST be this client's `runtimeDir` (the Server-readable host path).
   */
  transcript?: RunnerTranscriptSink | undefined;
  /** Translate server-side turn paths into the Sandbox namespace before launch. */
  mapTurnOptions?: ((opts: RunTurnOptions) => RunTurnOptions) | undefined;
  /** Decide a permission prompt from a standing grant before it becomes a card or a
   * push (ADR 0011 D2); forwarded verbatim to the underlying transport. */
  autoApprovePermission?:
    | ((
        sessionId: string,
        request: PermissionRequest,
        channel: BrokeredGrantChannel,
      ) => Promise<boolean>)
    | undefined;
  /**
   * Mint and retire the per-turn bearer an ACP turn's MCP gateway calls present
   * (ADR 0014 D1). Only an ACP backend is offered one: the native backends relay
   * their brokered tools over the worker's own attested channel and never reach
   * the gateway. `release` retires the exact token it is given — never a turn's
   * token generally — so a start attempt can only ever retire its own bearer. It
   * is best-effort cleanup anyway: the registry expires tokens on its own, so a
   * turn that dies without settling leaks nothing durable.
   */
  mcpGatewayTokens?:
    | {
        issue: (turnId: string) => string;
        release: (token: string) => void;
      }
    | undefined;
}

export interface TrustedCliExecutionInput {
  turnId: string;
  secrets: readonly {
    secretAlias: string;
    env: string;
    injection?: 'env' | 'file';
    secret: string;
  }[];
  command: readonly string[];
  entryScript?: TrustedCliEntryScript;
}

export interface TrustedCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: true;
  truncated?: true;
}

const TRUSTED_CLI_START_ACK_TIMEOUT_MS = 10_000;
const TRUSTED_CLI_RESULT_TIMEOUT_MS = 30 * 60 * 1_000 + 20_000;

/**
 * The budget for a supervisor request that only reads or signals: `status`,
 * `get-turn`, `cancel-turn`. A cancel can await the worker's SIGTERM → SIGKILL
 * escalation, including its five-second grace, so even these requests cannot
 * safely share the old one-second default.
 *
 * Raising it from 1 s widens every caller that passes no `timeoutMs`, which today is
 * whichever of `cancel-turn`, `get-turn` and the recovery probe is reached through a
 * client constructed without one — the embedded Server passes 15 s, so this is the
 * CLI and test path. Widening is the safe direction for all three: each one's timeout
 * is read as "no answer", and on a host loaded enough to miss a one-second deadline
 * that reading is wrong. Recovery in particular then reports `uncertain` for a
 * supervisor that was merely busy, and a slower probe beats a wrong verdict.
 */
export const DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long the supervisor may take to ACKNOWLEDGE a `start-turn` (see
 * {@link requestRunnerSupervisorStart}).
 *
 * Acceptance is cheap — validate the frame, enqueue the start — so a peer that
 * cannot answer this within 15 s is genuinely wedged rather than merely busy.
 */
export const START_TURN_ACCEPT_TIMEOUT_MS = 15_000;

/**
 * How long the supervisor may take to finish starting the worker once it has
 * accepted the request.
 *
 * The old code gave this the same budget as a `get-turn` — one second — even
 * though the supervisor answers `start-turn` only AFTER it has claimed the turn
 * (mkdir + atomic state write + two directory fsyncs), written `request.json`,
 * re-written the state, spawned a `flock` child to take the worker lock, spawned
 * the worker itself, and awaited its `spawn` event. Two process spawns and four
 * fsync cycles do not fit in a second on a host under CPU or IO pressure, so the
 * Server abandoned turns the Sandbox had in fact started. Acceptance is now
 * separate, this covers only the work, and a lost response reconciles rather than
 * failing the turn.
 */
export const START_TURN_RESULT_TIMEOUT_MS = 120_000;

/**
 * How long {@link SupervisorRunnerClient} keeps asking `get-turn` who owns a turn
 * whose `start-turn` response never arrived, before it gives up. Only a state that
 * is still `claimed` consumes the whole budget: a worker mid-spawn is the one case
 * where neither "running" nor "never claimed" is yet true.
 */
export const START_TURN_RECONCILE_TIMEOUT_MS = 30_000;

/** How long to wait for the control socket + first artifacts after a start succeeds. */
export const START_TURN_ARTIFACT_TIMEOUT_MS = 60_000;

/**
 * How long `get-turn` must keep reporting nothing before "nothing ever claimed this
 * turn" is treated as the answer rather than as a gap.
 *
 * A count of consecutive misses alone is not a duration: against a supervisor that
 * answers instantly, three of them can land inside a couple of hundred milliseconds
 * — comfortably inside the window `claimTurn` leaves between creating the turn
 * directory and its atomic state write when the host is fsync-bound, which is
 * exactly the host this whole change exists for. The floor makes the conclusion a
 * statement about time as well as about tries, and the only thing it costs is that
 * much delay before a re-send that was going to happen anyway.
 */
export const START_TURN_MISSING_STATE_MIN_MS = 500;

class SupervisorTrustedCliRequestError extends Error {
  constructor(
    override readonly cause: Error,
    readonly startAcknowledged: boolean,
  ) {
    super(cause.message, { cause });
    this.name = 'SupervisorTrustedCliRequestError';
  }
}

async function requestSupervisorTrustedCli(
  socketPath: string,
  request: Record<string, unknown>,
  timeouts: { startAckTimeoutMs: number; resultTimeoutMs: number },
): Promise<Record<string, unknown>> {
  const frame = `${JSON.stringify({ protocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION, ...request })}\n`;
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let started = false;
    let timeout = setTimeout(
      () => finish(new Error('trusted CLI start acknowledgement timed out')),
      timeouts.startAckTimeoutMs,
    );
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) reject(new SupervisorTrustedCliRequestError(error, started));
      else resolve(response ?? {});
    };
    const armResultTimeout = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => finish(new Error('trusted CLI result response timed out')),
        timeouts.resultTimeoutMs,
      );
      timeout.unref?.();
    };
    timeout.unref?.();
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(frame));
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
        finish(new Error('runner supervisor response too large'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish(new Error('runner supervisor returned malformed JSON'));
          return;
        }
        if (!isObject(parsed) || parsed.ok !== true) {
          const reason =
            isObject(parsed) && typeof parsed.error === 'string' && parsed.error !== ''
              ? parsed.error
              : undefined;
          const rejection = new Error(
            reason === undefined
              ? 'runner supervisor rejected request'
              : `runner supervisor rejected request: ${reason}`,
          );
          if (isObject(parsed) && isObject(parsed.trustedCliFailure)) {
            Object.assign(rejection, { trustedCliFailure: parsed.trustedCliFailure });
          }
          finish(rejection);
          return;
        }
        if (parsed.kind === 'trusted-cli-started') {
          if (started) {
            finish(
              new Error('runner supervisor returned duplicate trusted CLI start acknowledgement'),
            );
            return;
          }
          started = true;
          armResultTimeout();
          continue;
        }
        // A fast command can finish before the start frame and an old supervisor
        // sends only this final response. Both are safe successful compatibility
        // cases; a long-running old supervisor instead reaches the bounded ack
        // timeout and is reported with an unknown execution state.
        finish(undefined, parsed);
        return;
      }
    });
    socket.once('end', () => {
      if (!settled) finish(new Error('runner supervisor closed before trusted CLI result'));
    });
  });
}

export type TrustedCliDispatchStage =
  'runner supervisor connection' | 'runner supervisor response' | 'spawn broker dispatch';
export type TrustedCliBrokerFailurePhase =
  'validation' | 'materialization' | 'launch-spec' | 'spawn';

/** A closed, secret-safe classification for failures before a trusted CLI result exists. */
export class TrustedCliDispatchError extends Error {
  constructor(
    readonly stage: TrustedCliDispatchStage,
    readonly executionStarted: false | 'unknown',
    readonly brokerFailure?: {
      phase: TrustedCliBrokerFailurePhase;
      cause: string;
    },
  ) {
    super(`trusted CLI dispatch failed during ${stage}`);
    this.name = 'TrustedCliDispatchError';
  }
}

export function trustedCliDispatchMessage(error: TrustedCliDispatchError): string {
  const outcome =
    error.executionStarted === false
      ? 'The command was not started.'
      : 'Whether the command started is unknown; do not retry a mutating command automatically.';
  const detail = error.brokerFailure
    ? ` Broker phase: ${error.brokerFailure.phase}; cause: ${error.brokerFailure.cause}.`
    : '';
  return `Trusted CLI dispatch failed during ${error.stage}.${detail} ${outcome} No secret value was exposed.`;
}

/** Execute a trusted CLI request through one project's supervisor socket.
 *
 * Unlike {@link SupervisorRunnerClient}, this entry point does not own or start the turn.
 * The supervisor remains the authority: it accepts the request only while `turnId` names
 * the live worker whose start request carried `trustedCliExecution: true`.
 */
export async function runSupervisorTrustedCli(
  runtimeDir: string,
  input: TrustedCliExecutionInput,
  timeouts: {
    startAckTimeoutMs?: number;
    resultTimeoutMs?: number;
  } = {},
): Promise<TrustedCliExecutionResult> {
  let response: Record<string, unknown>;
  try {
    response = await requestSupervisorTrustedCli(
      join(runtimeDir, 'supervisor.sock'),
      {
        kind: 'run-trusted-cli',
        turnId: input.turnId,
        secrets: input.secrets.map((secret) => ({
          secretAlias: secret.secretAlias,
          env: secret.env,
          ...(secret.injection === undefined ? {} : { injection: secret.injection }),
          secret: secret.secret,
        })),
        command: [...input.command],
        ...(input.entryScript === undefined ? {} : { entryScript: input.entryScript }),
      },
      {
        startAckTimeoutMs: timeouts.startAckTimeoutMs ?? TRUSTED_CLI_START_ACK_TIMEOUT_MS,
        resultTimeoutMs: timeouts.resultTimeoutMs ?? TRUSTED_CLI_RESULT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const transportError = error instanceof SupervisorTrustedCliRequestError ? error.cause : error;
    const startAcknowledged =
      error instanceof SupervisorTrustedCliRequestError && error.startAcknowledged;
    const message = transportError instanceof Error ? transportError.message : '';
    const code = (transportError as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      throw new TrustedCliDispatchError('runner supervisor connection', false);
    }
    if (!startAcknowledged && message.includes('trusted CLI broker rejected execution')) {
      const candidate = (transportError as Error & { trustedCliFailure?: unknown })
        .trustedCliFailure;
      const phases: TrustedCliBrokerFailurePhase[] = [
        'validation',
        'materialization',
        'launch-spec',
        'spawn',
      ];
      const brokerFailure =
        isObject(candidate) &&
        phases.includes(candidate.phase as TrustedCliBrokerFailurePhase) &&
        candidate.cause === `${String(candidate.phase)} failed`
          ? {
              phase: candidate.phase as TrustedCliBrokerFailurePhase,
              cause: candidate.cause,
            }
          : undefined;
      throw new TrustedCliDispatchError('spawn broker dispatch', false, brokerFailure);
    }
    // A timeout, reset, or lost frame after connecting cannot prove whether the
    // privileged broker already spawned the command. Never invite an unsafe retry.
    throw new TrustedCliDispatchError('runner supervisor response', 'unknown');
  }
  if (
    !Number.isInteger(response.exitCode) ||
    Number(response.exitCode) < 0 ||
    Number(response.exitCode) > 255 ||
    typeof response.stdout !== 'string' ||
    typeof response.stderr !== 'string' ||
    (Object.hasOwn(response, 'timedOut') && response.timedOut !== true) ||
    (Object.hasOwn(response, 'truncated') && response.truncated !== true)
  ) {
    throw new Error('runner supervisor returned an invalid trusted CLI result');
  }
  return {
    exitCode: Number(response.exitCode),
    stdout: response.stdout,
    stderr: response.stderr,
    ...(response.timedOut === true ? { timedOut: true } : {}),
    ...(response.truncated === true ? { truncated: true } : {}),
  };
}

/**
 * Why a turn never reached a live worker, in a shape the caller can act on rather
 * than a sentence it has to match with a regex.
 *
 *  - `worker-exited-early` — the worker ran and died before writing a terminal
 *    frame. `workerExitCode`/`workerSignal`/`workerError` carry its own diagnosis;
 *    this is the case the operator used to see as a bare `agent exited with code 1
 *    without a terminal event`.
 *  - `event-stream-missing` — the turn settled with no event stream at all.
 *  - `no-terminal-event` — the stream exists but has no terminal `result` frame and
 *    the supervisor reports no worker failure either.
 *  - `start-uncertain` — the `start-turn` response was lost AND reconciliation
 *    could not establish whether a worker exists. Never retry on this.
 *  - `start-conflict` — the turn id is owned by a different start command.
 */
export type RunnerWorkerFailureReason =
  | 'worker-exited-early'
  | 'event-stream-missing'
  | 'no-terminal-event'
  | 'start-uncertain'
  | 'start-conflict';

/**
 * A turn that failed BEFORE its worker produced a terminal event, reported as
 * structured data.
 *
 * The Conductor turns a rejected turn into the session's terminal error event, so
 * whatever this carries is what the operator reads. Keeping the worker's own exit
 * code, signal and captured stderr on the error is what makes an early crash
 * diagnosable instead of merely visible.
 */
export class RunnerWorkerStartFailure extends Error {
  readonly turnId: string;
  readonly reason: RunnerWorkerFailureReason;
  readonly workerExitCode?: number | null | undefined;
  readonly workerSignal?: string | null | undefined;
  readonly workerError?: string | undefined;

  constructor(
    message: string,
    detail: {
      turnId: string;
      reason: RunnerWorkerFailureReason;
      workerExitCode?: number | null | undefined;
      workerSignal?: string | null | undefined;
      workerError?: string | undefined;
      cause?: unknown;
    },
  ) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'RunnerWorkerStartFailure';
    this.turnId = detail.turnId;
    this.reason = detail.reason;
    if (detail.workerExitCode !== undefined) this.workerExitCode = detail.workerExitCode;
    if (detail.workerSignal !== undefined) this.workerSignal = detail.workerSignal;
    if (detail.workerError !== undefined) this.workerError = detail.workerError;
  }
}

/**
 * Sample this process's libuv event-loop delay.
 *
 * A Server whose loop is seconds behind cannot tell that apart from a supervisor
 * that is seconds slow — both present as "the request timed out". The histogram is
 * a libuv-level timer, so it costs nothing to leave running, and each read resets
 * it so a record describes the interval it belongs to rather than all of history.
 *
 * ONE per process, shared by every client (see {@link processEventLoopDelay}). The
 * quantity is process-global — there is a single loop — so a histogram per project
 * would be N timers measuring the same thing, on the very loop this exists to prove
 * is unblocked. The interval a record describes is therefore "since the last record
 * from this process", not "since this client's last record"; that is the reading
 * that matches the question, because a start starved by another project's work was
 * still starved.
 */
class EventLoopDelaySampler {
  private histogram: IntervalHistogram | undefined;

  /**
   * Start measuring, so the first record already has an interval behind it — the
   * first start of a process is the one most likely to be slow, and the one a report
   * of a hanging turn points at, so it is the worst one to have no figure for.
   *
   * Deliberately NOT done at module load: importing `@verity/session` must not arm a
   * 20 ms timer in every CLI that never asks for telemetry. A client that was given
   * `onTelemetry` calls this; one that was not leaves the loop alone.
   */
  arm(): void {
    this.sample();
  }

  sample(): { mean: number; max: number } | undefined {
    try {
      if (this.histogram === undefined) {
        this.histogram = monitorEventLoopDelay({ resolution: 20 });
        this.histogram.enable();
        return undefined;
      }
      const mean = this.histogram.mean / 1e6;
      const max = this.histogram.max / 1e6;
      this.histogram.reset();
      return Number.isFinite(mean) && Number.isFinite(max)
        ? { mean: Math.round(mean * 100) / 100, max: Math.round(max * 100) / 100 }
        : undefined;
    } catch {
      // Telemetry must never be the reason a turn fails.
      return undefined;
    }
  }
}

const processEventLoopDelay = new EventLoopDelaySampler();

/** Where {@link SupervisorRunnerClient.launch} leaves the bearer it minted, so the
 *  attempt that started the turn is the only one that can retire it. It rides the
 *  options object — the transport hands `launch` a spread of exactly the object
 *  `startTurn` was given — rather than a turn-keyed map, which two start attempts
 *  for one turn id would share. */
const GATEWAY_BEARER = Symbol('verity.mcpGatewayBearer');

interface GatewayBearerBox {
  token?: string;
}

/** Stage 5c client: starts a fresh turn on the Sandbox supervisor, then delegates
 * replay/idempotent ingestion and reconnect-safe control to FileTailRunnerClient. */
export class SupervisorRunnerClient implements RunnerClient {
  private readonly transport: FileTailRunnerClient;
  private readonly workerBackend: RunnerSupervisorBackend;
  /** Per-turn resume offset, set in {@link launch} (restore-before-launch) and read
   * by the tail when the claude session id lands. Keyed by turnId; cleared on settle. */
  private readonly resumeOffsets = new Map<string, number>();
  /** True for the ACP transports that carry brokered secret tools, which reach them
   * over the MCP gateway instead of the worker's attested native channel (ADR 0014
   * D1). Written out by hand rather than derived from the ACP backend list, because
   * it is not "is this ACP" — `opencode-acp` is an ACP transport and is deliberately
   * NOT here: it carries no brokered tools, so minting a gateway bearer for it would
   * hand a credential to a turn with nothing to spend it on. A fourth adapter has to
   * make that decision for itself, which is the point of listing them. */
  private readonly acpBackend: boolean;
  /** Turn starts in flight through THIS client — the number that says whether a slow
   * start is one turn being slow or a queue of them piling up. */
  private activeStarts = 0;

  constructor(
    backend: Backend,
    private readonly options: SupervisorRunnerClientOptions,
  ) {
    if (!isRunnerSupervisorBackend(backend.runnerSupervisorBackend)) {
      throw new Error('backend does not support the supervisor worker');
    }
    this.workerBackend = backend.runnerSupervisorBackend;
    this.acpBackend = this.workerBackend === 'claude-acp' || this.workerBackend === 'codex-acp';
    if (options.onTelemetry !== undefined) processEventLoopDelay.arm();
    const turnsDir = join(options.runtimeDir, 'turns');
    const artifact = (turnId: string | undefined, name: string): string => {
      if (turnId === undefined || !SAFE_ID.test(turnId)) {
        throw new Error('supervisor runner requires a valid turnId');
      }
      return join(turnsDir, turnId, name);
    };
    this.transport = new FileTailRunnerClient(backend, {
      store: options.store,
      bus: options.bus,
      allocateEventFile: (turnId) => artifact(turnId, 'events.jsonl'),
      allocateControlSocket: (turnId) => artifact(turnId, 'control.sock'),
      launchTurn: async (opts) => await this.launch(opts),
      ...(options.autoApprovePermission === undefined
        ? {}
        : { autoApprovePermission: options.autoApprovePermission }),
    });
  }

  startTurn(opts: RunTurnOptions, hooks: StartTurnHooks): RunnerTurn {
    // The injected sink is backend-specific: Claude persists its project transcript;
    // Codex persists its rollout JSONL. Backends without a sink keep the plain path.
    const sink = this.options.transcript;
    const mappedOpts = this.options.mapTurnOptions?.(opts) ?? opts;
    // One box per start attempt. `launch` mints into it and this attempt's settle
    // retires whatever it finds there, so a second attempt for the same turn id
    // cannot cut off a bearer that is still in use.
    const bearer: GatewayBearerBox = {};
    const launchOpts: RunTurnOptions = Object.assign({}, mappedOpts, {
      [GATEWAY_BEARER]: bearer,
    });
    if (sink === undefined) {
      return this.withSupervisorCancel(
        this.releaseGatewayTokenOnSettle(this.transport.startTurn(launchOpts, hooks), bearer),
        mappedOpts.turnId,
      );
    }
    const storeSessionId = mappedOpts.storeSessionId;
    if (storeSessionId === undefined || !SAFE_ID.test(storeSessionId)) {
      throw new Error('supervisor transcript persistence requires storeSessionId');
    }

    // Server-side transcript persistence (Stage 5b Slice 2). The tail starts once the
    // backend session id lands on the `session` frame, keying both the `.jsonl`
    // path and the store by that id, and stops
    // (with a final flush) when the turn settles.
    const tailAbort = new AbortController();
    let tailDone: Promise<void> | undefined;
    const startTail = (sessionId: string): void => {
      if (tailDone !== undefined || tailAbort.signal.aborted) return;
      const startOffset = this.resumeOffsets.get(mappedOpts.turnId ?? '') ?? 0;
      tailDone = sink
        .tail(sessionId, mappedOpts.cwd, storeSessionId, startOffset, tailAbort.signal)
        .catch(() => undefined);
    };
    const wrappedHooks: StartTurnHooks = {
      ...hooks,
      onSession: async (id: string) => {
        await hooks.onSession?.(id);
        startTail(id);
      },
    };
    const turn = this.transport.startTurn(launchOpts, wrappedHooks);
    const settle = async (): Promise<void> => {
      tailAbort.abort();
      if (tailDone !== undefined) await tailDone;
      if (mappedOpts.turnId !== undefined) this.resumeOffsets.delete(mappedOpts.turnId);
    };
    const result = turn.result.then(
      async (value) => {
        await settle();
        return value;
      },
      async (error) => {
        await settle();
        throw error;
      },
    );
    return this.withSupervisorCancel(
      this.releaseGatewayTokenOnSettle({ ...turn, result }, bearer),
      mappedOpts.turnId,
    );
  }

  /** Retire the bearer this start attempt minted once its turn settles, either way. The
   * registry expires tokens by itself, so this only shortens the window; it is not the
   * fence. */
  private releaseGatewayTokenOnSettle(turn: RunnerTurn, bearer: GatewayBearerBox): RunnerTurn {
    const tokens = this.options.mcpGatewayTokens;
    if (!this.acpBackend || tokens === undefined) return turn;
    const release = (): void => {
      const token = bearer.token;
      if (token === undefined) return;
      try {
        tokens.release(token);
      } catch {
        // Cleanup must never turn a settled turn into a failed one.
      }
    };
    return {
      ...turn,
      result: turn.result.then(
        (value) => {
          release();
          return value;
        },
        (error: unknown) => {
          release();
          throw error;
        },
      ),
    };
  }

  private withSupervisorCancel(turn: RunnerTurn, turnId: string | undefined): RunnerTurn {
    if (turnId === undefined || !SAFE_ID.test(turnId)) return turn;
    return {
      ...turn,
      forceCancel: async (): Promise<boolean> => {
        try {
          const response = await requestRunnerSupervisor(
            join(this.options.runtimeDir, 'supervisor.sock'),
            { kind: 'cancel-turn', turnId },
            this.options.timeoutMs,
          );
          if (response.outcome !== 'cancelled' && response.outcome !== 'terminal') {
            throw new Error('runner supervisor returned an invalid cancel outcome');
          }
        } catch (error) {
          // A response can be lost after the supervisor killed the worker. Only
          // settle locally when a follow-up state read proves the turn terminal.
          try {
            const status = await requestRunnerSupervisor(
              join(this.options.runtimeDir, 'supervisor.sock'),
              { kind: 'get-turn', turnId },
              this.options.timeoutMs,
            );
            if (parseState(status.state, turnId)?.status !== 'settled') throw error;
          } catch {
            throw error;
          }
        }
        await turn.forceCancel?.();
        // Either `cancelled` or `terminal` is positive proof that the worker no
        // longer owns the turn. The boolean is a termination certificate, not a
        // report of whether this particular request delivered the kill.
        return true;
      },
    };
  }

  attach(target: RunnerAttachTarget, hooks: StartTurnHooks): RunnerTurn {
    return this.withSupervisorCancel(this.transport.attach(target, hooks), target.turnId);
  }

  /** Execute one ADR 0011 trusted CLI request inside the project Sandbox. */
  async runTrustedCli(input: TrustedCliExecutionInput): Promise<TrustedCliExecutionResult> {
    return runSupervisorTrustedCli(this.options.runtimeDir, input);
  }

  private async launch(opts: RunTurnOptions & { turnId: string }): Promise<void> {
    if (opts.signal?.aborted === true) throw new Error('runner turn was cancelled before launch');
    if (opts.startCommandId === undefined || !SAFE_ID.test(opts.startCommandId)) {
      throw new Error('supervisor runner requires startCommandId');
    }
    if (opts.storeSessionId === undefined || !SAFE_ID.test(opts.storeSessionId)) {
      throw new Error('supervisor runner requires storeSessionId');
    }
    // `command`, `extraArgs`, `spawner`, `claudeHome` and `env` describe how the SERVER
    // would spawn the agent on the loopback path. They are deliberately NOT forwarded:
    // the worker already runs inside the Sandbox and owns its own spawn through the
    // agent spawn broker, so honouring a Server-side spawner/command there is both
    // meaningless and a boundary violation — handing the Server's `process.env` to the
    // Sandbox's tool-bash is exactly what this process split exists to prevent.
    // (The Conductor sets `env` on EVERY turn — see conductor.ts `runOpts` — so keeping
    // it in the fail-closed set below rejected every real turn.)
    //
    // `onSteer` and `onPermissionRequest` DO carry behavior the worker cannot perform
    // yet: both need a mid-turn Server↔worker round trip over the control socket. Keep
    // failing closed on them so routing can never silently drop steering or a
    // permission prompt. `attachments` is carried (inline image blocks over start-turn).
    if (opts.onSteer !== undefined || opts.onPermissionRequest !== undefined) {
      throw new Error('turn options are not yet supported by the supervisor worker');
    }
    // Verity's own per-turn runtime context is the one part of `opts.env` that must
    // survive: in-Sandbox helpers such as `verity-code-review` read it to start a
    // reviewer on this turn's backend/model. Forward that allowlist only — never the
    // Server's ambient environment.
    const SESSION_RUNTIME_ENV_KEYS = ['VERITY_SESSION_BACKEND', 'VERITY_SESSION_MODEL'];
    const sessionEnv: Record<string, string> = {};
    for (const key of SESSION_RUNTIME_ENV_KEYS) {
      const value = opts.env?.[key];
      if (typeof value === 'string' && value.length > 0) sessionEnv[key] = value;
    }
    // `transcript` left the fail-closed set above because on this path verbatim
    // persistence is owned server-side by the injected {@link
    // SupervisorRunnerClientOptions.transcript} sink (Stage 5b Slice 2), and the
    // Conductor omits `opts.transcript` when it hands turns to the supervisor. But
    // the two switches live at different injection points, so keep the guard COUPLED:
    // if a DB transcript store still reaches the worker with NO server sink to own it,
    // fail closed rather than silently dropping verbatim persistence.
    if (
      this.workerBackend === 'claude-acp' &&
      opts.transcript !== undefined &&
      this.options.transcript === undefined
    ) {
      throw new Error('supervisor worker cannot persist opts.transcript without a server sink');
    }
    // Restore-before-launch (Stage 5b Slice 2): for a `--resume` turn, materialize the
    // durable transcript back onto the shared mount BEFORE the supervisor starts the
    // worker, so the backend's native resume finds it. The returned offset seeds
    // the tail so already-persisted lines are not re-appended.
    if (this.options.transcript !== undefined && opts.resumeSessionId !== undefined) {
      const offset = await this.options.transcript.restoreForResume(
        opts.resumeSessionId,
        opts.cwd,
        opts.storeSessionId,
      );
      this.resumeOffsets.set(opts.turnId, offset);
    }
    const mcpGatewayToken = this.acpBackend
      ? this.options.mcpGatewayTokens?.issue(opts.turnId)
      : undefined;
    // Hand it back to the start attempt that asked for this launch, which is the only
    // one entitled to retire it.
    if (mcpGatewayToken !== undefined) {
      const bearer = (opts as { [GATEWAY_BEARER]?: GatewayBearerBox })[GATEWAY_BEARER];
      if (bearer !== undefined) bearer.token = mcpGatewayToken;
    }
    // Built ONCE and re-sent byte-identical on retry. Idempotence here is not a
    // nicety: the supervisor keys its claim on `turnId`, so an identical frame can
    // only ever adopt the existing turn, while a frame carrying a fresh id would
    // spawn a SECOND worker against the same worktree — which is how the incident's
    // retry produced `agent exited with code 1 without a terminal event`.
    const request: Record<string, unknown> = {
      kind: 'start-turn',
      turnId: opts.turnId,
      startCommandId: opts.startCommandId,
      sessionId: opts.storeSessionId,
      backend: this.workerBackend,
      worktree: opts.worktree,
      cwd: opts.cwd,
      prompt: opts.prompt ?? '',
      ...(opts.attachments?.length ? { attachments: [...opts.attachments] } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      steerable: opts.steerable === true,
      permissionControl: opts.permissionControl === true,
      // Execution authority is separate from advertising the native Codex tool. ACP
      // reaches the same executor through the loopback gateway, while the supervisor
      // still binds every spawn to this live turn.
      trustedCliExecution: this.acpBackend,
      // The mirror image for an ACP turn (ADR 0014 D1): no attested native channel,
      // so the brokered tools arrive as an MCP server the agent calls back into. The
      // bearer is minted per turn and carries the turn's identity on the Server side;
      // the endpoint itself comes from the Sandbox's own broker environment.
      ...(mcpGatewayToken === undefined ? {} : { mcpGatewayToken }),
      ...(opts.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: opts.appendSystemPrompt }
        : {}),
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: [...opts.allowedTools] } : {}),
      ...(opts.disallowedTools !== undefined ? { disallowedTools: [...opts.disallowedTools] } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(Object.keys(sessionEnv).length > 0 ? { sessionEnv } : {}),
    };
    const startedAt = Date.now();
    this.activeStarts += 1;
    let acceptMs: number | undefined;
    let outcome: SupervisorStartTelemetry['outcome'];
    let reconciled = false;
    let artifactMs: number | undefined;
    try {
      const response = await this.requestStart(
        request,
        opts.turnId,
        opts.startCommandId,
        (kind, ms) => {
          if (kind === 'accepted') acceptMs = ms;
          else reconciled = true;
        },
      );
      // Both throws below reject an ANSWERED start, which means a worker may already
      // be running behind them, so each fences first. What licenses the cancel is
      // ownership: `created` says this very frame made the turn, and a state carrying
      // our `startCommandId` says the same by a different route. `already-running`
      // with somebody else's command id says the opposite, and there the fence must
      // NOT fire — a cancel matches on turn id alone and would end a turn running
      // correctly for whoever started it. Recovery settles whatever that leaves.
      const state = parseState(response.state, opts.turnId);
      const ours = response.outcome === 'created' || state?.startCommandId === opts.startCommandId;
      if (!['created', 'already-running', 'terminal'].includes(String(response.outcome))) {
        if (ours) await this.fenceOrphanedStart(opts.turnId);
        throw new Error('runner supervisor returned an invalid start outcome');
      }
      if (
        state === undefined ||
        state.startCommandId !== opts.startCommandId ||
        (response.outcome === 'terminal' ? state.status !== 'settled' : state.status !== 'running')
      ) {
        // `terminal` is the one outcome that cannot strand anything: the supervisor
        // settles a turn only after its child is gone. Cancelling there would spend a
        // round trip writing a tombstone for a worker that has already exited.
        if (ours && response.outcome !== 'terminal') await this.fenceOrphanedStart(opts.turnId);
        throw new Error('runner supervisor returned conflicting turn state');
      }
      outcome = response.outcome as SupervisorStartTelemetry['outcome'];
      const artifactsAt = Date.now();
      await this.waitForArtifacts(opts.turnId, opts.startCommandId);
      artifactMs = Date.now() - artifactsAt;
    } catch (error) {
      // A start that failed as UNCERTAIN is the one outcome that can leave a worker
      // alive behind it: the supervisor took the turn and then stopped talking about
      // it, so this side has no stream to tail and no handle to cancel, while a real
      // agent may be running against the worktree. That orphan is what produced the
      // incident's second symptom, so fence it — the cancel writes its tombstone
      // durably BEFORE it waits on anything, which is why bounding the wait cannot
      // undo the fence. Every other reason is either decided or owned by someone
      // else's start command, and cancelling those would kill a live turn.
      if (error instanceof RunnerWorkerStartFailure && error.reason === 'start-uncertain') {
        await this.fenceOrphanedStart(opts.turnId);
      }
      // Emitted AFTER the decrement, exactly like the success record below. A
      // failure that still counted itself would read one busier than a success at
      // the same depth, and this number exists to be compared across both.
      this.activeStarts -= 1;
      this.emitStartTelemetry({
        turnId: opts.turnId,
        ...(acceptMs === undefined ? {} : { acceptMs }),
        startMs: Date.now() - startedAt,
        outcome: 'failed',
        ...(reconciled ? { reconciled: true as const } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.activeStarts -= 1;
    this.emitStartTelemetry({
      turnId: opts.turnId,
      ...(acceptMs === undefined ? {} : { acceptMs }),
      startMs: Date.now() - startedAt,
      ...(artifactMs === undefined ? {} : { artifactMs }),
      outcome,
      ...(reconciled ? { reconciled: true as const } : {}),
    });
  }

  /**
   * Issue `start-turn`, and treat a lost or late RESPONSE as a question about the
   * turn rather than as its death.
   *
   * The supervisor's answer is not the turn: the turn is the durable state it wrote
   * before answering. So when the response never lands, ask `get-turn` who owns
   * `turnId` — that is the whole point of the Server minting a stable id before
   * launch (ADR 0006 D2). Three answers are possible and each has exactly one safe
   * move: someone is running it (adopt), it already settled (diagnose it), or
   * nothing ever claimed it (re-send the identical frame, which cannot duplicate a
   * worker). A turn still `claimed` when the budget runs out is the one genuinely
   * uncertain case, and it fails closed.
   *
   * The re-send is reserved for a start the supervisor never acknowledged. Once it
   * has, the turn is its property — queued, claiming, or spawning — and the absence
   * of durable state proves nothing, because a start still waiting for a slot has
   * not written any yet. Reconcile such a start or fail it; never send it twice.
   *
   * Read the constants as stages, not as a total: no single one bounds a start. The
   * two paths through here sum differently, and the second is the one to size a
   * caller's own patience against.
   *
   * - Acknowledged, then silent: {@link START_TURN_RESULT_TIMEOUT_MS} (120 s) plus
   *   {@link START_TURN_RECONCILE_TIMEOUT_MS} (30 s) — 150 s, then it fails closed.
   * - Never acknowledged: {@link START_TURN_ACCEPT_TIMEOUT_MS} (15 s), then
   *   reconciliation gets what is LEFT of the 120 s result budget (105 s), then the
   *   re-send spends the 15 s acceptance budget again, and its reconciliation runs
   *   without a budget and so gets the plain 30 s — 165 s in all.
   *
   * Where reconciliation ANSWERS rather than running out, {@link launch} then waits up
   * to {@link START_TURN_ARTIFACT_TIMEOUT_MS} (60 s) for the control socket, which is
   * the longest a start can take to fail: ~225 s. Nothing above imposes a shorter
   * budget: `startTurn` hands back a handle whose `result` settles later, so this
   * delays a failure EVENT and never an HTTP reply. Slow, deliberately: every one of
   * those seconds is spent on a question whose wrong answer either strands a running
   * worker or starts a second one.
   */
  private async requestStart(
    request: Record<string, unknown>,
    turnId: string,
    startCommandId: string,
    note: (kind: 'accepted' | 'reconciled', ms: number) => void,
  ): Promise<Record<string, unknown>> {
    const socketPath = join(this.options.runtimeDir, 'supervisor.sock');
    const timeouts = {
      acceptTimeoutMs: this.options.startAcceptTimeoutMs ?? START_TURN_ACCEPT_TIMEOUT_MS,
      resultTimeoutMs: this.options.startTimeoutMs ?? START_TURN_RESULT_TIMEOUT_MS,
    };
    const issuedAt = Date.now();
    try {
      return await requestRunnerSupervisorStart(socketPath, request, timeouts, () =>
        note('accepted', Date.now() - issuedAt),
      );
    } catch (error) {
      if (!(error instanceof SupervisorStartRequestError)) throw error;
      // A refusal the supervisor actually spoke — or one this side made before the
      // frame left — is a decision, not a lost answer. Reconciling it would only
      // re-read the state it already told us about. Note this deliberately does NOT
      // cover an oversize RESPONSE: that is an answer we failed to read, so the
      // start may well have succeeded and reconciliation is exactly right for it.
      if (error.decided) throw error.cause;
      // An unacknowledged start may still be one a supervisor that predates
      // `startAck` is quietly working on — it answers only once, at the end, so its
      // silence is not a symptom. Give reconciliation the rest of the start budget
      // to watch that turn reach `running` rather than declaring it lost at the
      // acceptance deadline, which is a "did you hear me" bound, not a spawn bound.
      const reconcileBudgetMs = error.accepted
        ? undefined
        : Math.max(0, timeouts.resultTimeoutMs - (Date.now() - issuedAt));
      const reconciledResponse = await this.reconcileStart(
        turnId,
        startCommandId,
        error.cause,
        reconcileBudgetMs,
      );
      if (reconciledResponse !== undefined) {
        note('reconciled', Date.now() - issuedAt);
        return reconciledResponse;
      }
      if (error.accepted) {
        // The supervisor took the request and then stopped talking about it. Missing
        // durable state does not mean "never claimed" here — a start still waiting
        // for a slot has written none — so re-sending could race a worker nobody is
        // tailing. Fail closed and let recovery adopt whatever it finds.
        throw new RunnerWorkerStartFailure(
          `runner supervisor accepted turn ${turnId} and never reported its outcome: ${error.cause.message}`,
          { turnId, reason: 'start-uncertain', cause: error.cause },
        );
      }
      // Nothing claimed `turnId` and the supervisor never acknowledged it, so it
      // never got as far as creating the turn directory: no worker exists and
      // re-sending is safe. Exactly once — a second lost response is a supervisor
      // problem, not a transport hiccup.
      note('reconciled', Date.now() - issuedAt);
      try {
        return await requestRunnerSupervisorStart(socketPath, request, timeouts, () =>
          note('accepted', Date.now() - issuedAt),
        );
      } catch (resent) {
        // Unwrapped like the first attempt's failures above: the transport wrapper
        // exists so this method can read `accepted`, and letting it escape would give
        // callers two different error types for one condition.
        if (!(resent instanceof SupervisorStartRequestError)) throw resent;
        if (resent.decided) throw resent.cause;
        // A lost answer to the SECOND frame is the dangerous one: the turn may now be
        // running under a worker nobody is tailing, and unlike the first attempt there
        // is no third send to fall back on. So ask the same question again — the state
        // is still the only witness — and treat what it says as final.
        const reconciledResend = await this.reconcileStart(turnId, startCommandId, resent.cause);
        if (reconciledResend !== undefined) {
          note('reconciled', Date.now() - issuedAt);
          return reconciledResend;
        }
        // Nothing claimed the turn after two frames. If the supervisor never
        // acknowledged either, that is an answer: no worker exists, and the failure is
        // an ordinary one. If it acknowledged this frame, the same silence proves
        // nothing — a start still waiting for a slot has written no state — so it must
        // surface as an uncertainty, or it slips past the fence in `launch` and leaves
        // exactly the orphan this path exists to prevent.
        if (resent.accepted) {
          throw new RunnerWorkerStartFailure(
            `runner supervisor accepted turn ${turnId} on re-send and never reported its outcome: ${resent.cause.message}`,
            { turnId, reason: 'start-uncertain', cause: resent.cause },
          );
        }
        throw resent.cause;
      }
    }
  }

  /**
   * Ask the supervisor what became of `turnId`. Returns a synthetic start response
   * when the durable state answers the question, or `undefined` when it proves
   * nothing was ever claimed (the caller may then safely re-send).
   */
  private async reconcileStart(
    turnId: string,
    startCommandId: string,
    cause: Error,
    budgetMs?: number,
  ): Promise<Record<string, unknown> | undefined> {
    const socketPath = join(this.options.runtimeDir, 'supervisor.sock');
    const deadline =
      Date.now() +
      Math.max(budgetMs ?? 0, this.options.reconcileTimeoutMs ?? START_TURN_RECONCILE_TIMEOUT_MS);
    // `claimTurn` creates the turn directory BEFORE its atomic state write, so a
    // single missing read is a window, not an answer. Only a run of them, sustained
    // for {@link START_TURN_MISSING_STATE_MIN_MS}, is.
    let consecutiveMissing = 0;
    let missingSince: number | undefined;
    let lastError: Error = cause;
    for (;;) {
      let state: SupervisorState | undefined;
      try {
        // Use the full control budget per poll. The question is whether a BUSY
        // supervisor claimed the turn; impatient retries can turn a healthy start
        // into `start-uncertain` plus an unnecessary cancel.
        const response = await requestRunnerSupervisor(
          socketPath,
          { kind: 'get-turn', turnId },
          this.options.timeoutMs ?? DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS,
        );
        state = parseState(response.state, turnId);
      } catch (error) {
        // The supervisor is unreachable or answering badly. That is not evidence
        // either way, so keep asking until the budget is gone.
        lastError = error instanceof Error ? error : new Error(String(error));
        consecutiveMissing = 0;
        missingSince = undefined;
        if (Date.now() >= deadline) {
          throw new RunnerWorkerStartFailure(
            `runner supervisor did not answer whether turn ${turnId} started: ${lastError.message}`,
            { turnId, reason: 'start-uncertain', cause: lastError },
          );
        }
        await sleep(250);
        continue;
      }
      if (state === undefined) {
        consecutiveMissing += 1;
        missingSince ??= Date.now();
        if (
          consecutiveMissing >= 3 &&
          Date.now() - missingSince >= START_TURN_MISSING_STATE_MIN_MS
        ) {
          return undefined;
        }
      } else {
        consecutiveMissing = 0;
        missingSince = undefined;
        if (state.startCommandId !== startCommandId) {
          throw new RunnerWorkerStartFailure(
            `runner supervisor turn ${turnId} is owned by another start command`,
            { turnId, reason: 'start-conflict', cause },
          );
        }
        if (state.status === 'running') return { ok: true, outcome: 'already-running', state };
        if (state.status === 'settled') return { ok: true, outcome: 'terminal', state };
      }
      if (Date.now() >= deadline) {
        // A run of misses that outlasted the whole budget is the same answer as one
        // that outlasted the floor, and a budget shorter than the floor must not turn
        // "never claimed" into "uncertain".
        if (consecutiveMissing >= 3) return undefined;
        // Still `claimed`: a worker may be mid-spawn. Never re-send into that.
        throw new RunnerWorkerStartFailure(
          `runner supervisor turn ${turnId} did not reach a decided state after ` +
            `the start response was lost: ${lastError.message}`,
          { turnId, reason: 'start-uncertain', cause: lastError },
        );
      }
      await sleep(100);
    }
  }

  /**
   * Best-effort `cancel-turn` for a start this side is about to stop accounting for.
   *
   * Two callers, and they reach it from opposite directions. {@link launch} fences a
   * start whose outcome was never learned, where a worker MAY be running. The artifact
   * wait fences one where the supervisor has just said a worker IS running and this
   * side still has no control socket to steer or cancel it with. Both end the same
   * way — this process walks away from a turn nothing else will settle — and that,
   * not the uncertainty, is what has to be fenced.
   *
   * Bounded by the ordinary control budget rather than by the start budget, and the
   * bound costs nothing: the supervisor registers the cancellation and writes its
   * durable tombstone BEFORE it awaits the in-flight start, and it does not abort a
   * request handler when the peer's socket dies. So a timeout here abandons only the
   * ANSWER — the fence itself has already landed and the worker still dies. Waiting
   * longer would buy the caller nothing but a later failure event.
   *
   * Failures are swallowed on purpose — the turn is failing either way, and a fence
   * that could itself throw would replace a diagnosable start error with a cancel
   * error. A supervisor unreachable enough that no tombstone was written leaves the
   * orphan to recovery, which is what recovery is for.
   */
  private async fenceOrphanedStart(turnId: string): Promise<void> {
    if (!SAFE_ID.test(turnId)) return;
    try {
      await requestRunnerSupervisor(
        join(this.options.runtimeDir, 'supervisor.sock'),
        { kind: 'cancel-turn', turnId },
        this.options.timeoutMs ?? DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS,
      );
    } catch {
      // Recovery adopts whatever survives this; see SupervisorRunnerRecovery.
    }
  }

  private emitStartTelemetry(telemetry: Omit<SupervisorStartTelemetry, 'activeStarts'>): void {
    const onTelemetry = this.options.onTelemetry;
    if (onTelemetry === undefined) return;
    const eventLoopDelayMs = processEventLoopDelay.sample();
    try {
      onTelemetry({
        ...telemetry,
        activeStarts: this.activeStarts,
        ...(eventLoopDelayMs === undefined ? {} : { eventLoopDelayMs }),
      });
    } catch {
      // Observability must never be the reason a turn fails.
    }
  }

  private async waitForArtifacts(turnId: string, startCommandId: string): Promise<void> {
    const turnDir = join(this.options.runtimeDir, 'turns', turnId);
    const controlPath = join(turnDir, 'control.sock');
    const eventPath = join(turnDir, 'events.jsonl');
    const deadline =
      Date.now() + (this.options.artifactTimeoutMs ?? START_TURN_ARTIFACT_TIMEOUT_MS);
    for (;;) {
      const control = await lstat(controlPath).catch(() => undefined);
      if (control?.isSocket() === true && !control.isSymbolicLink()) return;
      // A slow state answer is harmless here: the next iteration re-checks the
      // socket. Let this poll use the remaining artifact budget instead of
      // failing an otherwise healthy turn at the one-second poll interval.
      const remaining = deadline - Date.now();
      const requestTimeoutMs = Math.max(
        1,
        Math.min(this.options.timeoutMs ?? remaining, remaining),
      );
      let response: Record<string, unknown>;
      try {
        response = await requestRunnerSupervisor(
          join(this.options.runtimeDir, 'supervisor.sock'),
          { kind: 'get-turn', turnId },
          requestTimeoutMs,
        );
      } catch (error) {
        // When the request was given the whole remaining artifact budget, its own
        // timeout IS the artifact deadline. A timer callback can run within the
        // final clock tick while Date.now() still reads just below `deadline`; a
        // second wall-clock comparison then leaked the lower-level get-turn error
        // and skipped the orphan fence. Preserve an earlier, independently bounded
        // supervisor failure (and any immediate socket/protocol failure), but
        // translate the timeout that consumed this budget.
        const consumedArtifactBudget =
          requestTimeoutMs >= remaining &&
          error instanceof Error &&
          error.message === 'runner supervisor request timed out: get-turn';
        if (!consumedArtifactBudget && Date.now() < deadline) throw error;
        await this.fenceOrphanedStart(turnId);
        throw new Error('runner control socket did not become ready', { cause: error });
      }
      const state = parseState(response.state, turnId);
      if (state === undefined || state.startCommandId !== startCommandId) {
        throw new Error('runner supervisor lost the started turn');
      }
      if (state.status === 'settled') {
        let disposition: SettledStreamDisposition;
        try {
          disposition = await inspectSettledStreamStrict(eventPath, turnId);
        } catch (error) {
          if (isFileSystemError(error, 'ENOENT')) {
            if (hasWorkerFailure(state)) {
              throw workerStartFailure(turnId, 'worker-exited-early', state, {
                message: settledWorkerFailure(state),
                cause: error,
              });
            }
            throw workerStartFailure(turnId, 'event-stream-missing', state, {
              message:
                state.workerExitCode === 0
                  ? 'settled runner event stream is missing after the worker exited successfully'
                  : 'settled runner event stream is missing without worker failure diagnostics',
              cause: error,
            });
          }
          throw new Error(
            `settled runner event stream is not accessible${fileSystemErrorSuffix(error)}`,
            { cause: error },
          );
        }
        if (disposition === 'result') return;
        // The worker died before it wrote a terminal frame. A current supervisor
        // usually got here first and synthesized one — that is the better path,
        // because a frame reaches the operator through the normal event stream. This
        // branch still owns the two cases it cannot cover: a supervisor too old to
        // write the frame, and a worker that wrote SOME frames and then died, where
        // the sequence belongs to the worker and nobody may append to it (D3).
        // Report WHY, structurally: the supervisor already captured the exit code,
        // signal and stderr tail, and dropping them is what left the operator with a
        // bare "exited with code 1".
        if (hasWorkerFailure(state)) {
          throw workerStartFailure(turnId, 'worker-exited-early', state, {
            message: `runner worker failed before producing a terminal event: ${workerFailureDetail(state)}`,
          });
        }
        throw workerStartFailure(turnId, 'no-terminal-event', state, {
          message: 'settled runner event stream has no terminal result',
        });
      }
      if (Date.now() >= deadline) {
        // The supervisor said `running` and never produced the socket that steers or
        // cancels that worker. Giving up here without a fence abandons a turn this
        // side KNOWS is alive — the same orphan `launch` fences on an uncertain
        // start, arrived at from the opposite direction. Safe to cancel precisely
        // because of the check above: the state carries OUR `startCommandId`. Where
        // it carried someone else's the loop has already thrown, and it must, since
        // a cancel by turn id would kill a live turn belonging to another command.
        await this.fenceOrphanedStart(turnId);
        throw new Error('runner control socket did not become ready');
      }
      await sleep(25);
    }
  }
}

/**
 * Unref'd deliberately, and it is a real choice rather than a habit: these sleeps
 * pace the reconcile and artifact polls, which can span half a minute each. A ref'd
 * timer would hold the process open for the rest of that budget at shutdown, on the
 * chance that someone still cares about the answer. If the loop has emptied of every
 * other handle then nobody does — the caller awaiting this start is a promise, not a
 * handle, and no reply, tail or timer is left to deliver its outcome to anyone.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function workerStartFailure(
  turnId: string,
  reason: RunnerWorkerFailureReason,
  state: SupervisorState,
  detail: { message: string; cause?: unknown },
): RunnerWorkerStartFailure {
  return new RunnerWorkerStartFailure(detail.message, {
    turnId,
    reason,
    ...(state.workerExitCode === undefined ? {} : { workerExitCode: state.workerExitCode }),
    ...(state.workerSignal === undefined ? {} : { workerSignal: state.workerSignal }),
    ...(state.workerError === undefined ? {} : { workerError: state.workerError }),
    ...(detail.cause === undefined ? {} : { cause: detail.cause }),
  });
}

type SupervisorState = {
  protocolVersion: number;
  turnId: string;
  startCommandId: string;
  runnerInstanceId: string;
  status: 'claimed' | 'running' | 'settled';
  workerExitCode?: number | null;
  workerSignal?: string | null;
  workerError?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseState(value: unknown, turnId: string): SupervisorState | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isObject(value) ||
    !supportedProtocolVersion(value.protocolVersion) ||
    value.turnId !== turnId ||
    typeof value.startCommandId !== 'string' ||
    !SAFE_ID.test(value.startCommandId) ||
    typeof value.runnerInstanceId !== 'string' ||
    !SAFE_ID.test(value.runnerInstanceId) ||
    !['claimed', 'running', 'settled'].includes(String(value.status)) ||
    (value.workerExitCode !== undefined &&
      value.workerExitCode !== null &&
      !Number.isInteger(value.workerExitCode)) ||
    (value.workerSignal !== undefined &&
      value.workerSignal !== null &&
      (typeof value.workerSignal !== 'string' || !/^SIG[A-Z0-9]+$/.test(value.workerSignal))) ||
    (value.workerError !== undefined &&
      (typeof value.workerError !== 'string' ||
        Buffer.byteLength(value.workerError) > MAX_WORKER_ERROR_BYTES))
  ) {
    throw new Error('invalid runner supervisor turn state');
  }
  return value as SupervisorState;
}

function settledWorkerFailure(state: SupervisorState): string {
  return `runner worker failed before creating its event stream: ${workerFailureDetail(state)}`;
}

function hasWorkerFailure(state: SupervisorState): boolean {
  return (
    state.workerError !== undefined ||
    (state.workerExitCode !== undefined &&
      state.workerExitCode !== null &&
      state.workerExitCode !== 0) ||
    (state.workerSignal !== undefined && state.workerSignal !== null)
  );
}

function workerFailureDetail(state: SupervisorState): string {
  if (state.workerError?.trim()) return state.workerError.trim();
  if (state.workerSignal !== null && state.workerSignal !== undefined) {
    return `worker terminated by signal ${state.workerSignal}`;
  }
  return state.workerExitCode === null || state.workerExitCode === undefined
    ? 'worker exited without reporting an exit code'
    : `worker exited with code ${String(state.workerExitCode)}`;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function fileSystemErrorSuffix(error: unknown): string {
  return isObject(error) && typeof error.code === 'string' ? ` (${error.code})` : '';
}

type SettledStreamDisposition = 'result' | 'absent' | 'uncertain';

async function inspectSettledStreamStrict(
  eventFilePath: string,
  turnId: string,
): Promise<SettledStreamDisposition> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(eventFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw Object.assign(new Error('event stream is not a regular file'), { code: 'EINVAL' });
    }
    if (stats.size === 0) return 'absent';
    const length = Math.min(stats.size, MAX_SETTLED_RESULT_FRAME_BYTES + 2);
    const bytes = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(
        bytes,
        bytesRead,
        length - bytesRead,
        stats.size - length + bytesRead,
      );
      if (read.bytesRead === 0) return 'uncertain';
      bytesRead += read.bytesRead;
    }
    if (bytes.at(-1) !== 0x0a) return 'absent';
    const lineEnd = length - 1;
    const priorLf = bytes.lastIndexOf(0x0a, lineEnd - 1);
    if (priorLf === -1 && stats.size > length) return 'uncertain';
    const line = bytes.subarray(priorLf + 1, lineEnd);
    if (line.length === 0 || line.length > MAX_SETTLED_RESULT_FRAME_BYTES) return 'absent';
    try {
      const frame: unknown = JSON.parse(line.toString('utf8'));
      return isObject(frame) &&
        supportedProtocolVersion(frame.protocolVersion) &&
        frame.turnId === turnId &&
        frame.kind === 'result'
        ? 'result'
        : 'absent';
    } catch {
      return 'absent';
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectSettledStream(
  eventFilePath: string,
  turnId: string,
): Promise<SettledStreamDisposition> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // The runtime is shared with the Sandbox. Open the file itself with O_NOFOLLOW
    // and validate that descriptor, rather than lstat-then-read through a swap race.
    handle = await open(eventFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) return 'uncertain';
    if (stats.size === 0) return 'absent';
    const length = Math.min(stats.size, MAX_SETTLED_RESULT_FRAME_BYTES + 2);
    const bytes = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(
        bytes,
        bytesRead,
        length - bytesRead,
        stats.size - length + bytesRead,
      );
      if (read.bytesRead === 0) return 'uncertain';
      bytesRead += read.bytesRead;
    }
    if (bytes.at(-1) !== 0x0a) {
      return stats.size > MAX_SETTLED_RESULT_FRAME_BYTES ? 'uncertain' : 'absent';
    }
    const lineEnd = length - 1;
    const priorLf = bytes.lastIndexOf(0x0a, lineEnd - 1);
    if (priorLf === -1 && stats.size > length) return 'uncertain';
    const line = bytes.subarray(priorLf + 1, lineEnd);
    if (line.length === 0) return 'absent';
    if (line.length > MAX_SETTLED_RESULT_FRAME_BYTES) return 'uncertain';
    const frame: unknown = JSON.parse(line.toString('utf8'));
    return isObject(frame) &&
      supportedProtocolVersion(frame.protocolVersion) &&
      frame.turnId === turnId &&
      frame.kind === 'result'
      ? 'result'
      : 'absent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    if (error instanceof SyntaxError) return 'absent';
    return 'uncertain';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Refuse over-cap frames here rather than discovering the bound mid-write. The
 * supervisor rejects the whole serialized request — inline image base64 included —
 * so name the size and the attachment count: those are the two facts that turn "the
 * turn failed" into "this photo is too big to send".
 */
function oversizeRequestError(frame: string, request: Record<string, unknown>): Error | undefined {
  const frameBytes = Buffer.byteLength(frame) - 1;
  if (frameBytes <= MAX_SUPERVISOR_REQUEST_BYTES) return undefined;
  const attachments = Array.isArray(request.attachments) ? request.attachments.length : 0;
  return new Error(
    `runner supervisor request too large: ${describeBytes(frameBytes)} exceeds the ` +
      `${describeBytes(MAX_SUPERVISOR_REQUEST_BYTES)} limit` +
      (attachments > 0
        ? ` — send fewer or smaller image attachments (${String(attachments)} attached)`
        : ''),
  );
}

/**
 * The supervisor answers every refusal with `{ ok: false, error }`
 * (verity-runner-supervisor.mjs). Dropping that message is why a rejected request
 * reaches the operator as an unexplained failed run: the one fact that would end
 * the search is discarded a frame before it could be shown.
 */
function rejectionMessage(parsed: unknown): string {
  const reason =
    isObject(parsed) && typeof parsed.error === 'string' && parsed.error !== ''
      ? parsed.error
      : undefined;
  return reason === undefined
    ? 'runner supervisor rejected request'
    : `runner supervisor rejected request: ${reason}`;
}

export async function requestRunnerSupervisor(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const frame = `${JSON.stringify({ protocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION, ...request })}\n`;
  const oversize = oversizeRequestError(frame, request);
  if (oversize !== undefined) throw oversize;
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(response ?? {});
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `runner supervisor request timed out: ${typeof request.kind === 'string' ? request.kind : 'unknown'}`,
          ),
        ),
      timeoutMs,
    );
    const settleFromBuffer = (): void => {
      try {
        const lines = buffer.toString('utf8').trimEnd().split('\n');
        const line = lines[0];
        if (lines.length !== 1 || line === undefined || line === '') {
          throw new Error('runner supervisor returned an invalid frame count');
        }
        const parsed: unknown = JSON.parse(line);
        if (!isObject(parsed) || parsed.ok !== true) throw new Error(rejectionMessage(parsed));
        finish(undefined, parsed);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    // A refusal the supervisor already sent outranks the transport error that
    // followed it. It refuses mid-stream and closes, so the Server's remaining
    // write dies with EPIPE/ECONNRESET while the answer sits complete in this
    // buffer — reporting the write error there discards the one fact that
    // explains the failure. Only fall back to the transport error when no whole
    // frame arrived.
    socket.once('error', (error) => {
      if (settled) return;
      if (buffer.includes(0x0a)) settleFromBuffer();
      else finish(error);
    });
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
        finish(new Error('runner supervisor response too large'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.once('end', settleFromBuffer);
    socket.once('connect', () => {
      // Written at the floor, not at this Server's own version — ADR 0006 D9.
      //
      // Reading a range only covers what the Runner sends. A request is read by a
      // supervisor that shipped inside the Sandbox image, and every supervisor
      // already deployed checks the version for equality, so the first genuine
      // bump would make an N Server unable to ask an N−1 Runner anything — the
      // fleet-wide outage the range exists to prevent, reached from the other
      // side. The oldest dialect this Server still supports is the one every
      // supported peer can read, and {@link MIN_SUPPORTED_PROTOCOL_VERSION} is
      // then the single knob: raising it drops old Runners in both directions at
      // once, rather than in one silently ahead of the other.
      socket.write(frame);
    });
  });
}

/** Distinguishes "the supervisor never took the request" from "it took it and then
 *  went quiet", which is the whole difference between a safe retry and an unsafe one. */
export class SupervisorStartRequestError extends Error {
  constructor(
    override readonly cause: Error,
    /** True once the supervisor answered `start-accepted`: the turn is claimed or about to be. */
    readonly accepted: boolean,
    /**
     * True when the failure is an ANSWER rather than a lost one: a refusal the
     * supervisor spoke, or one this side made before a byte reached it. Either way
     * the outcome is already known, so reconciliation has nothing left to discover.
     * Carried as a flag rather than recovered by matching the message text, so a
     * reworded error cannot silently turn a decision into a retry.
     *
     * Trusting a refusal that arrives AFTER `start-accepted` rests on two properties
     * of the supervisor, and would be unsafe without them. Every refusal it can speak
     * post-acknowledgement is either PRE-CLAIM — an overloaded queue, a shutdown that
     * began while the start sat in it, an unsupported backend, all of them refused
     * before `claimTurn` and with no process to show for it — or POST-SETTLEMENT, a
     * start that failed after spawning and has already SIGKILLed its child and
     * awaited the settlement that writes the terminal frame. Neither leaves a worker
     * running. And the supervisor's own request deadline DESTROYS the socket
     * rather than answering: a supervisor that ran out of time is therefore a lost
     * answer, not a decided one, and still reaches reconciliation and the fence.
     *
     * One gap is known and accepted on the supervisor's side rather than papered
     * over here: that reap is bounded by `REJECTED_WORKER_EXIT_WAIT_MS`, so a child
     * wedged in uninterruptible sleep past the bound is reported dead while it is
     * not. The bound exists because the alternative is a turn that can never be
     * reported at all, which is the hang this whole path removes; a pid that
     * outlives its own SIGKILL is a stuck kernel, not a case the protocol can fix.
     */
    readonly decided = false,
  ) {
    super(cause.message, { cause });
    this.name = 'SupervisorStartRequestError';
  }
}

/**
 * Issue one `start-turn` and read the supervisor's TWO-PHASE answer.
 *
 * A supervisor that understands `startAck` replies `{ ok: true, kind:
 * 'start-accepted' }` as soon as it has validated the frame and queued the start,
 * then sends the real outcome when the worker is up. Splitting the two is what lets
 * the Server hold a short, honest budget on "did you hear me" while giving the
 * actual spawn the time it needs — the single-budget version is why a busy host
 * turned a healthy start into `runner supervisor request timed out: start-turn`.
 *
 * A supervisor that predates the flag simply sends the final frame first (ADR 0006
 * D9) — it does not reject the request over the unknown key, because its
 * `validateStartTurnRequest` builds an allow-listed object rather than checking the
 * frame for surplus fields, so `startAck` is dropped on the floor and the start runs
 * exactly as before. That is what makes a Server rolled ahead of its Sandbox image
 * safe here, and `ignores request fields it does not know` in the supervisor suite
 * is the test that keeps it true. A fast legacy start is therefore
 * indistinguishable from a fast new one; a
 * legacy start SLOWER than the acceptance budget trips it, because the two cases —
 * "still working" and "not listening" — look identical on a silent socket. That is
 * not the failure it looks like: the caller answers the question the socket cannot,
 * by asking `get-turn` who owns the turn, and adopts the start it finds.
 */
export async function requestRunnerSupervisorStart(
  socketPath: string,
  request: Record<string, unknown>,
  timeouts: { acceptTimeoutMs: number; resultTimeoutMs: number },
  onAccepted?: () => void,
): Promise<Record<string, unknown>> {
  const frame = `${JSON.stringify({ protocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION, ...request, startAck: true })}\n`;
  const oversize = oversizeRequestError(frame, request);
  if (oversize !== undefined) throw new SupervisorStartRequestError(oversize, false, true);
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let accepted = false;
    let decided = false;
    /** Set once the frame has left this process — the line between "the supervisor
     *  never heard of this turn" and "it may be running one". */
    let wrote = false;
    let timeout = setTimeout(
      () => finish(new Error('runner supervisor request timed out: start-turn acceptance')),
      timeouts.acceptTimeoutMs,
    );
    timeout.unref?.();
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      // A failure with the frame still in hand is DECIDED, whatever it was: a socket
      // that is not there, a connection refused, a listener whose backlog never
      // accepted us. The supervisor cannot have started a turn it was never told
      // about, so there is nothing to reconcile and nothing to fence — and treating it
      // as a lost answer would spend ~165 s asking an absent supervisor about a turn
      // that does not exist, then brand the turn `start-uncertain`, the one reason the
      // Conductor must never retry. A sandbox that is restarting would poison the turn
      // it was merely late for. Failing fast here is also the honest report: the
      // operator sees `connect ENOENT`, not a timeout that names the wrong suspect.
      if (error !== undefined) {
        reject(new SupervisorStartRequestError(error, accepted, decided || !wrote));
      } else resolve(response ?? {});
    };
    const armResultTimeout = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => finish(new Error('runner supervisor request timed out: start-turn')),
        timeouts.resultTimeoutMs,
      );
      timeout.unref?.();
    };
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      // Optimistic on purpose: an error DURING the write leaves it unknown whether the
      // supervisor read the frame first, and the unknown case belongs on the
      // reconciling side of the line, not the deciding one.
      wrote = true;
      socket.write(frame);
    });
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
        finish(new Error('runner supervisor response too large'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish(new Error('runner supervisor returned malformed JSON'));
          return;
        }
        if (!isObject(parsed) || parsed.ok !== true) {
          // Spoken, so decided — including after `start-accepted`, where the refusal
          // is the outcome frame the acknowledgement promised.
          decided = true;
          finish(new Error(rejectionMessage(parsed)));
          return;
        }
        if (parsed.kind === 'start-accepted') {
          if (accepted) {
            finish(new Error('runner supervisor returned duplicate start acknowledgement'));
            return;
          }
          // This frame is what re-arms the short "did you hear me" budget to the long
          // spawn budget, and what tells the caller the turn is the supervisor's
          // property now — a decision too consequential to make on an acknowledgement
          // that names a different turn. Checked only when the field is present, so
          // the accepted shape stays the one the supervisor documents rather than one
          // this check silently narrows.
          if (
            (parsed.turnId !== undefined && parsed.turnId !== request.turnId) ||
            (parsed.startCommandId !== undefined &&
              parsed.startCommandId !== request.startCommandId)
          ) {
            finish(new Error('runner supervisor acknowledged a different start'));
            return;
          }
          accepted = true;
          armResultTimeout();
          onAccepted?.();
          continue;
        }
        finish(undefined, parsed);
        return;
      }
    });
    socket.once('end', () => {
      if (!settled) finish(new Error('runner supervisor closed before the start outcome'));
    });
  });
}

export interface SupervisorRunnerRecoveryOptions {
  dataVolumeRoot: string;
  getSession(sessionId: string): Promise<{ projectId: string | null } | undefined>;
  controlPlaneProjectId?: string | undefined;
  timeoutMs?: number;
}

/** Stage 5a discovery adapter. It is deliberately not production-wired until the
 * supervisor owns fresh turn launch (Stage 5b). */
export class SupervisorRunnerRecovery implements RunnerRecovery {
  constructor(private readonly options: SupervisorRunnerRecoveryOptions) {}

  async discover(marker: {
    sessionId: string;
    turnId: string;
    startCommandId: string | null;
  }): Promise<RunnerRecoveryOutcome> {
    if (!SAFE_ID.test(marker.turnId) || marker.startCommandId === null)
      return { status: 'uncertain' };
    try {
      const session = await this.options.getSession(marker.sessionId);
      const projectId = session?.projectId ?? this.options.controlPlaneProjectId;
      if (session === undefined || projectId === undefined || !SAFE_ID.test(projectId)) {
        return { status: 'uncertain' };
      }
      const runtime = join(this.options.dataVolumeRoot, 'runners', projectId);
      const runtimeStats = await lstat(runtime);
      if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
        return { status: 'uncertain' };
      }
      const response = await requestRunnerSupervisor(
        join(runtime, 'supervisor.sock'),
        { kind: 'get-turn', turnId: marker.turnId },
        this.options.timeoutMs,
      );
      const state = parseState(response.state, marker.turnId);
      // Missing state is NOT proof of death: claimTurn creates the directory before
      // its atomic state write, so a concurrent get-turn can observe this window.
      if (state === undefined) return { status: 'uncertain' };
      if (state.startCommandId !== marker.startCommandId || state.status === 'claimed') {
        return { status: 'uncertain' };
      }
      const turnDir = join(runtime, 'turns', marker.turnId);
      const eventFilePath = join(turnDir, 'events.jsonl');
      const controlSocketPath = join(turnDir, 'control.sock');
      const turnsStats = await lstat(join(runtime, 'turns'));
      const turnStats = await lstat(turnDir);
      if (
        !turnsStats.isDirectory() ||
        turnsStats.isSymbolicLink() ||
        !turnStats.isDirectory() ||
        turnStats.isSymbolicLink()
      ) {
        return { status: 'uncertain' };
      }
      if (state.status === 'settled') {
        const disposition = await inspectSettledStream(eventFilePath, marker.turnId);
        if (disposition === 'absent') {
          return { status: 'dead' };
        }
        if (disposition === 'uncertain') return { status: 'uncertain' };
      } else {
        const eventStats = await lstat(eventFilePath).catch(() => undefined);
        if (eventStats?.isFile() !== true || eventStats.isSymbolicLink()) {
          return { status: 'uncertain' };
        }
      }
      if (state.status === 'running') {
        const controlStats = await lstat(controlSocketPath);
        if (!controlStats.isSocket() || controlStats.isSymbolicLink())
          return { status: 'uncertain' };
      }
      return {
        status: 'live',
        target: {
          turnId: marker.turnId,
          sessionId: marker.sessionId,
          protocolVersion: state.protocolVersion,
          eventFilePath,
          controlSocketPath,
        },
      };
    } catch {
      return { status: 'uncertain' };
    }
  }
}
