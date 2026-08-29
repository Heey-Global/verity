import type { AgentEvent, Attachment } from '@verity/events';
import {
  VerityApiError,
  type AttachmentUpload,
  type VerityClient,
  type PermissionDecision,
  type QueuedItem,
  type SessionDetail,
  type SessionHistoryPage,
  type TurnRequest,
} from '../api.js';
import type { SessionState } from '../reducer.js';
import { SessionReducer } from '../reducer.js';
import {
  SessionStream,
  type SessionStreamConnectionState,
  type StreamSocketFactory,
} from '../stream.js';
import { engineLabel } from '../ui/modelPicker.js';

/** How many of the most recent events to open a session from (the tail). One turn
 * is several events (prompt + text + tool calls/results), so this is ~15–20 recent
 * turns — enough context on open while skipping the bulk of a long backlog. Older
 * turns load on scroll-up. Stays within the server's 200 page cap. */
const HISTORY_PAGE = 150;
const TAIL_OPEN_MAX_PAGES = 5;
const HISTORY_VISIBLE_SCAN_MAX_PAGES = 5;

/**
 * An operator message shown IMMEDIATELY on send, before the server has echoed it
 * back as a canonical `prompt` event (issue: a message "disappears" while a slow
 * server processes it). The screen renders these as ordinary operator bubbles at
 * the tail of the transcript, marked with their {@link status}:
 *  - `sending` — the POST is in flight, or it was accepted and we're waiting for
 *    the `prompt` event to land. Retired the moment the real message shows up in
 *    the transcript (or the server lists it as queued, which has its own bubble).
 *  - `failed` — the POST failed; the bubble stays so the text isn't lost, and the
 *    screen offers it back for editing via {@link SessionModel.dismissPending}.
 */
export interface PendingMessage {
  /** Stable client-minted id — the React key and the dismiss handle. */
  id: string;
  text: string;
  /** Images/files attached to this turn, so the echo shows what was sent. */
  attachments?: Attachment[];
  status: 'sending' | 'failed';
  /** Local send time (epoch ms) — the bubble's timestamp until the real one lands. */
  createdAt: number;
}

/** {@link PendingMessage} plus the bookkeeping needed to retire it. */
interface PendingEntry extends PendingMessage {
  /** Newest live seq at dispatch. Only a user message NEWER than this can retire
   * the echo — otherwise an identical prompt sent earlier in the session would
   * retire the fresh echo instantly (the exact bug the echo is fixing). */
  sinceSeq: number;
}

/** The render state the chat screen consumes. */
export interface SessionModelState {
  /** Live transcript + status + usage (from the stream's reducer). */
  session: SessionState;
  /** Last stream error (server `error` frame / connection); cleared on the next event. */
  streamError: string | undefined;
  /** Current live transport state, used for reconnecting/offline banners. */
  connectionState: SessionStreamConnectionState;
  /** A `sendTurn` POST is in flight. */
  sending: boolean;
  /** Last `sendTurn` failure, sanitized (e.g. 409 busy / 404); cleared on the next send. */
  sendError: string | undefined;
  /** Whether a steering turn can still be sent. `undefined` until the session
   * detail loads; `false` once its worktree is gone (the screen then disables the
   * input + shows a banner instead of letting the operator hit a 410). Also set
   * `false` reactively if a send itself 410s (the detail was stale). */
  resumable: boolean | undefined;
  /** Operator-assigned display name (from the session detail), or `null` if none.
   * `undefined` until the detail loads. The screen titles the header with it. */
  name: string | null | undefined;
  /** The session's CURRENT engine/model id, from the session detail and updated on a
   * successful {@link SessionModel.switchModel}. `undefined` until the detail loads.
   * The reducer's `session.model` reflects the SPAWN model (the stream's `session`
   * event); this reflects the PERSISTED choice, so a mid-session engine switch
   * survives a remount/replay. The header derives its engine chip from this. */
  model: string | undefined;
  /** The project the session belongs to, or `null` for a project-less session;
   * `undefined` until the detail loads. The engine picker hides non-Claude/Codex
   * models for project sessions (the server enforces the same constraint). */
  projectId: string | null | undefined;
  /** Whether this is an ordinary session or the durable home of an Agent Loop. */
  kind: 'normal' | 'agent_loop' | undefined;
  /** A {@link SessionModel.switchModel} POST is in flight (the picker disables while
   * the switch resolves). */
  switchingModel: boolean;
  /** An engine switch is outstanding — either running right now (current servers,
   * where the switch interrupts the live turn) or parked on the current turn's
   * settle boundary (older ones). Cleared automatically by the first subsequent
   * idle activity response; there is intentionally no manual dismiss action. */
  modelSwitchPending: boolean;
  /** The session is RESERVED, not working: a stop whose agent process could not be
   * confirmed gone keeps the worktree fenced until termination is established, so
   * {@link SessionModelState.busy} is true with nothing running. The server retries
   * by itself, so this clears without the operator doing anything — but until it
   * does, the state is indistinguishable from an endless turn unless it is said out
   * loud. `false` against an older server, which does not report it. */
  terminationUnconfirmed: boolean;
  /** Last engine-switch failure, sanitized (e.g. a 400 for a non-Claude/Codex model
   * on a project session); cleared on the next switch attempt. */
  switchModelError: string | undefined;
  /** `false` until the initial backlog has drained (the stream's `caught_up`
   * watermark), `true` from the first state snapshot on. The screen gates its
   * "No messages yet" empty-state on this so it doesn't flash while the backlog
   * is still loading — an empty transcript is only truly empty once loaded. */
  loaded: boolean;
  /** True when this model was opened from a client-minted session id before the
   * server finished creating it. The chat can render its usable empty state
   * immediately instead of presenting creation as a blocking history load. */
  locallyCreated: boolean;
  /** True when the LAST send was queued behind an in-flight turn (#90) — the
   * screen shows a "queued, runs when free" hint while the session is still busy.
   * Reset on the next send. */
  queued: boolean;
  /** Texts of messages sent while busy that are STILL waiting (their turn hasn't
   * run yet — no matching `prompt` event in the transcript). The screen shows
   * these as pending bubbles so a queued message is visible, not lost (#90). */
  queuedMessages: string[];
  /** Local echo of the operator's just-sent messages: shown in the transcript from
   * the instant Send is tapped until the server's `prompt` event lands (or the send
   * fails). Without this a message vanishes between tapping Send and the server
   * getting round to it, which reads as "lost" on a slow server. */
  pendingMessages: PendingMessage[];
  /** Server-authoritative: a turn is in flight for this session (the agent is
   * working). Polled from `/sessions/:id/activity`, so the "working" indicator is
   * reliable and survives the app navigating away + back. */
  busy: boolean;
  /** The reconciled "agent is working" signal for the Stop button + activity line:
   * server-authoritative `busy` OR the reducer's eager `session.running` while it is
   * running AHEAD of the poll (a live event has arrived since the server last said
   * settled). Prefer this over `busy || session.running` on the screen — it can't
   * stick ON after the turn truly ended, so it agrees with the overview's server
   * `status` dot. */
  working: boolean;
  /** Server-authoritative turns queued behind the in-flight one (#90), shown as
   * persistent "waiting to send" bubbles (not lost on navigation), MINUS any already
   * delivered (matching a `user-text` in the transcript) — so a sent message never
   * shows as both a solid bubble and a stale "waiting" bubble. Each carries a stable
   * `id` so the operator can tap it to retract the turn back into the input (#80). */
  waitingMessages: QueuedItem[];
  /** The worktree's current branch, polled live from `/sessions/:id/activity` (#110)
   * so the header label tracks an external/agent `git checkout` without a remount.
   * `undefined` until the first poll resolves, or when the server doesn't report it
   * (branch switching unconfigured / older server) — the header then falls back to
   * the load-once branch from `useBranches`. */
  branch: string | undefined;
  /** True when older history exists before the loaded tail — the screen shows a
   * "load earlier" affordance / triggers {@link SessionModel.loadOlder} on scroll. */
  hasOlder: boolean;
  /** A `loadOlder` fetch is in flight (show a top spinner, guard re-triggers). */
  loadingOlder: boolean;
  /** The last older-history request failed or could not advance its cursor. Automatic
   * continuation pauses until a fresh user scroll retries it. */
  olderLoadStalled: boolean;
  /** The last bounded scan advanced but produced no visible transcript rows. */
  olderLoadNeedsContinuation: boolean;
  /** Monotonic completion generation for older-history requests. */
  olderLoadGeneration: number;
  /** Last `cancel` (#79) failure, sanitized; cleared on the next cancel/send.
   * `cancelled: false` from the server is a no-op, NOT an error (left undefined). */
  cancelError: string | undefined;
  /** The `toolUseId` of a permission decision POST currently in flight (#149), or
   * `undefined` when none. The screen disables the approve/deny buttons + shows a
   * spinner while a decision is being sent, so a double-tap can't double-POST. */
  decidingPermission: string | undefined;
  /** Last permission-decision (#149) failure, sanitized; cleared on the next
   * decision attempt. A 404 (the prompt already went stale) is NOT surfaced as an
   * error — it just means the prompt is gone, which the stream already reflects. */
  permissionError: string | undefined;
}

