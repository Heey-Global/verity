import {
  LIVE_MAX_SESSION_SUBSCRIPTIONS,
  LIVE_PING_INTERVAL_MS,
  LIVE_PONG_TIMEOUT_MS,
  LIVE_PROTOCOL_VERSION,
  SESSION_PROJECTION_EVENT_TYPES,
  decodeLiveClientFrame,
  type AgentEvent,
  type LiveAlert,
  type LiveEndedReason,
  type LiveHint,
  type LiveHintTopic,
  type LiveServerFrame,
} from '@verity/events';
import type { SequencedEvent } from '@verity/store';

/** Session changes that no event records (a turn starting or stopping, an
 * automatic name), from the conductor to the live hub. The two are built in
 * different places, so they meet here. */
export interface SessionChangeFeed {
  emit(sessionId: string, change: 'activity' | 'name'): void;
  subscribe(listener: (sessionId: string, change: 'activity' | 'name') => void): () => void;
}

export function createSessionChangeFeed(): SessionChangeFeed {
  const listeners = new Set<(sessionId: string, change: 'activity' | 'name') => void>();
  return {
    emit: (sessionId, change) => {
      for (const listener of [...listeners]) listener(sessionId, change);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The slice of a `ws` socket the hub drives. */
export interface LiveSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close' | 'pong', listener: () => void): unknown;
}

export interface LiveIdentity {
  /** The paired device; undefined only while the auth gate is off. */
  deviceId?: string | undefined;
  /** The device's local user; undefined only while the auth gate is off. */
  userId?: string | undefined;
}

export interface LiveSessionRef {
  sessionId: string;
  projectId: string | null;
}

/** Which sessions an overview subscriber may hear about: those of readable
 * projects, plus project-less sessions for an administrator — the same split
 * `GET /sessions/:id` applies. */
export type LiveOverviewScope =
  { all: true } | { all: false; projectIds: ReadonlySet<string>; unassigned: boolean };

export interface LiveHubDeps {
  bus: {
    subscribe(sessionId: string, listener: (event: SequencedEvent) => void): () => void;
    subscribeAll(observer: (sessionId: string, event: SequencedEvent) => void): () => void;
  };
  store: {
    getSession(sessionId: string): Promise<LiveSessionRef | undefined>;
    getEventsAfter(sessionId: string, afterSeq: number, limit: number): Promise<SequencedEvent[]>;
  };
  access: {
    /** The same answer `GET /sessions/:id` gives this user. */
    canReadSession(userId: string | undefined, session: LiveSessionRef): Promise<boolean>;
    overviewScope(userId: string | undefined): Promise<LiveOverviewScope>;
    /** False once the user is disabled or removed; the connection closes. */
    isActiveUser?(userId: string): Promise<boolean>;
  };
  logger?: { warn(obj: object, msg: string): void } | undefined;
  replayPageSize?: number;
  /** Above this many unsent bytes a session subscription is ended `overflow`:
   * the client resubscribes from its cursor, so nothing is lost, and one noisy
   * session cannot hold every other frame on the socket hostage. */
  maxBufferedBytes?: number;
  hintDelayMs?: number;
  recheckMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  now?: () => number;
}

const WS_OPEN = 1;
const DEFAULT_REPLAY_PAGE = 500;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_HINT_DELAY_MS = 250;
const DEFAULT_RECHECK_MS = 60_000;
/** How long a user's overview scope is reused between hint flushes. Short, so a
 * project the user just created (or lost) shows up (or disappears) promptly
 * without a membership-change hook. */
const SCOPE_TTL_MS = 5_000;
/** Live events held while a replay page is still being sent. */
const MAX_LIVE_BACKLOG = 2_000;

const PROJECTION_TYPES: ReadonlySet<string> = new Set(SESSION_PROJECTION_EVENT_TYPES);

/** The overview topics an event touches. Every event counts toward a session's
 * unread count, so each one at least hints `events`. */
export function hintTopicsFor(event: AgentEvent): LiveHintTopic[] {
  if (event.t === 'permission') return ['events', 'status', 'permission'];
  if (PROJECTION_TYPES.has(event.t)) return ['events', 'status'];
  return ['events'];
}

interface SessionSubscription {
  readonly sessionId: string;
  projectId: string | null;
  view: boolean;
  lastSentSeq: number;
  live: boolean;
  readonly backlog: SequencedEvent[];
  cancelled: boolean;
  unsubscribe: () => void;
}

class LiveConnection {
  foreground = false;
  overview = false;
  readonly subscriptions = new Map<string, SessionSubscription>();
  private lastPongAt: number;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private closed = false;

  constructor(
    private readonly hub: LiveHub,
    readonly socket: LiveSocket,
    readonly identity: LiveIdentity,
  ) {
    this.lastPongAt = hub.now();
  }

  get userKey(): string {
    return this.identity.userId ?? '';
  }

  start(): void {
    this.socket.on('message', (data) => {
      void this.onMessage(String(data));
    });
    this.socket.on('pong', () => {
      this.lastPongAt = this.hub.now();
    });
    this.socket.on('close', () => {
      this.dispose();
    });
    const keepalive = setInterval(() => {
      if (this.hub.now() - this.lastPongAt > this.hub.pongTimeoutMs) {
        // A socket that stopped answering is not a foreground device any more.
        this.socket.terminate();
        this.dispose();
        return;
      }
      try {
        this.socket.ping();
      } catch {
        // A socket mid-close throws here; the close handler disposes it.
      }
    }, this.hub.pingIntervalMs);
    keepalive.unref?.();
    const recheck = setInterval(() => {
      void this.recheck();
    }, this.hub.recheckMs);
    recheck.unref?.();
    this.timers.push(keepalive, recheck);
    this.send({
      k: 'ready',
      v: LIVE_PROTOCOL_VERSION,
      maxSessions: LIVE_MAX_SESSION_SUBSCRIPTIONS,
    });
  }

  send(frame: LiveServerFrame): boolean {
    if (this.closed || this.socket.readyState !== WS_OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    for (const sub of this.subscriptions.values()) this.cancel(sub);
    this.subscriptions.clear();
    this.hub.detach(this);
  }

  private async onMessage(raw: string): Promise<void> {
    const decoded = decodeLiveClientFrame(raw);
    if (!decoded.ok) {
      this.send({ k: 'error', message: 'invalid frame' });
      return;
    }
    const frame = decoded.frame;
    switch (frame.k) {
      case 'ping':
        this.lastPongAt = this.hub.now();
        this.send({ k: 'pong', n: frame.n });
        return;
      case 'state':
        this.foreground = frame.foreground;
        return;
      case 'view': {
        const sub = this.subscriptions.get(frame.id);
        if (sub !== undefined) sub.view = frame.view;
        return;
      }
      case 'sub':
        if (frame.ch === 'overview') {
          this.overview = true;
          return;
        }
        await this.subscribe(frame.id, frame.sinceSeq ?? 0, frame.view === true);
        return;
      case 'unsub':
        if (frame.ch === 'overview') {
          this.overview = false;
          return;
        }
        this.unsubscribe(frame.id);
        return;
    }
  }

  private async subscribe(sessionId: string, sinceSeq: number, view: boolean): Promise<void> {
    // A resubscription (after `overflow`, or a cursor reset) starts over cleanly.
    this.unsubscribe(sessionId);
    if (this.subscriptions.size >= LIVE_MAX_SESSION_SUBSCRIPTIONS) {
      this.send({ k: 'ended', id: sessionId, reason: 'limit' });
      return;
    }
    const sub: SessionSubscription = {
      sessionId,
      projectId: null,
      view,
      lastSentSeq: sinceSeq,
      live: false,
      backlog: [],
      cancelled: false,
      unsubscribe: () => undefined,
    };
    // Registered before the first await so a quick `unsub` or `view` finds it.
    this.subscriptions.set(sessionId, sub);
    const ended = (reason: LiveEndedReason): void => {
      if (sub.cancelled || this.subscriptions.get(sessionId) !== sub) return;
      this.subscriptions.delete(sessionId);
      this.cancel(sub);
      this.send({ k: 'ended', id: sessionId, reason });
    };
    try {
      const session = await this.hub.deps.store.getSession(sessionId);
      if (sub.cancelled) return;
      if (session === undefined) return ended('not_found');
      if (!(await this.hub.deps.access.canReadSession(this.identity.userId, session))) {
        return ended('forbidden');
      }
      if (sub.cancelled) return;
      sub.projectId = session.projectId;
      // Subscribe FIRST and hold live events while the backlog is replayed: an
      // event persisted during the read is then either in a page or held here,
      // and the seq high-water mark sends it exactly once.
      sub.unsubscribe = this.hub.deps.bus.subscribe(sessionId, (event) => {
        if (sub.cancelled) return;
        if (sub.live) {
          this.sendEvent(sub, event);
          return;
        }
        sub.backlog.push(event);
        if (sub.backlog.length > MAX_LIVE_BACKLOG) ended('overflow');
      });
      for (;;) {
        const page = await this.hub.deps.store.getEventsAfter(
          sessionId,
          sub.lastSentSeq,
          this.hub.replayPageSize,
        );
        if (sub.cancelled) return;
        for (const event of page) {
          if (!this.sendEvent(sub, event)) return;
        }
        if (page.length < this.hub.replayPageSize) break;
        await this.drain(sub);
        if (sub.cancelled) return;
      }
      this.send({ k: 'caught_up', id: sessionId, seq: sub.lastSentSeq });
      for (const event of sub.backlog) {
        if (!this.sendEvent(sub, event)) return;
      }
      sub.backlog.length = 0;
      sub.live = true;
    } catch (error) {
      this.hub.deps.logger?.warn({ err: error, sessionId }, 'verity: live replay failed');
      if (!sub.cancelled) ended('error');
    }
  }

  /** Send one event if it advances the cursor. False when the subscription
   * ended because the socket could not keep up. */
  private sendEvent(sub: SessionSubscription, event: SequencedEvent): boolean {
    if (sub.cancelled) return false;
    if (event.seq <= sub.lastSentSeq) return true;
    if (this.socket.bufferedAmount > this.hub.maxBufferedBytes) {
      if (this.subscriptions.get(sub.sessionId) === sub) this.subscriptions.delete(sub.sessionId);
      this.cancel(sub);
      this.send({ k: 'ended', id: sub.sessionId, reason: 'overflow' });
      return false;
    }
    this.send({ k: 'event', id: sub.sessionId, seq: event.seq, ts: event.ts, event: event.event });
    sub.lastSentSeq = event.seq;
    return true;
  }

  /** Wait between replay pages until the socket has sent most of what it holds. */
  private async drain(sub: SessionSubscription): Promise<void> {
    const threshold = this.hub.maxBufferedBytes / 4;
    while (!sub.cancelled && !this.closed && this.socket.bufferedAmount > threshold) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subscriptions.get(sessionId);
    if (sub === undefined) return;
    this.subscriptions.delete(sessionId);
    this.cancel(sub);
  }

  private cancel(sub: SessionSubscription): void {
    if (sub.cancelled) return;
    sub.cancelled = true;
    sub.unsubscribe();
    sub.backlog.length = 0;
  }

  /** Re-evaluate what this connection may see. Membership can change while a
   * socket stays open; a read granted at subscribe time is not granted forever. */
  async recheck(scope: { projectId?: string | undefined; sessionId?: string } = {}): Promise<void> {
    if (this.closed) return;
    const { userId } = this.identity;
    const scopedSubscription =
      scope.sessionId === undefined ? undefined : this.subscriptions.get(scope.sessionId);
    try {
      if (userId !== undefined && this.hub.deps.access.isActiveUser !== undefined) {
        if (!(await this.hub.deps.access.isActiveUser(userId))) {
          this.close(1008, 'unauthorized');
          return;
        }
      }
      for (const sub of [...this.subscriptions.values()]) {
        if (scope.projectId !== undefined && sub.projectId !== scope.projectId) continue;
        if (scope.sessionId !== undefined && sub.sessionId !== scope.sessionId) continue;
        const session = await this.hub.deps.store.getSession(sub.sessionId);
        if (sub.cancelled) continue;
        const allowed =
          session !== undefined && (await this.hub.deps.access.canReadSession(userId, session));
        if (sub.cancelled || this.subscriptions.get(sub.sessionId) !== sub) continue;
        if (allowed) {
          sub.projectId = session.projectId;
          continue;
        }
        if (this.subscriptions.get(sub.sessionId) === sub) this.subscriptions.delete(sub.sessionId);
        this.cancel(sub);
        this.send({
          k: 'ended',
          id: sub.sessionId,
          reason: session === undefined ? 'not_found' : 'forbidden',
        });
      }
    } catch (error) {
      if (
        scope.sessionId !== undefined &&
        scopedSubscription !== undefined &&
        this.subscriptions.get(scope.sessionId) === scopedSubscription
      ) {
        this.unsubscribe(scope.sessionId);
        this.send({ k: 'ended', id: scope.sessionId, reason: 'error' });
      }
      this.hub.deps.logger?.warn({ err: error }, 'verity: live access recheck failed');
    }
  }
}

function scopeAllows(scope: LiveOverviewScope, projectId: string | null): boolean {
  if (scope.all) return true;
  return projectId === null ? scope.unassigned : scope.projectIds.has(projectId);
}

/**
 * Every open live connection, and what push routing needs to know about them:
 * which user is looking at which session, and which of a user's devices is in
 * front of them right now.
 */
export class LiveHub {
  readonly replayPageSize: number;
  readonly maxBufferedBytes: number;
  readonly hintDelayMs: number;
  readonly recheckMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly now: () => number;
  private readonly connections = new Set<LiveConnection>();
  private readonly projectOfSession = new Map<string, string | null>();
  private readonly pendingHints = new Map<
    string,
    { topics: Set<LiveHintTopic>; deleted: boolean }
  >();
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly scopes = new Map<string, { scope: LiveOverviewScope; at: number }>();
  private readonly unsubscribeAll: () => void;

  constructor(readonly deps: LiveHubDeps) {
    this.replayPageSize = deps.replayPageSize ?? DEFAULT_REPLAY_PAGE;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.hintDelayMs = deps.hintDelayMs ?? DEFAULT_HINT_DELAY_MS;
    this.recheckMs = deps.recheckMs ?? DEFAULT_RECHECK_MS;
    this.pingIntervalMs = deps.pingIntervalMs ?? LIVE_PING_INTERVAL_MS;
    this.pongTimeoutMs = deps.pongTimeoutMs ?? LIVE_PONG_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.unsubscribeAll = deps.bus.subscribeAll((sessionId, event) => {
      this.notify({ sessionId, topics: hintTopicsFor(event.event) });
    });
  }

  attach(socket: LiveSocket, identity: LiveIdentity): void {
    const connection = new LiveConnection(this, socket, identity);
    this.connections.add(connection);
    connection.start();
  }

  detach(connection: LiveConnection): void {
    this.connections.delete(connection);
  }

  /** A device was revoked, logged out or expired: its sockets stop now. */
  revokeDevice(deviceId: string): void {
    for (const connection of [...this.connections]) {
      if (connection.identity.deviceId === deviceId) connection.close(1008, 'unauthorized');
    }
  }

  /** Membership or user status changed. Re-check the affected connections now
   * instead of waiting for the periodic recheck. */
  authorizationChanged(scope: { userId?: string; projectId?: string } = {}): void {
    if (scope.userId === undefined) this.scopes.clear();
    else this.scopes.delete(scope.userId);
    for (const connection of [...this.connections]) {
      if (scope.userId !== undefined && connection.identity.userId !== scope.userId) continue;
      void connection.recheck({ projectId: scope.projectId });
    }
  }

  /**
   * Something about a session changed. Hints are coalesced per session for
   * {@link hintDelayMs}, so a streaming turn costs a handful of frames rather
   * than one per token, and they carry no content — only which row to refetch.
   */
  /** Reauthorize a moved session before its move fence permits destination turns. */
  async recheckSession(sessionId: string): Promise<void> {
    this.forgetSession(sessionId);
    await Promise.all([...this.connections].map((connection) => connection.recheck({ sessionId })));
  }

  notify(change: {
    sessionId: string;
    projectId?: string | null | undefined;
    topics: readonly LiveHintTopic[];
    deleted?: boolean | undefined;
  }): void {
    if (change.projectId !== undefined)
      this.projectOfSession.set(change.sessionId, change.projectId);
    const pending = this.pendingHints.get(change.sessionId) ?? {
      topics: new Set<LiveHintTopic>(),
      deleted: false,
    };
    for (const topic of change.topics) pending.topics.add(topic);
    if (change.deleted === true) pending.deleted = true;
    this.pendingHints.set(change.sessionId, pending);
    if (this.hintTimer !== undefined) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      void this.flushHints();
    }, this.hintDelayMs);
    this.hintTimer.unref?.();
  }

  private async flushHints(): Promise<void> {
    const pending = [...this.pendingHints];
    this.pendingHints.clear();
    if (![...this.connections].some((connection) => connection.overview)) return;
    const hints: { hint: LiveHint; projectId: string | null }[] = [];
    for (const [sessionId, { topics, deleted }] of pending) {
      let projectId = this.projectOfSession.get(sessionId);
      if (projectId === undefined) {
        const session = await this.deps.store.getSession(sessionId).catch(() => undefined);
        // A session that is already gone can only be announced to whoever may
        // see everything; members learn it from their next list read.
        projectId = session?.projectId ?? null;
        if (session !== undefined) this.projectOfSession.set(sessionId, projectId);
      }
      if (deleted) this.projectOfSession.delete(sessionId);
      hints.push({
        projectId,
        hint: {
          sessionId,
          ...(projectId !== null ? { projectId } : {}),
          topics: [...topics],
          ...(deleted ? { deleted: true } : {}),
        },
      });
    }
    for (const connection of [...this.connections]) {
      if (!connection.overview) continue;
      const scope = await this.scopeFor(connection.identity.userId).catch(() => undefined);
      if (scope === undefined) continue;
      const visible = hints
        .filter(({ projectId }) => scopeAllows(scope, projectId))
        .map(({ hint }) => hint);
      if (visible.length > 0) connection.send({ k: 'hint', hints: visible });
    }
  }

  private async scopeFor(userId: string | undefined): Promise<LiveOverviewScope> {
    const key = userId ?? '';
    const cached = this.scopes.get(key);
    if (cached !== undefined && this.now() - cached.at < SCOPE_TTL_MS) return cached.scope;
    const scope = await this.deps.access.overviewScope(userId);
    this.scopes.set(key, { scope, at: this.now() });
    return scope;
  }

  /** A session moved to another project: forget the cached owner. */
  forgetSession(sessionId: string): void {
    this.projectOfSession.delete(sessionId);
  }

  /** Whether any of the user's connections shows this session on screen. */
  isViewing(userId: string | undefined, sessionId: string): boolean {
    const key = userId ?? '';
    for (const connection of this.connections) {
      if (connection.userKey !== key || !connection.foreground) continue;
      if (connection.subscriptions.get(sessionId)?.view === true) return true;
    }
    return false;
  }

  /** The user's devices that are in front of them right now. */
  foregroundDevices(userId: string | undefined): Set<string> {
    const key = userId ?? '';
    const devices = new Set<string>();
    for (const connection of this.connections) {
      if (connection.userKey !== key || !connection.foreground) continue;
      if (connection.identity.deviceId !== undefined) devices.add(connection.identity.deviceId);
    }
    return devices;
  }

  /** Show an alert on every foreground connection of the user. Returns the
   * devices it reached; an empty set means the caller must push instead. */
  deliverAlert(userId: string | undefined, alert: LiveAlert): Set<string> {
    const key = userId ?? '';
    const reached = new Set<string>();
    for (const connection of this.connections) {
      if (connection.userKey !== key || !connection.foreground) continue;
      if (connection.send({ k: 'alert', alert }) && connection.identity.deviceId !== undefined) {
        reached.add(connection.identity.deviceId);
      }
    }
    return reached;
  }

  close(): void {
    this.unsubscribeAll();
    if (this.hintTimer !== undefined) clearTimeout(this.hintTimer);
    for (const connection of [...this.connections]) connection.close(1001, 'server shutting down');
  }
}
