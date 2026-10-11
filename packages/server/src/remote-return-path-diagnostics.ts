import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const RETURN_PATH_LIMITS = { streams: 64, events: 256, durationMs: 600_000 } as const;
const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
const TYPES = new Set(['stream.open', 'stream.data', 'stream.end', 'stream.reset', 'attached']);
const ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'WS_ERR_INVALID_UTF8',
  'WS_ERR_UNEXPECTED_RSV_1',
  'WS_ERR_UNEXPECTED_RSV_2_3',
  'WS_ERR_INVALID_OPCODE',
  'WS_ERR_INVALID_MASK',
  'WS_ERR_EXPECTED_MASK',
  'WS_ERR_UNEXPECTED_MASK',
  'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
  'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
]);
type Stage = 'send' | 'callback' | 'emitted_message' | 'parser' | 'accepted' | 'ws_error' | 'close';
type Outcome = 'observed' | 'accepted' | 'error';
interface StreamTotals {
  firstSend?: Record<string, unknown>;
  firstCallback?: Record<string, unknown>;
  enqueuedFrames: number;
  completedFrames: number;
  errorFrames: number;
  encodedBytes: number;
  decodedBytes: number;
}

/** A write callback establishes local acceptance, never remote receipt. */
export class RemoteReturnPathDiagnostics {
  private readonly started = performance.now();
  private readonly generation = fingerprint(randomUUID());
  private readonly session: string;
  private order = 0;
  private emittedMessages = 0;
  private emittedBytes = 0;
  private lastError: Record<string, unknown> | undefined;
  private lastClose: Record<string, unknown> | undefined;
  private emittedOrder = 0;
  private summaries = 0;
  private droppedEvents = 0;
  private droppedStreamObservations = 0;
  private events: Record<string, unknown>[] = [];
  private streams = new Map<string, StreamTotals>();

  constructor(
    sessionId: string,
    private readonly expiresAt = Infinity,
  ) {
    this.session = fingerprint(sessionId);
  }

  record(
    stage: Stage,
    outcome: Outcome,
    frame?: Record<string, unknown>,
    encodedBytes = 0,
    decodedBytes = 0,
    error?: unknown,
  ): void {
    if (Date.now() >= this.expiresAt) return;
    const id =
      typeof frame?.streamId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(frame.streamId)
        ? fingerprint(frame.streamId)
        : undefined;
    const type = typeof frame?.type === 'string' && TYPES.has(frame.type) ? frame.type : 'unknown';
    if (id && (stage === 'send' || stage === 'callback')) {
      let totals = this.streams.get(id);
      if (!totals && this.streams.size < RETURN_PATH_LIMITS.streams) {
        totals = {
          enqueuedFrames: 0,
          completedFrames: 0,
          errorFrames: 0,
          encodedBytes: 0,
          decodedBytes: 0,
        };
        this.streams.set(id, totals);
      }
      if (!totals) this.droppedStreamObservations++;
      else if (stage === 'send') {
        totals.firstSend ??= {
          eventOrder: this.order + 1,
          elapsedMs: performance.now() - this.started,
          encodedBytes,
          decodedBytes,
          ...(Number.isSafeInteger(frame?.seq) && (frame?.seq as number) >= 0
            ? { seq: frame?.seq }
            : {}),
        };
        totals.enqueuedFrames++;
        totals.encodedBytes += encodedBytes;
        totals.decodedBytes += decodedBytes;
      } else if (stage === 'callback') {
        totals.firstCallback ??= {
          eventOrder: this.order + 1,
          elapsedMs: performance.now() - this.started,
          outcome,
          encodedBytes,
          decodedBytes,
          ...(Number.isSafeInteger(frame?.seq) && (frame?.seq as number) >= 0
            ? { seq: frame?.seq }
            : {}),
        };
        if (outcome === 'accepted') totals.completedFrames++;
        else totals.errorFrames++;
      }
    }
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (stage === 'emitted_message') {
      this.emittedMessages++;
      this.emittedBytes += encodedBytes;
    }
    if (stage === 'ws_error')
      this.lastError = {
        eventOrder: this.order + 1,
        elapsedMs: performance.now() - this.started,
        errorCode: typeof code === 'string' && ERROR_CODES.has(code) ? code : 'unknown',
      };
    if (stage === 'close')
      this.lastClose = {
        eventOrder: this.order + 1,
        elapsedMs: performance.now() - this.started,
        ...(typeof code === 'number' &&
        [
          1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015,
        ].includes(code)
          ? { code }
          : {}),
      };
    if (this.events.length >= RETURN_PATH_LIMITS.events / 2) {
      this.droppedEvents++;
      this.order++;
      return;
    }
    this.events.push({
      eventOrder: ++this.order,
      elapsedMs: performance.now() - this.started,
      stage,
      outcome,
      direction: stage === 'send' || stage === 'callback' ? 'out' : 'in',
      type,
      encodedBytes,
      decodedBytes,
      ...(id ? { stream: id } : {}),
      ...(Number.isSafeInteger(frame?.seq) && (frame?.seq as number) >= 0
        ? { seq: frame?.seq }
        : {}),
      ...(stage === 'ws_error'
        ? { errorCode: typeof code === 'string' && ERROR_CODES.has(code) ? code : 'unknown' }
        : {}),
    });
    if (this.events.length > RETURN_PATH_LIMITS.events) {
      this.events.shift();
      this.droppedEvents++;
    }
  }

