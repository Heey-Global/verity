import { type AgentEvent, decodeStreamMessage, type StreamEventFrame } from './wire.js';
import { SessionReducer, type SessionState } from './reducer.js';

/**
 * The minimal WebSocket surface the stream uses. The platform `WebSocket`
 * (React Native / browser / Node) satisfies it; tests inject a fake. We only
 * need the message/close/error events and `close()`.
 */
export interface StreamSocket {
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data: unknown }) => void,
  ): void;
  close(): void;
}

export type StreamSocketFactory = (url: string, protocols?: string | string[]) => StreamSocket;

export interface SessionStreamOptions {
  /** Control-plane base URL (http/https) — the scheme is switched to ws/wss. */
  baseUrl: string;
  sessionId: string;
  /** Opens a socket to the given URL (inject the platform `WebSocket` / a fake). */
  connect: StreamSocketFactory;
  /** Called with a fresh state snapshot after each applied event / caught_up. */
  onUpdate?: (state: SessionState) => void;
  /** Called with a server `error` frame or a malformed/undecodable message. */
  onError?: (message: string) => void;
  /** Schedule a reconnect after an unexpected close. `delayMs` follows the
   * built-in capped exponential policy. Injected in tests to drive retries
   * deterministically without timers. */
  scheduleReconnect?: (retry: () => void, delayMs: number) => void;
  /** Reports transport state for connection banners. */
  onConnectionStateChange?: (state: SessionStreamConnectionState) => void;
  /** Initial resume cursor; events with seq > this are streamed. Default 0. */
  sinceSeq?: number;
  /** Mints a short-lived, single-use ticket over authenticated HTTPS before each
   * WebSocket connection. The ticket is carried as a WebSocket subprotocol, never
   * in the URL. Omit only when the server's authentication gate is disabled. */
  getStreamTicket?: () => Promise<string>;
}

export type SessionStreamConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'paused' | 'stopped';

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Drives a single session's live transcript: connects to
 * `WS /sessions/:id/stream?sinceSeq=N` (server `server.ts`), decodes each frame
 * (reusing {@link decodeStreamMessage}), feeds it into a {@link SessionReducer},
 * and tracks the last seq. On an unexpected close it reconnects, **resuming from
 * the last seq** — the server replays only events after the cursor, so the
 * reducer keeps accumulating with no gap or duplication. {@link stop} ends the
 * stream and suppresses further reconnects.
 *
 * Reconnect uses exponential backoff capped at 30 seconds. The attempt counter
 * resets only after `caught_up`, so a server that accepts sockets but cannot
 * serve the backlog cannot create a tight reconnect loop.
 */
export class SessionStream {
  // Reassigned (not readonly) when older history is prepended: the reducer is
  // forward-only, so prepending means rebuilding it over the full event list.
  private reducer = new SessionReducer();
  // Every applied event frame, in seq order — retained so older history can be
  // prepended (scroll-up) and the transcript rebuilt deterministically.
  private eventFrames: StreamEventFrame[] = [];
  private readonly wsBaseUrl: string;
  private socket: StreamSocket | null = null;
  private opening = false;
  private lastSeq: number;
  private rateLimitClearedThroughSeq: number | undefined;
  // tool_use_ids whose permission prompt the server has already settled. Kept so
  // neither a reducer rebuild nor an older history page can resurrect the card.
  private readonly resolvedPermissions = new Set<string>();
  private started = false;
  private stopped = false;
  private paused = false;
  private reconnectGeneration = 0;
  private reconnectAttempt = 0;
  private connectionState: SessionStreamConnectionState | undefined;
  // True once the initial backlog has drained (the `caught_up` watermark). Until
  // then we apply events but suppress `onUpdate`, batching the backlog into one
  // render (see onMessage) so opening a session doesn't scroll wildly.
  private caughtUp = false;

  constructor(private readonly opts: SessionStreamOptions) {
    this.wsBaseUrl = opts.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
    this.lastSeq = opts.sinceSeq ?? 0;
  }

  /** The live transcript state (a fresh snapshot). */
  get state(): SessionState {
    return this.reducer.state;
  }