/** A queued turn returned to the composer after retracting it or stopping the session. */
export interface RestoredQueuedTurn {
  prompt: string;
  attachments?: AttachmentUpload[];
}

export interface SessionModelOptions {
  client: VerityClient;
  sessionId: string;
  /** Control-plane base URL (http/https); the stream switches it to ws/wss. */
  baseUrl: string;
  /** Opens the WS socket (inject the platform `WebSocket` / a fake). */
  connect: StreamSocketFactory;
  /** Supplies the per-device bearer token for the WS upgrade (audit C1),
   *  forwarded to {@link SessionStream}. Omit when unauthenticated. */
  getToken?: () => string | null | undefined;
  /** Notified with a fresh state snapshot on every change. */
  onChange?: (state: SessionModelState) => void;
  /** Lets sibling overview state retire the same permission id immediately.
   * `accepted` is false when the server reports that the prompt was already stale. */
  onPermissionSettled?: (toolUseId: string, accepted: boolean) => void;
  /** Notifies sibling overview state only when an active turn was actually stopped. */
  onTurnCancelled?: () => void;
  /** Reconnect scheduler passed through to {@link SessionStream}. */
  scheduleReconnect?: (retry: () => void, delayMs: number) => void;
  /**
   * Gates every server call on the session actually existing, for a screen that
   * renders the chat BEFORE `POST /sessions` has answered: the operator taps "+",
   * the app mints the session id locally and opens the chat on the spot, and the
   * worktree is provisioned in the background (~1.5s of `git fetch` + `worktree
   * add`). Until that resolves the id is unknown to the server, so an ungated
   * model would open a 404ing socket, poll a 404ing activity endpoint, and POST
   * the first turn into nothing.
   *
   * Resolves → the stream, the detail probe, and the activity poll come up
   * exactly as for an already-created session, and a turn the operator typed in
   * the meantime is dispatched right after (its local echo was on screen the
   * whole time, so the wait is invisible). Rejects → the creation failed: the
   * reason surfaces as {@link SessionModelState.streamError} and every send fails
   * with it rather than hanging on a session that will never exist.
   *
   * Omit for an ordinary session — the gated paths then run synchronously, so an
   * existing session opens without losing a frame to a microtask hop.
   */
  ready?: Promise<unknown>;
}

/**
 * Headless controller for the chat screen: drives the {@link SessionStream}
 * lifecycle (live transcript via the reducer) and sends operator turns through
 * {@link VerityClient.sendTurn}. Exposes plain {@link SessionModelState} + actions
 * so the RN screen is a thin renderer (feed `state.session.messages` to the
 * transcript, call {@link sendTurn}). All orchestration is unit-tested here.
 */
