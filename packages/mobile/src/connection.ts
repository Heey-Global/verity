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

/** A cancellation by the caller, also where `DOMException` is not an `Error`. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

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
  if (isAbortError(error)) return undefined;
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
  // Screens keep it as is or behind a prefix ("Projects: server maintenance").
  if (message.trimEnd().endsWith(SERVER_MAINTENANCE_MESSAGE)) return 'maintenance';
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

const CHECK_TIMED_OUT = 'Connection check timed out';
/** Statuses a check receives from a hop in front of the server, not from it. */
const PROXY_STATUSES: ReadonlySet<number> = new Set([502, 504]);

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
 * request does not flash a warning across the app. Only a check made during an
 * outage ends it: answers to requests begun before an update are no proof.
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
  /** Changes only with {@link reset}: which server the reports are about. */
  private serverEpoch = 0;

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

  /**
   * A reporter for one client. After {@link reset} (another server), requests
   * still in flight from clients of the previous server are ignored.
   */
  reporter(): ConnectionReporter {
    const epoch = this.serverEpoch;
    const current = () => epoch === this.serverEpoch;
    return {
      reportSuccess: () => {
        if (current()) this.reportSuccess();
      },
      reportFailure: (kind, details) => {
        if (current()) this.reportFailure(kind, details);
      },
    };
  }

  /** The request used to check the server; it must report through this monitor. */
  setProbe(probe: (() => Promise<unknown>) | undefined): void {
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
    if (this.state.kind !== 'connected') {
      // Ignored during an outage: while the Gateway drains, requests begun
      // before the update still finish with an answer, which would announce a
      // recovery that has not happened and reload every screen into the next
      // 503. Only a check started during the outage can end it.
      return;
    }
    if (this.checking) {
      // The server just answered: the check confirming a transport failure is
      // out of date, and its late failure must not start an outage.
      this.generation += 1;
      this.checking = false;
    }
    // Not emitted: a successful request changes nothing anyone renders, and
    // every request reports one.
    this.state = { ...this.state, lastConnectedAt: this.timers.now() };
  }

  /** The server answered a check made during the outage: it is back. */
  private recover(): void {
    if (this.state.kind === 'connected') return;
    const now = this.timers.now();
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
    // Already disrupted: keep the schedule, refresh what is shown. A request
    // failing on its way does not turn an update into an outage; the next
    // check says which it is.
    if (this.state.kind === 'maintenance' && kind === 'unreachable') return;
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
    this.serverEpoch += 1;
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
      // A check begun to confirm a transport failure cannot end an update that
      // started while it ran: a draining Gateway still answers it. The next
      // check, made during the update, decides.
      if (confirming && this.state.kind !== 'connected') this.schedule();
      else this.recover();
      return;
    }
    // Only an answer from the server proves it is there; any other rejection,
    // whatever its wording, is the transport failing, as `VerityClient` reports
    // it. The liveness route never answers 502/504 itself (those are its
    // upstream routes' words), so there they come from a relay in front of a
    // server still away.
    const answered =
      failure instanceof Error &&
      failure.name === 'VerityApiError' &&
      !PROXY_STATUSES.has((failure as Error & { status?: number }).status ?? 0);
    const kind = answered ? connectionFailureKind(failure) : 'unreachable';
    if (kind === undefined) {
      // The server answered, just not with what the probe wanted: it is there.
      this.recover();
      return;
    }
    // A check that merely timed out adds nothing: keep the failure that
    // started the outage, which names the routes that failed.
    const timedOut = failure instanceof Error && failure.message === CHECK_TIMED_OUT;
    const message = timedOut ? details : failure instanceof Error ? failure.message : details;
    if (this.state.kind === 'connected') this.enter(kind, message);
    else if (confirming) {
      // The outage began during this check (its own request reported it):
      // this was no retry yet, so the backoff starts at its first step.
      // A check that timed out keeps the failure that started the outage.
      if (kind === this.state.kind) this.state = { ...this.state, details: message };
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
        const error = new Error(CHECK_TIMED_OUT);
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