  clearRateLimit(): void {
    this.rateLimitClearedThroughSeq = this.lastSeq;
    this.eventFrames = this.eventFrames.filter(
      (frame) => !(frame.k === 'event' && frame.event.t === 'rate_limit'),
    );
    this.reducer.clearRateLimit();
    if (this.caughtUp) this.opts.onUpdate?.(this.reducer.state);
  }

  /** Dismiss the live permission card for `toolUseId` once the server has settled
   * the decision (200 `decided: true`, or 404 = nothing pending). The `permission`
   * frame STAYS in the retained list — it carries the pagination cursor and is a
   * streaming boundary the transcript is rebuilt from — so the id is remembered
   * instead and re-applied after every rebuild (see {@link prependHistory}). */
  resolvePermission(toolUseId: string): void {
    this.resolvedPermissions.add(toolUseId);
    this.reducer.resolvePermission(toolUseId);
    if (this.caughtUp) this.opts.onUpdate?.(this.reducer.state);
  }

  /**
   * Set the resume cursor BEFORE {@link start} — the WS then replays only events
   * with seq > `sinceSeq`. Used to open a long session from its tail (skip the
   * whole backlog). No-op once the socket is open (the live cursor is owned by the
   * message loop from then on).
   */
  setSinceSeq(sinceSeq: number): void {
    if (this.socket !== null) return;
    this.lastSeq = sinceSeq;
  }

  /** The seq of the oldest event currently loaded — the cursor for fetching the
   * next older page (`getHistory({ beforeSeq })`). `undefined` before any event. */
  get oldestSeq(): number | undefined {
    return this.eventFrames[0]?.seq;
  }

  /** The newest applied live seq (the resume cursor). Advances only on forward
   * live frames — NOT on {@link prependHistory} scroll-up — so callers can detect
   * "a new event has arrived since time T" without older pages counting. */
  get newestSeq(): number {
    return this.lastSeq;
  }

  /**
   * Prepend an older page of history (from scroll-up). The reducer is forward-only,
   * so this rebuilds it over the combined event list — correct across the page
   * boundary (e.g. a tool_call in the older page paired with its tool_result in the
   * loaded tail). Events not strictly older than the current head are ignored
   * (idempotent against overlap). Emits a fresh snapshot.
   */
  prependHistory(
    events: readonly { seq: number; ts?: number | undefined; event: AgentEvent }[],
  ): void {
    const head = this.eventFrames[0]?.seq ?? Number.POSITIVE_INFINITY;
    const fresh: StreamEventFrame[] = events
      .filter((e) => e.seq < head)
      .filter(
        (e) =>
          !(
            this.rateLimitClearedThroughSeq !== undefined &&
            e.seq <= this.rateLimitClearedThroughSeq &&
            e.event.t === 'rate_limit'
          ),
      )
      .map((e) => ({
        k: 'event',
        seq: e.seq,
        // Carry the real persist time when present (REST history surfaces it like
        // the WS frame, #32); absent → the reducer falls back to `seq`.
        ...(e.ts !== undefined ? { ts: e.ts } : {}),
        event: e.event,
      }));
    if (fresh.length === 0) return;
    this.eventFrames = [...fresh, ...this.eventFrames];
    this.reducer = new SessionReducer();
    for (const frame of this.eventFrames) this.reducer.applyFrame(frame);
    // Replaying the frames re-raises every `permission` in them. Re-settle the ones
    // the server already answered so scroll-up can't resurrect a dismissed card.
    for (const toolUseId of this.resolvedPermissions) this.reducer.resolvePermission(toolUseId);
    this.opts.onUpdate?.(this.reducer.state);
  }

  /** Open the stream. No-op if already started (call-once) or stopped. */
  start(): void {
    this.started = true;
    if (this.stopped || this.paused || this.socket !== null) return;
    this.open();
  }