export class SessionModel {
  private readonly stream: SessionStream;
  private _session: SessionState;
  private _streamError: string | undefined;
  private _connectionState: SessionStreamConnectionState = 'connecting';
  private _detailRateLimit: SessionState['rateLimit'];
  private _sending = false;
  private _sendError: string | undefined;
  private _resumable: boolean | undefined;
  private _name: string | null | undefined;
  // The session's current (persisted) engine/model + its project, both from the
  // session detail; `switchModel` updates `_model` on a successful switch.
  private _model: string | undefined;
  private _modelSwitched = false;
  private _projectId: string | null | undefined;
  private _kind: 'normal' | 'agent_loop' | undefined;
  private _switchingModel = false;
  private _modelSwitchPending = false;
  private _modelSwitchPendingAfterActivityRequest = 0;
  private _terminationUnconfirmed = false;
  private _switchModelError: string | undefined;
  private _loaded = false;
  private _queued = false;
  // Append-only texts of queued sends; `subtractDelivered` derives which are still
  // pending by subtracting transcript coverage, so a dispatched one drops off.
  private readonly _queuedAll: string[] = [];
  // Locally echoed sends, newest last. Entries are retired by `retirePending` as
  // soon as the transcript (or the server's queue) covers them, so this list is
  // empty in steady state.
  private _pending: PendingEntry[] = [];
  private _pendingSeq = 0;
  // Server-authoritative activity, refreshed by a light poll (start→stop).
  private _busy = false;
  // Whether an activity poll has ever resolved. `loadDetail` seeds `_busy` from the
  // detail's status to cover the mount window BEFORE the first poll lands — but only
  // while this is false, so a slow detail probe can't clobber a fresher polled value.
  private _activityLoaded = false;
  // The newest live seq at the moment the server last authoritatively reported the
  // session settled (`busy: false`). The reducer's eager `session.running` can stick
  // ON when it misses a `task ended`/terminal event; the server (which re-derives the
  // open-task set from the full log every poll) is authoritative. So we trust the
  // eager flag only while a NEW event has arrived since that settled poll — i.e. the
  // reducer is running AHEAD of the poll on a fresh turn, not stuck BEHIND a finished
  // one. See the `working` field in `state`. Starts at -1 (no settled poll yet).
  private _settledAtSeq = -1;
  private _waiting: QueuedItem[] = [];
  // The worktree's live branch from the activity poll (#110), so the header label
  // tracks an external/agent `git checkout` without a remount. undefined until the
  // first poll resolves (or when the server doesn't report it).
  private _branch: string | undefined;
  private _activityTimer: ReturnType<typeof setInterval> | undefined;
  // Guards against overlapping polls: the interval fires on a fixed cadence
  // regardless of whether the prior `loadActivity` resolved, and the poll now does a
  // server-side git read (#110), so a slow tick must not let requests stack up.
  private _activityInFlight = false;
  private _activityRequest = 0;
  // Backward-pagination state: whether older history exists before the loaded
  // tail, and whether a fetch for it is in flight.
  private _hasOlder = false;
  private _loadingOlder = false;
  private _olderLoadStalled = false;
  private _olderLoadNeedsContinuation = false;
  private _olderLoadGeneration = 0;
  private _cancelError: string | undefined;
  // The tool_use_id of a permission decision POST in flight (#149), or undefined.
  private _decidingPermission: string | undefined;
  private _permissionError: string | undefined;
  // Settles when the session exists server-side (see SessionModelOptions.ready).
  // Always a promise, so the gated paths have one shape; `opts.ready === undefined`
  // is what keeps them synchronous for an ordinary session.
  private readonly _ready: Promise<void>;
  // Why the session was never created, once `ready` rejected. Distinguishes "this
  // send failed" from "there is nothing to send it to", which want different copy.
  private _createError: string | undefined;
  // Whether the model is between `start()` and `stop()`, and whether the app
  // backgrounded it. Both are re-read when a deferred start finally runs, so a
  // model unmounted (or paused) while its session was still being created never
  // opens a socket afterwards.
  private _running = false;
  private _paused = false;
  // Whether the stream has actually been opened. A model that was backgrounded
  // while its session was still being created never got that far, so its resume
  // has to OPEN the stream rather than resume a socket that does not exist.
  private _opened = false;

  constructor(private readonly opts: SessionModelOptions) {
    this.stream = new SessionStream({
      baseUrl: opts.baseUrl,
      sessionId: opts.sessionId,
      connect: opts.connect,
      ...(opts.getToken ? { getToken: opts.getToken } : {}),
      onUpdate: (session) => {
        this._session = session;
        // The canonical message may have just landed — hand the bubble over from the
        // local echo to the transcript before the screen re-renders, so it never
        // shows both (the echo's whole job ends here).
        this.retirePending();
        this._streamError = undefined; // a fresh event means the stream is healthy
        // The stream only emits onUpdate at/after `caught_up`, so the first snapshot
        // means the backlog has drained — latch loaded so the screen can show its
        // empty-state without it flashing during the initial load.
        this._loaded = true;
        this.emit();
      },
      onError: (message) => {
        this._streamError = message;
        this.emit();
      },
      onConnectionStateChange: (state) => {
        this._connectionState = state;
        this.emit();
      },
      ...(opts.scheduleReconnect ? { scheduleReconnect: opts.scheduleReconnect } : {}),
    });
    this._session = this.stream.state; // empty transcript until the stream opens
    this._ready =
      opts.ready === undefined
        ? Promise.resolve()
        : Promise.resolve(opts.ready).then(
            () => undefined,
            (error: unknown) => {
              // The session will never exist. Report it where the screen already
              // renders a banner, and remember it for the send path — which would
              // otherwise blame a turn that never left the device.
              // Any Error message here was authored for the operator (the launch
              // screen rejects with the server's reason or its own), so it is shown
              // verbatim rather than flattened to a generic failure.
              this._createError =
                error instanceof Error ? error.message : 'could not start the session';
              this._streamError = this._createError;
              this.emit();
              throw error;
            },
          );
    // Every gated path attaches its own handler, but a model that is constructed
    // and dropped without ever starting would leave this rejection unobserved.
    void this._ready.catch(() => undefined);
  }

  get state(): SessionModelState {
    const currentProvider = engineLabel(this._model ?? this._session.model);
    const streamRateLimit =
      this._session.rateLimit !== undefined &&
      this._session.rateLimit.providerLabel === currentProvider
        ? this._session.rateLimit
        : undefined;
    const session =
      streamRateLimit !== undefined
        ? { ...this._session, rateLimit: { ...streamRateLimit } }
        : this._detailRateLimit === undefined
          ? { ...this._session, rateLimit: undefined }
          : { ...this._session, rateLimit: { ...this._detailRateLimit } };
    return {
      session,
      streamError: this._streamError,
      connectionState: this._connectionState,
      sending: this._sending,
      sendError: this._sendError,
      resumable: this._resumable,
      name: this._name,
      model: this._model,
      projectId: this._projectId,
      kind: this._kind,
      switchingModel: this._switchingModel,
      modelSwitchPending: this._modelSwitchPending,
      terminationUnconfirmed: this._terminationUnconfirmed,
      switchModelError: this._switchModelError,
      loaded: this._loaded,
      locallyCreated: this.opts.ready !== undefined,
      queued: this._queued,
      queuedMessages: this.subtractDelivered(this._queuedAll),
      pendingMessages: this._pending.map((p) => ({
        id: p.id,
        text: p.text,
        status: p.status,
        createdAt: p.createdAt,
        ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
      })),
      busy: this._busy,
      // The reconciled "agent is working" signal that drives the Stop button +
      // activity line. `_busy` is server-authoritative (it already counts open
      // background tasks via `isBusy || derived==='running'`). The reducer's eager
      // `session.running` is honoured ONLY when a live event has arrived since the
      // server last said settled — so it bridges the sub-poll lag on a fresh turn
      // (running AHEAD of the poll) but can't keep the indicator lit after the turn
      // truly ended (a stuck-ON reducer running BEHIND a settled server). Keeps the
      // overview dot (server `status`) and this in-session indicator in agreement.
      working: this._busy || (this._session.running && this.stream.newestSeq > this._settledAtSeq),
      // Filter the server's queued list against the transcript too: the instant a
      // queued message is delivered (its `prompt` event lands as a user-text), drop
      // its "waiting to send" bubble — don't wait for the next activity poll, which
      // left it showing as a duplicate alongside the solid sent bubble.
      waitingMessages: this.subtractDeliveredItems(this._waiting),
      branch: this._branch,
      hasOlder: this._hasOlder,
      loadingOlder: this._loadingOlder,
      olderLoadStalled: this._olderLoadStalled,
      olderLoadNeedsContinuation: this._olderLoadNeedsContinuation,
      olderLoadGeneration: this._olderLoadGeneration,
      cancelError: this._cancelError,
      decidingPermission: this._decidingPermission,
      permissionError: this._permissionError,
    };
  }