  exportSummary(final = false): Record<string, unknown> | undefined {
    if (Date.now() >= this.expiresAt) return undefined;
    // Reserve one final summary so a busy socket cannot consume its close evidence.
    if (this.summaries >= RETURN_PATH_LIMITS.events / 2 - (final ? 0 : 1)) return undefined;
    this.summaries++;
    const snapshot = this.snapshot();
    snapshot.eventOrder = ++this.order;
    snapshot.outcome = 'observed';
    snapshot.stage = 'summary';
    snapshot.events = this.events
      .filter((entry) => (entry.eventOrder as number) > this.emittedOrder)
      .map((entry) => ({ ...entry }));
    this.emittedOrder = this.order;
    snapshot.summaryOrder = this.summaries;
    return snapshot;
  }

  snapshot(): Record<string, unknown> {
    return {
      event: 'remote.return_path',
      schemaVersion: 1,
      session: this.session,
      generation: this.generation,
      party: 'installation',
      eventOrder: this.order,
      elapsedMs: performance.now() - this.started,
      droppedEvents: this.droppedEvents,
      emittedMessages: this.emittedMessages,
      emittedBytes: this.emittedBytes,
      lastError: this.lastError ? { ...this.lastError } : null,
      lastClose: this.lastClose ? { ...this.lastClose } : null,
      droppedStreamObservations: this.droppedStreamObservations,
      streams: [...this.streams].map(([stream, totals]) => ({ stream, ...totals })),
      events: this.events.map((event) => ({ ...event })),
    };
  }
}

/** Absolute expiry prevents restarting a process from renewing diagnostic consent. */
export function returnPathSelection(
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): { installationId: string; expiresAt: number } | undefined {
  const installationId = env.VERITY_RETURN_PATH_INSTALLATION_ID;
  const expiry = env.VERITY_RETURN_PATH_EXPIRES_AT;
  if (installationId === undefined && expiry === undefined) return undefined;
  const expiresAt =
    typeof expiry === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(expiry)
      ? Date.parse(expiry)
      : NaN;
  if (
    !installationId ||
    installationId.trim() !== installationId ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString().slice(0, 19) !== expiry?.slice(0, 19) ||
    expiresAt - now > RETURN_PATH_LIMITS.durationMs
  )
    throw new Error(
      'return-path diagnostics require an installation ID and an absolute expiry within ten minutes',
    );
  return { installationId, expiresAt };
}

/** The selector is evaluated against authenticated lease identity, never a request field. */
export function selectedReturnPathExpiry(
  selection: { installationId: string; expiresAt: number } | undefined,
  descriptor: { enabled: boolean; installationId?: string } | undefined,
  now = Date.now(),
): number | undefined {
  return selection &&
    descriptor?.enabled &&
    descriptor.installationId === selection.installationId &&
    selection.expiresAt > now
    ? selection.expiresAt
    : undefined;
}
