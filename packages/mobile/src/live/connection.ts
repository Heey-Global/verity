import {
  LIVE_TICKET_PROTOCOL_PREFIX,
  decodeLiveServerFrame,
  type AgentEvent,
  type LiveAlert,
  type LiveClientFrame,
  type LiveEndedReason,
  type LiveHint,
  type LiveResource,
} from '@verity/events';
import { VerityApiError } from '../api.js';

/** The WebSocket surface the live connection uses. The platform `WebSocket`
 * (React Native, browser, Node) satisfies it; tests inject a fake. */
export interface LiveSocket {
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LiveSocketFactory = (url: string, protocols?: string | string[]) => LiveSocket;

export type LiveConnectionState =
  /** Opening, or waiting to retry after a drop. */
  | 'connecting'
  | 'connected'
  /** Closed while the app is in the background. */
  | 'paused'
  /** The server rejected this device twice in a row; a new sign-in is needed. */
  | 'unauthorized'
  | 'stopped';

/** Where a session subscription's frames go. The handle survives reconnects:
 * after every reconnect the connection resubscribes from {@link cursor}. */
export interface LiveSessionSink {
  /** The newest seq the subscriber holds; replay resumes after it. */
  cursor(): number;
  event(frame: { seq: number; ts?: number | undefined; event: AgentEvent }): void;
  caughtUp(seq: number): void;
  /** The server ended the subscription for good (no access, gone, refused). */
  ended(reason: LiveEndedReason): void;
  /** The connection dropped; a resubscription follows once it is back.
   * `message` says why, when that is worth showing (it is never server text). */
  disconnected(message?: string): void;
}

export interface LiveSessionHandle {
  /** Whether the session is on screen. A viewed session raises no notification
   * for this user — they are looking at it. */
  setView(view: boolean): void;
  close(): void;
}

/** What a session stream needs from the connection; tests fake it. */
export interface LiveSessionTransport {
  subscribeSession(sessionId: string, sink: LiveSessionSink, view: boolean): LiveSessionHandle;
}

export interface LiveConnectionOptions {
  /** Control-plane base URL (http/https); the scheme becomes ws/wss. */
  baseUrl: string;
  connect: LiveSocketFactory;
  /** Mints the one-use ticket for each connection attempt. Omit only when the
   * server's authentication gate is off. */
  getTicket?: () => Promise<string>;
  /** Injected in tests to drive retries deterministically. */
  scheduleReconnect?: (retry: () => void, delayMs: number) => void;
  /** Client keepalive. A socket that silently died — a network switch the OS
   * did not report — would otherwise look open forever. */
  pingIntervalMs?: number;
  /** Treat the socket as dead after this long without any frame. */
  silenceTimeoutMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
}

// Ticket issuance is an HTTP request; a transport failure is not evidence of
// invalid credentials. Never forward an arbitrary server body or native message.
export function liveConnectionFailure(error: unknown): string {
  if (
    error instanceof VerityApiError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    if (error.status === 401 || error.status === 403) {
      return `Could not open the session: Core rejected this device's authorization (HTTP ${error.status}). Sign in again and retry.`;
    }
    return `Could not open the session: Core could not issue a connection ticket (HTTP ${error.status}). Retry in a moment.`;
  }
  if (error instanceof Error && error.name === 'VerityConnectionError') {
    const stage = error.message.match(
      /^Uplink (routing|setup|admission|attachment|probe)(?: | and)/u,
    )?.[1];
    const admissionCode = error.message.match(
      /^Uplink admission \(Remote admission failed: (unavailable|rate_limited|limit_reached|protocol_unsupported|timeout|cancelled|internal)\.\)/u,
    )?.[1];
    const missingDescriptor = error.message.startsWith(
      'Uplink routing (no remote descriptor saved)',
    );
    const missingAuth = error.message.startsWith('Uplink routing (missing device authentication)');
    const directAlsoFailed = / and direct Core requests? failed:/u.test(error.message);
    if (missingAuth) {
      return 'Could not open the session: this device is not signed in. Connect to Core and sign in again.';
    }
    if (missingDescriptor) {
      return 'Could not open the session: Remote Control is not configured on this device and the direct Core connection failed. Connect to Core through VPN once, then retry without VPN. (Uplink routing)';
    }
    if (error.message.startsWith('Uplink ')) {
      const diagnosis = `Uplink ${stage ?? 'connection'} failed${admissionCode ? ` (${admissionCode})` : ''}`;
      return `Could not open the session: ${diagnosis}${directAlsoFailed ? ', and Core was unreachable directly' : ''}. Check your connection and retry.`;
    }
    if (error.message.startsWith('Direct Core request failed:')) {
      return 'Could not open the session: Core is unreachable at the paired address. Connect through VPN or enable Remote Control, then retry. (Direct Core)';
    }
    return 'Could not open the session: the connection failed. Check your connection and retry.';
  }
  return 'Could not open the session: the connection failed before Core could authorize the connection. Retry in a moment.';
}

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const SUBSCRIPTION_RETRY_MS = 5_000;
const DEFAULT_PING_INTERVAL_MS = 25_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 60_000;
const POLICY_VIOLATION = 1008;

interface SessionEntry {
  readonly sessionId: string;
  readonly sink: LiveSessionSink;
  view: boolean;
  closed: boolean;
}

/**
 * The app's single live connection to one server (`WS /live`). It multiplexes
 * every session the app shows, delivers overview hints and in-app alerts, and —
 * by being open and in the foreground — tells the server which device the user
 * is on, so notifications go there instead of to all their devices.
 *
 * Reconnects with capped exponential backoff and resubscribes every channel from
 * its cursor, so a drop costs no events. A `1008` close means the server no
 * longer accepts this device: one retry with a fresh ticket (it may simply have
 * expired), then {@link LiveConnectionState} `unauthorized`.
 */
export class LiveConnection implements LiveSessionTransport {
  private readonly wsUrl: string;
  private socket: LiveSocket | null = null;
  private ready = false;
  private state: LiveConnectionState = 'stopped';
  private started = false;
  private paused = false;
  private stopped = false;
  private foreground = false;
  private generation = 0;
  private attempt = 0;
  private unauthorizedCloses = 0;
  private lastFrameAt = 0;
  private pings = 0;
  private keepalive: unknown;
  private readonly sessions = new Map<string, SessionEntry[]>();
  private readonly overviewListeners = new Set<(hints: LiveHint[]) => void>();
  private readonly alertListeners = new Set<(alert: LiveAlert) => void>();
  private readonly stateListeners = new Set<(state: LiveConnectionState) => void>();
  private readonly now: () => number;