  /** Drop texts that have already been DELIVERED — i.e. that now appear as a
   * `user-text` message in the transcript (their turn ran / they were steered in).
   * Counts occurrences per text so duplicates are handled and a still-pending copy
   * isn't dropped by an older identical message. The single reconciliation used by
   * BOTH the client-side `queuedMessages` and the server-authoritative
   * `waitingMessages`, so a delivered message never lingers as a "waiting" bubble
   * AND a solid sent bubble (the duplicate-bubble bug). */
  private subtractDelivered(texts: readonly string[]): string[] {
    return this.subtractDeliveredItems(texts.map((text) => ({ text }))).map((i) => i.text);
  }

  /** The items-carrying core of {@link subtractDelivered}: drop entries whose `text`
   * already appears as a delivered `user-text`, counting occurrences so duplicates
   * are handled. Generic over anything with a `text` field, so it serves both the
   * id-carrying server `waitingMessages` (preserving each item's retract `id`) and
   * the plain client-side `queuedMessages` strings. */
  private subtractDeliveredItems<T extends { text: string }>(items: readonly T[]): T[] {
    if (items.length === 0) return [];
    const inTranscript = new Map<string, number>();
    for (const m of this._session.messages) {
      if (m.kind === 'user-text') inTranscript.set(m.text, (inTranscript.get(m.text) ?? 0) + 1);
    }
    const used = new Map<string, number>();
    const pending: T[] = [];
    for (const item of items) {
      const n = (used.get(item.text) ?? 0) + 1;
      used.set(item.text, n);
      if (n > (inTranscript.get(item.text) ?? 0)) pending.push(item);
    }
    return pending;
  }

  /**
   * Retire local echoes ({@link PendingMessage}) that something authoritative now
   * covers, so a just-sent message is shown exactly once at every moment:
   *  - a `user-text` NEWER than the echo's dispatch seq with the same text — the
   *    canonical `prompt` event landed, so the real bubble takes over. The seq
   *    guard is what makes re-sending the same text (a plain "ok") safe: an older
   *    identical message can't retire the fresh echo.
   *  - a still-visible server `waitingMessages` entry with the same text — the turn
   *    was queued behind an in-flight one and has its own "waiting to send" bubble.
   * Failed echoes are never retired here: they stay until the operator dismisses
   * them, which is what keeps the un-sent text recoverable.
   * Returns whether anything was dropped (so callers can emit).
   */
  private retirePending(): boolean {
    if (this._pending.length === 0) return false;
    const waiting = new Map<string, number>();
    for (const item of this.subtractDeliveredItems(this._waiting)) {
      waiting.set(item.text, (waiting.get(item.text) ?? 0) + 1);
    }
    // Each transcript message may retire only ONE echo (two identical sends need
    // two delivered messages before both bubbles go).
    const claimed = new Set<string>();
    const kept: PendingEntry[] = [];
    for (const entry of this._pending) {
      if (entry.status === 'sending') {
        const delivered = this._session.messages.find(
          (m) =>
            m.kind === 'user-text' &&
            m.text === entry.text &&
            !claimed.has(m.id) &&
            messageSeq(m.id) > entry.sinceSeq,
        );
        if (delivered !== undefined) {
          claimed.add(delivered.id);
          continue;
        }
        const queued = waiting.get(entry.text) ?? 0;
        if (queued > 0) {
          waiting.set(entry.text, queued - 1);
          continue;
        }
      }
      kept.push(entry);
    }
    if (kept.length === this._pending.length) return false;
    this._pending = kept;
    return true;
  }

  /**
   * Drop a local echo and hand its text back, so the screen can put a failed send
   * back in the input to edit and retry (mirrors {@link cancelWaiting}). Resolves
   * `undefined` for an unknown id (already retired by the real message landing) —
   * nothing to restore, and nothing was removed.
   */
  dismissPending(id: string): string | undefined {
    const entry = this._pending.find((p) => p.id === id);
    if (entry === undefined) return undefined;
    this._pending = this._pending.filter((p) => p.id !== id);
    this.emit();
    return entry.text;
  }

  /** Open the live stream and load the session detail (REST metadata not in the
   * event stream: the `resumable` flag, which depends on the worktree existing,
   * and the operator-assigned display name for the header). */
  start(): void {
    this._running = true;
    this._paused = false;
    this.whenCreated(() => this.open());
  }

  /** Bring the session up: live stream, REST detail, activity poll. */
  private open(): void {
    this._opened = true;
    void this.openStreamFromTail();
    void this.loadDetail();
    this.startActivityPoll();
  }

  /** Suspend the socket + activity poll while the app is backgrounded. */
  pause(): void {
    this._paused = true;
    this.stream.pause();
    this.stopActivityPoll();
  }

  /** Resume live updates from the stream's last sequence cursor. */
  resume(): void {
    this._paused = false;
    this.whenCreated(() => {
      if (!this._opened) {
        // Never opened: the app was backgrounded while the session was still being
        // created. Clear the stream's pause flag (which would swallow the open) and
        // come up for the first time, tail probe and all.
        this.stream.resume();
        this.open();
        return;
      }
      this.stream.resume();
      this.startActivityPoll();
    });
  }

  /**
   * Run `action` once the session is known to exist server-side (see
   * {@link SessionModelOptions.ready}), skipping it if the model was stopped or
   * paused while waiting — an unmounted screen must not open a socket.
   *
   * Synchronous when no gate was supplied: the wait exists only for a session
   * whose creation is still in flight, and deferring every ordinary open by a
   * microtask would be a behaviour change for a case that never needed it.
   */
  private whenCreated(action: () => void): void {
    if (this.opts.ready === undefined) {
      action();
      return;
    }
    void this._ready.then(
      () => {
        if (this._running && !this._paused) action();
      },
      // Already surfaced as a stream error by the `ready` handler in the constructor.
      () => undefined,
    );
  }

