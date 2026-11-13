/**
 * The server connection as one state for the whole app.
 *
 * Every request reports its outcome here (see `VerityClient`'s `connection`
 * option), so a server update or a lost route is detected once and shown once,
 * instead of every screen rendering its own copy of the same transport error.
 */

/** Why the server cannot be used right now. */
export type ConnectionFailureKind = 'maintenance' | 'unreachable';

/** The Gateway's answer to every request while the server updates. */
export const SERVER_MAINTENANCE_MESSAGE = 'server maintenance';

// Transport failures as the app's fetch implementations word them: React Native,
// browsers, the pinned TLS transport and the Remote Control (Uplink) route. They
// are matched anywhere in a message because screens prefix what they show
// ("Projects: …", "Stream: …").
const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /Network request failed/u,
  /Network request timed out/u,
  /Failed to fetch/u,
  /\bLoad failed\b/u,
  /NetworkError when attempting to fetch/u,
  /Pinned TLS transport failed/u,
  /NSURLErrorDomain/u,
  /Uplink (?:routing|setup|admission|attachment|probe)/u,
  /[Dd]irect Core requests? failed/u,
  /Remote (?:admission|Core probe|tunnel)/u,
];

function messageOf(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return undefined;
}

/**
 * Whether an error (or the message a screen kept of it) means the server is
 * updating or cannot be reached, as opposed to a real answer from it. A local
 * 404 or a validation error stays `undefined`: those are the screen's to show.
 */
export function connectionFailureKind(error: unknown): ConnectionFailureKind | undefined {
  // A caller that cancelled its own request learned nothing about the server.
  if (error instanceof Error && error.name === 'AbortError') return undefined;
  if (error instanceof Error && error.name === 'TimeoutError') return 'unreachable';
  // An answer from the server is maintenance only as the Gateway words it,
  // exactly as `VerityClient` reports it; any other answer is the server's own.
  if (error instanceof Error && error.name === 'VerityApiError')
    return (error as Error & { status?: number }).status === 503 &&
      error.message === SERVER_MAINTENANCE_MESSAGE
      ? 'maintenance'
      : undefined;
  const message = messageOf(error);
  if (message === undefined) return undefined;
  if (message.includes(SERVER_MAINTENANCE_MESSAGE)) return 'maintenance';
  return UNREACHABLE_PATTERNS.some((pattern) => pattern.test(message)) ? 'unreachable' : undefined;
}

/** What a request tells the monitor; `VerityClient` depends on this alone. */
export interface ConnectionReporter {
  reportSuccess(): void;
  reportFailure(kind: ConnectionFailureKind, details: string): void;
}

export type ServerConnectionState =
  | {
      kind: 'connected';
      /** When the last disruption ended; absent if there was none. */
      recoveredAt: number | undefined;
      lastConnectedAt: number | undefined;
    }
  | {
      kind: ConnectionFailureKind;
      since: number;
      /** When the next automatic check runs; absent while one is running. */
      nextAttemptAt: number | undefined;
      /** The raw failure, for the collapsed technical details only. */
      details: string;
      lastConnectedAt: number | undefined;
    };

/** Delays between automatic checks while the server is away (ms). */
export const CONNECTION_RETRY_DELAYS: readonly number[] = [2_000, 4_000, 8_000, 15_000];

/** How long one automatic check may take before it counts as unreachable (ms). */
export const CONNECTION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Listeners run inside the request that changed the state; one that throws
 * must neither fail that request nor keep the others from running.
 */
function notify(listener: () => void): void {
  try {
    listener();
  } catch (error) {
    console.warn('Connection listener failed', error);
  }
}

interface Timers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Turns request outcomes into one connection state and, while the server is
 * away, checks it again with backoff until it answers.
 *
 * A 503 `server maintenance` is definite and shows at once. A transport failure
 * while connected is first confirmed by an immediate check, so a single dropped
 * request does not flash a warning across the app.
 */