  constructor(private readonly opts: LiveConnectionOptions) {
    this.wsUrl = `${opts.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/live`;
    this.now = opts.now ?? Date.now;
  }

  get connectionState(): LiveConnectionState {
    return this.state;
  }

  /** Open the connection. Idempotent. */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.open();
  }

  /** Close while the app is in the background: the server then counts this
   * device as gone at once, and notifications reach the user's other devices. */
  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.teardown();
    this.setState('paused');
    for (const entry of this.allSessions()) entry.sink.disconnected();
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.attempt = 0;
    if (this.started) this.open();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
    this.setState('stopped');
  }

  /** Whether the user is looking at the app (an active app, a visible and
   * focused browser tab). */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    this.sendFrame({ k: 'state', foreground });
  }

  onStateChange(listener: (state: LiveConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Overview hints: which sessions changed. The first listener subscribes the
   * connection to the overview channel; the last one to leave unsubscribes it. */
  onHints(listener: (hints: LiveHint[]) => void): () => void {
    this.overviewListeners.add(listener);
    if (this.overviewListeners.size === 1) this.sendFrame({ k: 'sub', ch: 'overview' });
    return () => {
      if (!this.overviewListeners.delete(listener)) return;
      if (this.overviewListeners.size === 0) this.sendFrame({ k: 'unsub', ch: 'overview' });
    };
  }

  private readonly resources = new Map<
    string,
    { resource: LiveResource; listeners: Set<() => void> }
  >();

  resourceWatching = false;

  watchResource(resource: LiveResource, listener: () => void): () => void {
    const key = JSON.stringify(resource);
    let entry = this.resources.get(key);
    if (entry === undefined) {
      entry = { resource, listeners: new Set() };
      this.resources.set(key, entry);
      if (this.resourceWatching) this.sendFrame({ k: 'watch', resource });
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.resources.delete(key);
        if (this.resourceWatching) this.sendFrame({ k: 'unwatch', resource });
      }
    };
  }

  onAlert(listener: (alert: LiveAlert) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  subscribeSession(sessionId: string, sink: LiveSessionSink, view: boolean): LiveSessionHandle {
    const entry: SessionEntry = { sessionId, sink, view, closed: false };
    const entries = this.sessions.get(sessionId) ?? [];
    entries.push(entry);
    this.sessions.set(sessionId, entries);
    // Two screens on one session share the server subscription; the oldest
    // required cursor drives replay. One subscription per session keeps the server's count
    // honest and its replay single.
    this.sendSubscription(sessionId);
    return {
      setView: (next) => {
        if (entry.closed || entry.view === next) return;
        entry.view = next;
        this.sendFrame({ k: 'view', id: sessionId, view: this.viewOf(sessionId) });
      },
      close: () => {
        if (entry.closed) return;
        entry.closed = true;
        const remaining = (this.sessions.get(sessionId) ?? []).filter((other) => other !== entry);
        if (remaining.length === 0) {
          this.sessions.delete(sessionId);
          this.sendFrame({ k: 'unsub', ch: 'session', id: sessionId });
        } else {
          this.sessions.set(sessionId, remaining);
          this.sendFrame({ k: 'view', id: sessionId, view: this.viewOf(sessionId) });
        }
      },
    };
  }

  private viewOf(sessionId: string): boolean {
    return (this.sessions.get(sessionId) ?? []).some((entry) => entry.view);
  }

  private allSessions(): SessionEntry[] {
    return [...this.sessions.values()].flat();
  }

  private sendSubscription(sessionId: string): void {
    const entries = this.sessions.get(sessionId);
    if (entries === undefined || entries.length === 0) return;
    const sinceSeq = Math.min(...entries.map((entry) => entry.sink.cursor()));
    this.sendFrame({
      k: 'sub',
      ch: 'session',
      id: sessionId,
      ...(sinceSeq > 0 ? { sinceSeq } : {}),
      view: this.viewOf(sessionId),
    });
  }

  private sendFrame(frame: LiveClientFrame): void {
    if (!this.ready || this.socket === null) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // A socket mid-close throws; its close event drives the reconnect.
    }
  }

  private open(): void {
    if (this.stopped || this.paused || this.socket !== null) return;
    this.setState('connecting');
    const generation = ++this.generation;
    const failed = (error: unknown): void => {
      if (generation !== this.generation) return;
      const message = liveConnectionFailure(error);
      for (const entry of this.allSessions()) entry.sink.disconnected(message);
      this.scheduleReconnect();
    };
    try {
      const ticket = this.opts.getTicket?.();
      if (ticket === undefined) {
        this.openSocket(generation);
        return;
      }
      void ticket
        .then((value) => {
          if (generation === this.generation) this.openSocket(generation, value);
        })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  private openSocket(generation: number, ticket?: string): void {
    if (this.stopped || this.paused || generation !== this.generation) return;
    const socket = this.opts.connect(
      this.wsUrl,
      ticket === undefined ? undefined : `${LIVE_TICKET_PROTOCOL_PREFIX}${ticket}`,
    );
    this.socket = socket;
    this.ready = false;
    this.lastFrameAt = this.now();
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.now();
      this.onMessage(typeof event.data === 'string' ? event.data : String(event.data));
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.onClose(event.code);
    });
    socket.addEventListener('error', () => undefined);
    this.startKeepalive(socket);
  }

  private onMessage(raw: string): void {
    const decoded = decodeLiveServerFrame(raw);
    if (!decoded.ok) return;
    const frame = decoded.frame;
    switch (frame.k) {
      case 'ready':
        this.resourceWatching = frame.resources === true;
        this.ready = true;
        this.attempt = 0;
        this.unauthorizedCloses = 0;
        this.setState('connected');
        this.sendFrame({ k: 'state', foreground: this.foreground });
        if (this.overviewListeners.size > 0) this.sendFrame({ k: 'sub', ch: 'overview' });
        if (this.resourceWatching)
          for (const entry of this.resources.values())
            this.sendFrame({ k: 'watch', resource: entry.resource });
        for (const sessionId of this.sessions.keys()) this.sendSubscription(sessionId);
        return;
      case 'invalidate':
        for (const entry of this.resources.values()) {
          if (entry.resource.path === frame.path)
            for (const listener of [...entry.listeners]) listener();
        }
        return;
      case 'event':
        for (const entry of this.sessions.get(frame.id) ?? []) {
          entry.sink.event({ seq: frame.seq, ts: frame.ts, event: frame.event });
        }
        return;
      case 'caught_up':
        for (const entry of this.sessions.get(frame.id) ?? []) entry.sink.caughtUp(frame.seq);
        return;
      case 'ended':
        this.onEnded(frame.id, frame.reason);
        return;
      case 'hint':
        for (const listener of [...this.overviewListeners]) listener(frame.hints);
        return;
      case 'alert':
        for (const listener of [...this.alertListeners]) listener(frame.alert);
        return;
      case 'error':
        if (frame.message.startsWith('resource ')) {
          if (this.resourceWatching) {
            for (const { resource } of this.resources.values())
              this.sendFrame({ k: 'unwatch', resource });
          }
          this.resourceWatching = false;
          for (const listener of [...this.stateListeners]) listener(this.state);
        }
        return;
      case 'pong':
        return;
    }
  }

  private onEnded(sessionId: string, reason: LiveEndedReason): void {
    if (!this.sessions.has(sessionId)) return;
    if (reason === 'overflow') {
      // Reset replay batching before resuming from the cursor.
      for (const entry of this.sessions.get(sessionId) ?? []) entry.sink.disconnected();
      this.sendSubscription(sessionId);
      return;
    }
    if (reason === 'error') {
      // A failed backlog read is transient: tell the screen, retry shortly.
      for (const entry of this.sessions.get(sessionId) ?? []) entry.sink.disconnected();
      const generation = this.generation;
      this.schedule(() => {
        if (generation === this.generation && this.sessions.has(sessionId)) {
          this.sendSubscription(sessionId);
        }
      }, SUBSCRIPTION_RETRY_MS);
      return;
    }
    const entries = this.sessions.get(sessionId) ?? [];
    this.sessions.delete(sessionId);
    for (const entry of entries) {
      entry.closed = true;
      entry.sink.ended(reason);
    }
  }

  private onClose(code: number | undefined): void {
    this.teardown();
    if (this.stopped || this.paused) return;
    for (const entry of this.allSessions()) entry.sink.disconnected();
    if (code === POLICY_VIOLATION) {
      this.unauthorizedCloses += 1;
      // One retry with a fresh ticket covers an expired or raced ticket; a
      // second refusal means the device itself is no longer accepted.
      if (this.unauthorizedCloses >= 2) {
        this.setState('unauthorized');
        return;
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.paused) return;
    this.setState('connecting');
    this.attempt += 1;
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    const generation = this.generation;
    this.schedule(() => {
      if (generation === this.generation && this.socket === null) this.open();
    }, delayMs);
  }

  /** Reconnect now — for example when the app learns it is online again. */
  reconnect(): void {
    if (this.stopped || this.paused) return;
    for (const entry of this.allSessions()) entry.sink.disconnected();
    this.teardown();
    this.attempt = 0;
    this.open();
  }

  private schedule(callback: () => void, delayMs: number): void {
    if (this.opts.scheduleReconnect) this.opts.scheduleReconnect(callback, delayMs);
    else setTimeout(callback, delayMs);
  }

  private startKeepalive(socket: LiveSocket): void {
    const every = this.opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const silence = this.opts.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    const set = this.opts.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.keepalive = set(() => {
      if (this.socket !== socket) return;
      if (this.now() - this.lastFrameAt > silence) {
        socket.close();
        this.onClose(undefined);
        return;
      }
      this.sendFrame({ k: 'ping', n: (this.pings += 1) });
    }, every);
  }

  private teardown(): void {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (this.keepalive !== undefined) {
      const clear =
        this.opts.clearInterval ??
        ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(this.keepalive);
      this.keepalive = undefined;
    }
    try {
      socket?.close();
    } catch {
      // Already closing.
    }
  }

  private setState(state: LiveConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }
}