  private startActivityPoll(): void {
    if (this._activityTimer !== undefined) return;
    // Poll the lightweight activity endpoint so the working indicator + waiting
    // messages are server-authoritative (reliable + survive navigation). Fetch
    // once immediately, then every 1.5s while open.
    void this.loadActivity();
    this._activityTimer = setInterval(() => void this.loadActivity(), 1500);
  }

  private stopActivityPoll(): void {
    if (this._activityTimer === undefined) return;
    clearInterval(this._activityTimer);
    this._activityTimer = undefined;
  }

  /**
   * Open the live stream from the session's TAIL: fetch the most recent history
   * page to learn its oldest seq, then resume the WS from just before it so a long
   * session opens without replaying its whole backlog (only the tail + live). On
   * any failure — or a short session with nothing older — fall back to a full
   * replay from seq 0 (correctness over speed).
   */
  private async openStreamFromTail(): Promise<void> {
    try {
      let page = await this.opts.client.getHistory(this.opts.sessionId, { limit: HISTORY_PAGE });
      let oldest = page.events[0]?.seq;
      let pages = 1;
      while (
        page.hasMore &&
        oldest !== undefined &&
        pages < TAIL_OPEN_MAX_PAGES &&
        !this.historyPageRendersMessages(page.events)
      ) {
        page = await this.opts.client.getHistory(this.opts.sessionId, {
          beforeSeq: oldest,
          limit: HISTORY_PAGE,
        });
        oldest = page.events[0]?.seq;
        pages += 1;
      }
      if (page.hasMore && oldest !== undefined && oldest > 1) {
        this.stream.setSinceSeq(oldest - 1);
        this._hasOlder = true; // older turns exist before the tail → scroll-up loads them
      }
    } catch {
      // fall back to a full replay from 0 (no older page to fetch)
    }
    this.stream.start();
  }

  private historyPageRendersMessages(
    events: readonly { seq: number; ts?: number | undefined; event: AgentEvent }[],
  ): boolean {
    const reducer = new SessionReducer();
    for (const e of events) {
      reducer.applyFrame({
        k: 'event',
        seq: e.seq,
        ...(e.ts !== undefined ? { ts: e.ts } : {}),
        event: e.event,
      });
    }
    return reducer.state.messages.length > 0;
  }

  /**
   * Load the previous page of older history (scroll-up). Fetches the events just
   * before the oldest loaded one and prepends them to the transcript. No-op when
   * there's nothing older or a fetch is already in flight. A failure is non-fatal:
   * keep what's loaded and let the operator retry by scrolling again.
   */
  async loadOlder(): Promise<void> {
    if (!this._hasOlder || this._loadingOlder) return;
    const beforeSeq = this.stream.oldestSeq;
    if (beforeSeq === undefined) return;
    this._loadingOlder = true;
    this._olderLoadStalled = false;
    this._olderLoadNeedsContinuation = false;
    this.emit();
    const fetchedPages: SessionHistoryPage['events'][] = [];
    let fetchedHasMore: boolean = this._hasOlder;
    try {
      let cursor = beforeSeq;

      // Event pages do not necessarily produce transcript rows (they can contain
      // only lifecycle/metadata frames). Scan a bounded number of pages so one load
      // normally reveals content without allowing malformed/huge metadata runs to
      // monopolize the UI or network.
      for (let pages = 0; pages < HISTORY_VISIBLE_SCAN_MAX_PAGES; pages += 1) {
        const page = await this.opts.client.getHistory(this.opts.sessionId, {
          beforeSeq: cursor,
          limit: HISTORY_PAGE,
        });
        fetchedPages.push(page.events);
        fetchedHasMore = page.hasMore;
        if (!page.hasMore || this.historyPageRendersMessages(page.events)) break;

        const nextBeforeSeq = page.events[0]?.seq;
        // A malformed/non-progressing page must not create an unbounded request loop.
        if (nextBeforeSeq === undefined || nextBeforeSeq >= cursor) {
          this._olderLoadStalled = true;
          break;
        }
        cursor = nextBeforeSeq;
      }
    } catch {
      // Keep pages fetched before a later transient failure. Advancing the stream's
      // oldest cursor avoids refetching them on retry and preserves their events even
      // when they did not independently render a transcript row.
      this._olderLoadStalled = true;
    } finally {
      if (fetchedPages.length > 0) {
        const producedVisibleRows = fetchedPages.some((events) =>
          this.historyPageRendersMessages(events),
        );
        const events = fetchedPages.reverse().flat();
        this.stream.prependHistory(events); // one anchored snapshot via onUpdate
        this._hasOlder = fetchedHasMore;
        this._olderLoadNeedsContinuation =
          fetchedHasMore && !this._olderLoadStalled && !producedVisibleRows;
      }
      this._loadingOlder = false;
      this._olderLoadGeneration += 1;
      this.emit();
    }
  }

  /**
   * Load older history in ONE fetch down to (and including) `targetSeq` — the backing
   * for a bookmark jump to a message that isn't in the loaded window. Instead of
   * paging {@link HISTORY_PAGE} at a time (N round-trips, and the forward-only reducer
   * rebuilt N times), it sizes a single request to the exact span between the current
   * oldest loaded event and the target. `seq` is monotonic per event, so
   * `oldestSeq - targetSeq` is an upper bound on the events in between — the target is
   * always included (a sparse seq space just loads a few extra older events, never too
   * few). No-op when the target is already loaded, nothing older exists, or a load is
   * in flight. If the server caps the page below the requested span the target may not
   * arrive in one shot — the caller re-invokes until it lands (or `hasOlder` clears),
   * so this still converges far faster than the 150-at-a-time scroll path. Non-fatal on
   * failure: keep what's loaded and let the caller retry.
   */
  async loadOlderUntil(targetSeq: number): Promise<void> {
    if (!this._hasOlder || this._loadingOlder) return;
    const beforeSeq = this.stream.oldestSeq;
    if (beforeSeq === undefined || targetSeq >= beforeSeq) return;
    this._loadingOlder = true;
    this._olderLoadStalled = false;
    this._olderLoadNeedsContinuation = false;
    this.emit();
    try {
      const page = await this.opts.client.getHistory(this.opts.sessionId, {
        beforeSeq,
        limit: beforeSeq - targetSeq,
      });
      this.stream.prependHistory(page.events); // emits a fresh snapshot via onUpdate
      this._hasOlder = page.hasMore;
    } catch {
      // transient — leave _hasOlder as-is so a later attempt retries
      this._olderLoadStalled = true;
    } finally {
      this._loadingOlder = false;
      this._olderLoadGeneration += 1;
      this.emit();
    }
  }