export class ConnectionMonitor implements ConnectionReporter {
  private state: ServerConnectionState = {
    kind: 'connected',
    recoveredAt: undefined,
    lastConnectedAt: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private readonly recoveredListeners = new Set<() => void>();
  private probe: (() => Promise<unknown>) | undefined;
  private readonly timers: Timers;
  private readonly delays: readonly number[];
  private readonly checkTimeoutMs: number;
  private attempt = 0;
  private timer: unknown;
  private checking = false;
  private generation = 0;

  constructor(
    opts: {
      probe?: () => Promise<unknown>;
      timers?: Timers;
      delays?: readonly number[];
      checkTimeoutMs?: number;
    } = {},
  ) {
    this.probe = opts.probe;
    this.timers = opts.timers ?? systemTimers;
    this.delays = opts.delays ?? CONNECTION_RETRY_DELAYS;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? CONNECTION_CHECK_TIMEOUT_MS;
  }

  /** The request used to check the server; it must report through this monitor. */
  setProbe(probe: () => Promise<unknown>): void {
    this.probe = probe;
  }

  getState(): ServerConnectionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires once each time the server answers again after a disruption. */
  onRecovered(listener: () => void): () => void {
    this.recoveredListeners.add(listener);
    return () => this.recoveredListeners.delete(listener);
  }

  reportSuccess(): void {
    const now = this.timers.now();
    if (this.checking) {
      // The server just answered: a check still running is out of date, and
      // its late failure must not put the app back into an outage.
      this.generation += 1;
      this.checking = false;
    }
    if (this.state.kind === 'connected') {
      this.state = { ...this.state, lastConnectedAt: now };
      // Not emitted: a successful request changes nothing anyone renders, and
      // every request reports one.
      return;
    }
    this.stopTimer();
    this.attempt = 0;
    this.state = { kind: 'connected', recoveredAt: now, lastConnectedAt: now };
    this.emit();
    for (const listener of [...this.recoveredListeners]) notify(listener);
  }

  reportFailure(kind: ConnectionFailureKind, details: string): void {
    if (this.state.kind === 'connected') {
      if (kind === 'unreachable' && !this.checking) {
        // Confirm before telling anyone: the check reports its own outcome.
        void this.check(details);
        return;
      }
      if (kind === 'unreachable') return;
      this.enter(kind, details);
      return;
    }
    // Already disrupted: keep the schedule, refresh what is shown.
    if (this.state.kind !== kind || this.state.details !== details) {
      this.state = { ...this.state, kind, details };
      this.emit();
    }
  }

  /** "Try now": check at once instead of waiting for the next attempt. */
  retryNow(): void {
    if (this.state.kind === 'connected' || this.checking) return;
    this.stopTimer();
    void this.check(this.state.details);
  }

  /** Forget everything, e.g. when the app switches to another server. */
  reset(): void {
    this.stopTimer();
    this.generation += 1;
    this.attempt = 0;
    this.checking = false;
    this.state = { kind: 'connected', recoveredAt: undefined, lastConnectedAt: undefined };
    this.emit();
  }

  private enter(kind: ConnectionFailureKind, details: string): void {
    this.state = {
      kind,
      since: this.timers.now(),
      nextAttemptAt: undefined,
      details,
      lastConnectedAt: this.state.lastConnectedAt,
    };
    this.attempt = 0;
    // A check already running schedules the first attempt when it settles;
    // a second timer now would start a second, overlapping check.
    if (this.checking) this.emit();
    else this.schedule();
  }

  private async check(details: string): Promise<void> {
    // One check at a time; the running one decides what happens next.
    if (this.checking) return;
    const probe = this.probe;
    if (probe === undefined) {
      // Nothing to check with yet: keep counting down, so the bar never shows a
      // stale "Retrying in 1 s" and the next attempt still happens.
      if (this.state.kind === 'connected') this.enter('unreachable', details);
      else {
        this.attempt += 1;
        this.schedule();
      }
      return;
    }
    const generation = this.generation;
    const confirming = this.state.kind === 'connected';
    this.checking = true;
    if (this.state.kind !== 'connected' && this.state.nextAttemptAt !== undefined) {
      this.state = { ...this.state, nextAttemptAt: undefined };
      this.emit();
    }
    let failure: unknown;
    let failed = false;
    try {
      await this.withTimeout(probe());
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (generation !== this.generation) return;
    this.checking = false;
    if (!failed) {
      // The probe's own request has already reported success; this covers a
      // probe that does not go through a reporting client.
      if (this.state.kind !== 'connected') this.reportSuccess();
      return;
    }
    const kind = connectionFailureKind(failure);
    if (kind === undefined) {
      // The server answered, just not with what the probe wanted: it is there.
      if (this.state.kind !== 'connected') this.reportSuccess();
      return;
    }
    const message = failure instanceof Error ? failure.message : details;
    if (this.state.kind === 'connected') this.enter(kind, message);
    else if (confirming) {
      // The outage began during this check (its own request reported it):
      // this was no retry yet, so the backoff starts at its first step.
      this.state = { ...this.state, details: message };
      this.schedule();
    } else {
      this.state = { ...this.state, kind, details: message };
      this.attempt += 1;
      this.schedule();
    }
  }

  /** A check on a dead network can hang for a minute; it fails sooner. */
  private withTimeout(check: Promise<unknown>): Promise<unknown> {
    let handle: unknown;
    const timeout = new Promise<never>((_, reject) => {
      handle = this.timers.setTimeout(() => {
        const error = new Error('Connection check timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, this.checkTimeoutMs);
    });
    return Promise.race([check, timeout]).finally(() => this.timers.clearTimeout(handle));
  }

  private schedule(): void {
    if (this.state.kind === 'connected') return;
    this.stopTimer();
    const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)] ?? 15_000;
    this.state = { ...this.state, nextAttemptAt: this.timers.now() + delay };
    this.emit();
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation || this.state.kind === 'connected') return;
      void this.check(this.state.details);
    }, delay);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) notify(listener);
  }
}