  /** Close the socket while the app is backgrounded, preserving reducer state
   * and the resume cursor. Unlike stop(), this can be resumed. */
  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.setConnectionState('paused');
    this.reconnectGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** Reconnect from the last received sequence after a background pause. */
  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.reconnectAttempt = 0;
    if (this.started && this.socket === null) this.open();
  }

  /** Close the stream and stop reconnecting. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.setConnectionState('stopped');
    this.paused = false;
    this.reconnectGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private open(): void {
    if (this.stopped || this.paused || this.socket !== null || this.opening) return;
    // Every connection has its own replay watermark. Keeping the previous
    // socket's value would publish replay frames as live updates before the new
    // stream confirms it has caught up.
    this.caughtUp = false;
    this.setConnectionState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const ticketPromise = this.opts.getStreamTicket?.();
    if (ticketPromise !== undefined) {
      this.opening = true;
      const generation = this.reconnectGeneration;
      void ticketPromise
        .then((ticket) => {
          this.opening = false;
          if (this.stopped || this.paused || generation !== this.reconnectGeneration) return;
          this.openSocket(`verity-stream-ticket.${ticket}`);
        })
        .catch(() => {
          this.opening = false;
          if (this.stopped || generation !== this.reconnectGeneration) return;
          this.opts.onError?.('stream authorization failed');
          this.reconnectAttempt += 1;
          this.setConnectionState('reconnecting');
          const delayMs = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
            RECONNECT_MAX_DELAY_MS,
          );
          const retry = (): void => {
            if (!this.stopped && !this.paused && generation === this.reconnectGeneration) {
              this.open();
            }
          };
          if (this.opts.scheduleReconnect) this.opts.scheduleReconnect(retry, delayMs);
          else setTimeout(retry, delayMs);
        });
      return;
    }
    this.openSocket();
  }

  private openSocket(protocol?: string): void {
    if (this.stopped || this.paused || this.socket !== null) return;
    const id = encodeURIComponent(this.opts.sessionId);
    const url = `${this.wsBaseUrl}/sessions/${id}/stream?sinceSeq=${String(this.lastSeq)}`;
    const socket = this.opts.connect(url, protocol);
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.onMessage(typeof event.data === 'string' ? event.data : String(event.data));
    });
    socket.addEventListener('close', () => {
      this.onClose(socket);
    });
    socket.addEventListener('error', () => {
      if (this.stopped || this.socket !== socket) return;
      // The close handler drives reconnection; surface the error for the UI.
      this.opts.onError?.('stream connection error');
    });
  }

  private onMessage(raw: string): void {
    if (this.stopped) return; // ignore late frames buffered on an abandoned socket
    const decoded = decodeStreamMessage(raw);
    if (!decoded.ok) {
      this.opts.onError?.(`undecodable stream message: ${decoded.error}`);
      return;
    }
    const frame = decoded.frame;
    if (frame.k === 'error') {
      this.opts.onError?.(frame.message);
      return;
    }
    if (frame.k === 'event') {
      // Replays can overlap after a reconnect. Never apply an already-seen frame
      // or let an out-of-order frame move the resume cursor backwards.
      if (frame.seq <= this.lastSeq) return;
      this.reducer.applyFrame(frame);
      this.eventFrames.push(frame);
      this.lastSeq = frame.seq;
    }
    if (frame.k === 'caught_up') {
      this.caughtUp = true;
      this.reconnectAttempt = 0;
      this.setConnectionState('connected');
    }
    // Batch the initial backlog: apply its events silently and emit ONCE at
    // `caught_up`, so the screen renders the whole history in a single pass and the
    // list anchors to the bottom without re-anchoring per backlog event (that
    // per-event re-render was the "wild scroll on open"). After caught_up, emit per
    // event for live streaming.
    if (this.caughtUp) this.opts.onUpdate?.(this.reducer.state);
  }

  private onClose(socket: StreamSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.stopped || this.paused) return;
    this.reconnectAttempt += 1;
    this.setConnectionState('reconnecting');
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    const generation = this.reconnectGeneration;
    const retry = (): void => {
      if (
        !this.stopped &&
        !this.paused &&
        this.socket === null &&
        generation === this.reconnectGeneration
      ) {
        this.open();
      }
    };
    if (this.opts.scheduleReconnect) this.opts.scheduleReconnect(retry, delayMs);
    else setTimeout(retry, delayMs);
  }

  private setConnectionState(state: SessionStreamConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.opts.onConnectionStateChange?.(state);
  }
}