  /** Refresh the server-authoritative busy/queued activity. A failure is
   * non-fatal — keep the last known values until the next poll. */
  private async loadActivity(): Promise<void> {
    // Skip if a prior poll is still in flight, so a slow tick can't stack requests.
    if (this._activityInFlight) return;
    this._activityInFlight = true;
    const activityRequest = ++this._activityRequest;
    // Snapshot the newest seq NOW, before the request goes out: the server's answer
    // reflects the session state at roughly this moment, so anchoring the settled
    // guard to this (not the post-await value) means an event that arrives DURING the
    // request's flight — a turn starting under a stale in-flight poll — counts as
    // "newer than what the server saw" and keeps the eager indicator lit.
    const seqAtRequest = this.stream.newestSeq;
    try {
      const rateLimitPruned = this.pruneExpiredRateLimit();
      const activity = await this.opts.client.getActivity(this.opts.sessionId);
      // The poll is now the authoritative `_busy` source — stop `loadDetail` from
      // seeding it. Set BEFORE the no-change short-circuit so a first poll that
      // matches the initial `false` still counts as "landed".
      this._activityLoaded = true;
      // Anchor the stale-reducer guard: when the server says settled, remember the
      // newest live seq (as of the request) so a stuck `session.running` with no newer
      // event is suppressed, while a later event (a fresh turn) re-enables the eager
      // indicator. Also BEFORE the short-circuit so a repeated `busy:false` re-anchors.
      // Snapshot `working` FIRST: re-anchoring can flip it true→false (a stuck reducer
      // now overridden) even though `_busy` itself didn't change, and the screen must
      // re-render for that — so it can't be swallowed by the no-change short-circuit.
      const workingBefore = this.state.working;
      if (!activity.busy) this._settledAtSeq = seqAtRequest;
      // A defined `name` on the wire may differ from ours — an auto-title landed
      // (#auto-title) or the session was renamed externally. `undefined` means the
      // server didn't report it (older build), so keep the load-once value.
      const nameChanged = activity.name !== undefined && activity.name !== this._name;
      // Only a poll STARTED after the deferred response may clear the notice. An
      // older request can otherwise return stale `busy:false` after the switch was
      // accepted and hide the notice while the original turn is still running.
      const modelSwitchPendingBefore = this._modelSwitchPending;
      if (!this._modelSwitchPending && activity.modelSwitchPending === true) {
        // Rehydrate the notice after navigation/remount: the server owns the actual
        // deferred action, so its pending bit is authoritative across model lifetimes.
        this._modelSwitchPending = true;
        this._modelSwitchPendingAfterActivityRequest = activityRequest;
      }
      const modelSwitchSettled =
        this._modelSwitchPending &&
        activityRequest > this._modelSwitchPendingAfterActivityRequest &&
        (activity.modelSwitchPending === false ||
          (activity.modelSwitchPending === undefined && !activity.busy));
      if (modelSwitchSettled) this._modelSwitchPending = false;
      const modelSwitchPendingChanged = this._modelSwitchPending !== modelSwitchPendingBefore;
      // Server-owned outright — unlike `modelSwitchPending` there is no local echo to
      // reconcile against, because nothing the operator does sets or clears it. An
      // older server omits the field, which is not the same as "confirmed": it means
      // that server never holds the fence this way, so `false` is the honest read.
      const terminationUnconfirmed = activity.terminationUnconfirmed === true;
      // A queue entry from the previous poll may cover a newly added local echo.
      const pendingRetired = this.retirePending();
      if (
        activity.busy === this._busy &&
        terminationUnconfirmed === this._terminationUnconfirmed &&
        activity.branch === this._branch &&
        sameItems(activity.queued, this._waiting) &&
        !nameChanged &&
        !modelSwitchPendingChanged &&
        !rateLimitPruned &&
        !pendingRetired &&
        this.state.working === workingBefore
      ) {
        return;
      }
      this._busy = activity.busy;
      this._terminationUnconfirmed = terminationUnconfirmed;
      this._waiting = activity.queued;
      this._branch = activity.branch;
      if (nameChanged) this._name = activity.name;
      // A freshly reported queue entry may cover a local echo — reconcile before
      // emitting.
      this.retirePending();
      this.emit();
    } catch {
      // transient — keep the last values
    } finally {
      this._activityInFlight = false;
    }
  }

  private pruneExpiredRateLimit(nowMs = Date.now()): boolean {
    const nowSeconds = Math.floor(nowMs / 1000);
    let changed = false;
    if (this._detailRateLimit !== undefined && this._detailRateLimit.resetsAt <= nowSeconds) {
      this._detailRateLimit = undefined;
      changed = true;
    }
    if (this._session.rateLimit !== undefined && this._session.rateLimit.resetsAt <= nowSeconds) {
      this._session = { ...this._session, rateLimit: undefined };
      this.stream.clearRateLimit();
      changed = true;
    }
    return changed;
  }

  /** Fetch the session detail for its REST-only metadata. A failure here is
   * non-fatal (transient REST hiccup): leave `resumable` undefined so the screen
   * doesn't block sending on a flaky probe — a real dead session still surfaces via
   * a 410 on send, which flips the flag false. */
  private async loadDetail(): Promise<void> {
    try {
      const detail = await this.opts.client.getSession(this.opts.sessionId);
      this._name = detail.name;
      this._projectId = detail.projectId ?? null;
      this._kind = detail.kind ?? 'normal';
      // Seed the working indicator so the Stop button + activity line are correct on
      // mount, without waiting for the first activity poll. Mirror the poll's `busy`
      // (in-flight OR log-derived running): `detail.busy` is the conductor's `isBusy`
      // and `status === 'running'` covers an open background task — together they match
      // `/activity` exactly, including a turn parked on a permission prompt (busy while
      // `awaiting_input`). Guarded so a slow detail probe never reverts a fresher polled
      // value (mirrors `_resumable` above). That guard is also what keeps `_busy` and
      // `_terminationUnconfirmed` consistent: only the poll sets the flag, and it sets
      // `_activityLoaded` before it can, so this branch can never clear a busy the
      // banner still explains. Keep the two together if this is ever reordered.
      if (!this._activityLoaded) {
        this._busy = detail.busy === true || detail.status === 'running';
      }
      // Don't clobber a model the operator just switched to (a slow detail probe that
      // started before the switch would otherwise revert the chip): only seed it while
      // still unset OR when no switch is in flight, so the switch's value wins.
      if (this._model === undefined || (!this._modelSwitched && !this._switchingModel)) {
        this._model = detail.model;
      }
      this._detailRateLimit = normalizeDetailRateLimit(detail, this._model ?? detail.model);
      // Only seed the initial value: don't let a slow probe that started while the
      // worktree still existed overwrite a `false` already latched by a 410 mid-probe
      // (that would briefly re-enable a session the send proved dead).
      if (this._resumable === undefined) {
        this._resumable = detail.resumable;
      }
      this.emit();
    } catch {
      // leave undefined; the send path's 410 handling is the backstop
    }
  }

  /**
   * Switch the engine/model this session uses. The choice is persisted server-side
   * (`PATCH /sessions/:id`), so it sticks instead of being a one-turn override that
   * reverts to the spawn model; the model string is the backend-routing contract
   * (ADR 0001 — `codex/…` → Codex, `claude-*` → Claude).
   *
   * A turn already in flight IS interrupted: two backends may never own the worktree
   * at once, so the server cancels the running agent and only writes the new model
   * once that process is confirmed gone. The PATCH therefore resolves after the
   * handover, not before it — which is also why it can take a few seconds on a busy
   * session. `deferred` no longer comes back true from a current server.
   *
   * The header chip reflects the new engine on success; a 400 (a project session
   * given a non-Claude/Codex model) / 404 / 503 (the old agent's exit could not be
   * confirmed — nothing was changed, retry) sets {@link
   * SessionModelState.switchModelError}. No-op when already on `model` or a switch is
   * in flight (the picker guards too, but mirror sendTurn's re-entrancy guard).
   */
  async switchModel(model: string): Promise<void> {
    if (this._switchingModel || model === this._model) return;
    this._switchingModel = true;
    this._switchModelError = undefined;
    this.emit();
    try {
      // The header chip is live from the first frame, so the engine can be switched
      // while the session is still being created — hold the PATCH until it exists.
      await this._ready;
      const result = await this.opts.client.setSessionModel(this.opts.sessionId, model);
      this._model = result.model;
      this._modelSwitched = true;
      this._modelSwitchPending = result.deferred === true;
      this._modelSwitchPendingAfterActivityRequest = this._activityRequest;
      this._detailRateLimit = undefined;
      this.stream.clearRateLimit();
      void this.loadDetail();
    } catch (error) {
      this._switchModelError =
        error instanceof VerityApiError ? error.message : 'failed to switch model';
    } finally {
      this._switchingModel = false;
      this.emit();
    }
  }

  /** Close the stream (stops reconnecting) and stop the activity poll. */
  stop(): void {
    this._running = false;
    this.stream.stop();
    this.stopActivityPoll();
  }

  /**
   * Send an operator turn (the agent's response streams back over the WS). The
   * turn is dispatched async server-side — a 202 resolves this; a 404/409/400
   * sets {@link SessionModelState.sendError}.
   */
  async sendTurn(prompt: string, opts: Omit<TurnRequest, 'prompt'> = {}): Promise<void> {
    // Re-entrancy guard: drop a second send while one is already in flight. The
    // screen disables the button on `sending`, but that flag is React state set
    // async via onChange, so a fast double-tap can call this twice before the
    // re-render — without this guard both would POST a turn from one intent.
    if (this._sending) return;
    this._sending = true;
    this._sendError = undefined;
    this._cancelError = undefined; // a new turn clears a stale stop-error banner
    this._queued = false;
    // Echo the message into the transcript NOW (before the POST even goes out), so
    // it is visible for the whole round trip instead of vanishing until the server
    // gets round to persisting the `prompt` event. `retirePending` hands the bubble
    // over to the canonical message as soon as it lands.
    const echo: PendingEntry = {
      id: `pending-${String(++this._pendingSeq)}`,
      text: prompt,
      status: 'sending',
      createdAt: Date.now(),
      sinceSeq: this.stream.newestSeq,
      ...(opts.attachments !== undefined && opts.attachments.length > 0
        ? { attachments: opts.attachments.map(toDisplayAttachment) }
        : {}),
    };
    this._pending.push(echo);
    this.emit();
    try {
      // The session may still be being created (see SessionModelOptions.ready) —
      // the operator can type into a chat that opened instantly. The echo above is
      // already on screen, so this wait costs nothing visible; the POST goes out
      // the moment the id is real. Pre-resolved for an existing session.
      await this._ready;
      const result = await this.opts.client.sendTurn(this.opts.sessionId, { prompt, ...opts });
      // Queued behind an in-flight turn (#90): the screen hints "runs when free".
      this._queued = result.queued ?? false;
      // Remember the queued text so the screen can show it as a pending bubble
      // until its prompt event lands in the transcript (the turn actually runs).
      if (this._queued) this._queuedAll.push(prompt);
    } catch (error) {
      // Keep the bubble and mark it un-sent rather than dropping the text on the
      // floor: the operator can tap it to get the message back into the input.
      echo.status = 'failed';
      // A session that was never created is the more useful thing to report: the
      // turn is fine, there is just nothing to send it to.
      this._sendError =
        this._createError ??
        (error instanceof VerityApiError ? error.message : 'failed to send turn');
      // 410 Gone = the worktree vanished since the detail loaded; flip the flag so
      // the screen disables further sends (don't let the operator retry into a wall).
      if (error instanceof VerityApiError && error.status === 410) this._resumable = false;
    } finally {
      this._sending = false;
      this.emit();
      // The send may have changed the server's busy/queue — refresh now so the
      // working indicator + waiting bubble appear without waiting for the poll.
      void this.loadActivity();
    }
  }

  /**
   * Stop the in-flight turn (issue #79). Fire-and-forget like {@link sendTurn}:
   * the `interrupted` event + the cleared `running` flag arrive over the stream,
   * so there's no optimistic local state to flip here. A failure sets
   * {@link SessionModelState.cancelError}; a no-op (`cancelled: false`, the
   * session was already idle) is silent.
   *
   * `force` also lifts an unconfirmed-termination fence (see
   * {@link SessionModelState.terminationUnconfirmed}) — destructive enough to belong
   * behind a confirmation, since it hands the worktree on without proof the previous
   * agent left it. The flag is cleared locally on success rather than waited for: the
   * server has already released the session by then, and the next poll reconciles.
   */
  async cancel(opts?: { force?: boolean }): Promise<RestoredQueuedTurn[]> {
    this._cancelError = undefined;
    this.emit();
    try {
      const result = await this.opts.client.cancelTurn(this.opts.sessionId, opts);
      this._waiting = [];
      if (result.forceReleased) this._terminationUnconfirmed = false;
      if (result.cancelled) this.opts.onTurnCancelled?.();
      this.emit();
      return (result.droppedQueued ?? []).map((item) => ({
        prompt: item.prompt,
        ...(item.attachments !== undefined ? { attachments: item.attachments } : {}),
      }));
    } catch (error) {
      this._cancelError = error instanceof VerityApiError ? error.message : 'failed to stop turn';
      this.emit();
      return [];
    }
  }

  /**
   * Retract a queued turn before it runs (#80): ask the server to drop it from the
   * backlog and, on success, resolve with its prompt so the screen can put the text
   * back in the input for the operator to edit and resend. Resolves `undefined` when
   * there's nothing to restore — the item already left the queue (404: drained or
   * retracted, the stale bubble is dropped) or a transient failure left it queued
   * (the bubble stays; the next poll reconciles). The drop is reflected immediately
   * (no wait for the 1.5s poll) only once the server confirms it.
   */
  async cancelWaiting(id: string): Promise<RestoredQueuedTurn | undefined> {
    const item = this._waiting.find((w) => w.id === id);
    if (!item) return undefined; // unknown handle (e.g. an id-less item from an old server)
    try {
      const res = await this.opts.client.cancelQueued(this.opts.sessionId, id);
      // Removed server-side — drop the bubble now and hand the text back to edit.
      this._waiting = this._waiting.filter((w) => w.id !== id);
      this.emit();
      return {
        prompt: res.prompt,
        ...(res.attachments !== undefined ? { attachments: res.attachments } : {}),
      };
    } catch (error) {
      if (error instanceof VerityApiError && error.status === 404) {
        // Already gone (drained/retracted) — drop the stale bubble, nothing to edit.
        // The next scheduled poll reconciles (e.g. shows it delivered if it drained).
        this._waiting = this._waiting.filter((w) => w.id !== id);
        this.emit();
        return undefined;
      }
      // Transient failure: the turn is still queued — leave the bubble as-is.
      return undefined;
    }
  }

  /**
   * Answer the live mid-turn permission prompt (#149): POST the operator's
   * allow/deny for `toolUseId`, then dismiss the card as soon as the SERVER has
   * settled it — `decided: true` (the runner consumed the decision) or 404 (nothing
   * pending under that id: the turn ended, the operator already answered, or the
   * runner fail-safe-denied it). Both outcomes mean the card can never become
   * actionable again. Waiting for the stream to dismiss it instead left a live
   * "approve/deny" card on screen whenever the turn died between the prompt and its
   * `tool_call`/`tool_result` — no such event ever arrives, so the operator taps
   * Allow again and again and every retry 404s. Treating a 404 as "settled" needs no
   * route-vs-prompt disambiguation: a server without this endpoint also never emits
   * the `permission` stream event the card is built from (they ship together), so
   * there is no card to dismiss on one. Any other non-2xx surfaces as
   * `permissionError` and LEAVES the card up, so a transient network failure stays
   * retryable. The `_decidingPermission` guard drops a double-tap so one intent never
   * double-POSTs.
   */
  async decidePermission(toolUseId: string, decision: PermissionDecision): Promise<void> {
    if (this._decidingPermission !== undefined) return; // a decision is already in flight
    this._decidingPermission = toolUseId;
    this._permissionError = undefined;
    this.emit();
    try {
      const result = await this.opts.client.decidePermission(
        this.opts.sessionId,
        toolUseId,
        decision,
      );
      if (result.scopeSaved === false) {
        this._permissionError =
          'Request allowed, but the reusable permission could not be saved. Future requests will ask again.';
      }
      this.stream.resolvePermission(toolUseId);
      this.opts.onPermissionSettled?.(toolUseId, true);
    } catch (error) {
      // 404 = no pending prompt under that id (already stale): not an error — the
      // prompt is gone server-side, so drop the card here too rather than waiting
      // for a stream event that may never come. Any other failure is surfaced and
      // leaves the card actionable for a retry.
      if (error instanceof VerityApiError && error.status === 404) {
        this.stream.resolvePermission(toolUseId);
        this.opts.onPermissionSettled?.(toolUseId, false);
      } else {
        this._permissionError =
          error instanceof VerityApiError ? error.message : 'failed to send the decision';
      }
    } finally {
      this._decidingPermission = undefined;
      this.emit();
      // The decision may have unblocked the turn — refresh activity so the working
      // indicator updates without waiting for the next poll.
      void this.loadActivity();
    }
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }
}

/** The event seq encoded in a reducer-minted message id (`user-42`, `notice-42`),
 * or -1 when the id doesn't carry one. Used to tell a message that arrived AFTER a
 * local echo was dispatched from an older, identical one. Must stay in sync with
 * the id shapes the reducer produces for `user-text` messages. */
function messageSeq(id: string): number {
  const seq = Number.parseInt(id.slice(id.lastIndexOf('-') + 1), 10);
  return Number.isNaN(seq) ? -1 : seq;
}

/** An outgoing {@link TurnRequest} attachment as the transcript renders it. The
 * upload shape (inline base64) is a valid persisted attachment, so the local echo
 * shows the real thumbnails while the send is in flight; once the `prompt` event
 * lands the transcript's own (content-addressed) attachments take over. */
function toDisplayAttachment(upload: NonNullable<TurnRequest['attachments']>[number]): Attachment {
  return upload.kind === 'file'
    ? {
        kind: 'file',
        mediaType: upload.mediaType,
        fileName: upload.fileName,
        data: upload.data,
      }
    : { kind: 'image', mediaType: upload.mediaType, data: upload.data };
}

/** Shallow equality of two queued-item lists (order-sensitive, by id + text) — to
 * skip a no-op activity emit when the backlog hasn't changed. */
function sameItems(a: readonly QueuedItem[], b: readonly QueuedItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]?.id && x.text === b[i]?.text);
}

function normalizeDetailRateLimit(
  detail: SessionDetail,
  currentModel: string | undefined,
): SessionState['rateLimit'] {
  const rateLimits = detail.rateLimits ?? (detail.rateLimit ? [detail.rateLimit] : []);
  const currentProvider = engineLabel(currentModel);
  const rateLimit = rateLimits
    .filter(
      (r) =>
        (r.providerLabel ?? 'Claude') === currentProvider &&
        (r.scope === undefined || r.scope === 'all_models'),
    )
    .sort((a, b) => {
      const activeDelta = Number(a.status === 'allowed') - Number(b.status === 'allowed');
      if (activeDelta !== 0) return activeDelta;
      return b.resetsAt - a.resetsAt;
    })[0];
  if (rateLimit === undefined) return undefined;
  const providerLabel = rateLimit.providerLabel ?? 'Claude';
  return {
    status: rateLimit.status,
    resetsAt: rateLimit.resetsAt,
    window: rateLimit.window,
    ...(rateLimit.usedPercent !== undefined ? { usedPercent: rateLimit.usedPercent } : {}),
    providerLabel,
  };
}
