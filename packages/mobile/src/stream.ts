import {
  markSessionSwitch,
  sessionSwitchTiming,
  type SwitchTiming,
} from './sessionSwitchTiming.js';
import type { LiveEndedReason } from '@verity/events';
import type { LiveSessionHandle, LiveSessionTransport } from './live/connection.js';
import { type AgentEvent, type StreamEventFrame } from './wire.js';
import { SessionReducer, type SessionState } from './reducer.js';

function endedMessage(reason: LiveEndedReason): string {
  switch (reason) {
    case 'forbidden':
      return 'You no longer have access to this session.';
    case 'not_found':
      return 'This session no longer exists.';
    case 'limit':
      return 'Too many sessions are open at once. Close one and retry.';
    default:
      return 'The session stream could not be loaded. Retrying…';
  }
}

export interface SessionStreamOptions {
  sessionId: string;
  /** The app's live connection (or a fake in tests). */
  transport: LiveSessionTransport;
  /** Whether the session is on screen; see {@link SessionStream.setView}. */
  view?: boolean;
  /** Called with a fresh state snapshot after each applied event / caught_up. */
  onUpdate?: (state: SessionState) => void;
  /** Called when the stream cannot be served (no access, gone, a failed read). */
  onError?: (message: string) => void;
  /** Reports transport state for connection banners. */
  onConnectionStateChange?: (state: SessionStreamConnectionState) => void;
  /** Initial resume cursor; events with seq > this are streamed. Default 0. */
  sinceSeq?: number;
}

export type SessionStreamConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'paused' | 'stopped';

/**
 * Drives a single session's live transcript over the app's live connection: it
 * subscribes to the session from its cursor, feeds every frame into a
 * {@link SessionReducer}, and tracks the last seq. Reconnection belongs to the
 * connection, which resubscribes from {@link newestSeq} — the server replays only
 * events after the cursor, so the reducer keeps accumulating with no gap or
 * duplication. {@link stop} ends the subscription.
 */
export class SessionStream {
  // Reassigned (not readonly) when older history is prepended: the reducer is
  // forward-only, so prepending means rebuilding it over the full event list.
  private reducer = new SessionReducer();
  // Every applied event frame, in seq order — retained so older history can be
  // prepended (scroll-up) and the transcript rebuilt deterministically.
  private eventFrames: StreamEventFrame[] = [];
  private handle: LiveSessionHandle | null = null;
  private view: boolean;
  private lastSeq: number;
  private rateLimitClearedThroughSeq: number | undefined;
  // tool_use_ids whose permission prompt the server has already settled. Kept so
  // neither a reducer rebuild nor an older history page can resurrect the card.
  private readonly resolvedPermissions = new Set<string>();
  private timing: SwitchTiming | undefined;
  private started = false;
  private stopped = false;
  private paused = false;
  private connectionState: SessionStreamConnectionState | undefined;
  // True once the initial backlog has drained (the `caught_up` watermark). Until
  // then we apply events but suppress `onUpdate`, batching the backlog into one
  // render (see onMessage) so opening a session doesn't scroll wildly.
  private caughtUp = false;
  private readonly suppressedOutput = new Set<number>();
  private cancellingOutput: Set<number> | undefined;
  private outputFrozen = false;
  private pendingStops = 0;
  private stopSucceeded = false;
  private freezeAtSeq = 0;

  get outputSuppressed(): boolean {
    return this.outputFrozen;
  }

  freezeOutput(): void {
    if (this.pendingStops === 0) {
      this.cancellingOutput = new Set<number>();
      this.stopSucceeded = false;
      this.freezeAtSeq = this.lastSeq;
    }
    this.pendingStops += 1;
    this.outputFrozen = true;
  }

  settleOutput(success: boolean): boolean {
    this.stopSucceeded ||= success;
    this.pendingStops -= 1;
    if (this.pendingStops > 0) return false;
    if (this.stopSucceeded) {
      this.cancellingOutput = undefined;
      return false;
    }
    for (const seq of this.cancellingOutput ?? []) this.suppressedOutput.delete(seq);
    this.cancellingOutput = undefined;
    this.outputFrozen = false;
    this.reducer = new SessionReducer();
    for (const frame of this.eventFrames) {
      if (!this.suppressedOutput.has(frame.seq)) this.reducer.applyFrame(frame);
    }
    for (const id of this.resolvedPermissions) this.reducer.resolvePermission(id);
    return true;
  }

  constructor(private readonly opts: SessionStreamOptions) {
    this.timing = sessionSwitchTiming(opts.sessionId);
    this.lastSeq = opts.sinceSeq ?? 0;
    this.view = opts.view ?? false;
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

  reconcilePendingPermissions(toolUseIds: readonly string[], throughSeq = this.newestSeq): void {
    const pending = this.reducer.pendingPermission;
    if (pending !== undefined && !toolUseIds.includes(pending.toolUseId)) {
      const permissionFrame = this.eventFrames.findLast(
        (frame) => frame.event.t === 'permission' && frame.event.id === pending.toolUseId,
      );
      // The HTTP snapshot was taken before this streamed permission arrived. It
      // cannot say whether the newer prompt is still pending, so leave the card
      // for a later poll whose request started after the event.
      if (permissionFrame === undefined || permissionFrame.seq > throughSeq) return;
      this.resolvedPermissions.add(pending.toolUseId);
    }
    this.reducer.reconcilePendingPermissions(toolUseIds);
    if (pending !== undefined && this.reducer.pendingPermission === undefined && this.caughtUp) {
      this.opts.onUpdate?.(this.reducer.state);
    }
  }

  /**
   * Set the resume cursor BEFORE {@link start} — the WS then replays only events
   * with seq > `sinceSeq`. Used to open a long session from its tail (skip the
   * whole backlog). No-op once subscribed (the live cursor is owned by the
   * frame loop from then on).
   */
  setSinceSeq(sinceSeq: number): void {
    if (this.handle !== null) return;
    this.lastSeq = sinceSeq;
  }

  /** Whether the session is on screen. While it is (and the app is in front),
   * the server raises no notification about it for this user. */
  setView(view: boolean): void {
    this.view = view;
    this.handle?.setView(view);
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

  /** Latest lifecycle event, excluding transcript and administrative changes. */
  get activitySeq(): number {
    return this.reducer.activitySeq;
  }

  get settledSeq(): number {
    return this.reducer.settledSeq;
  }

  get hasOpenTasks(): boolean {
    return this.reducer.hasOpenTasks;
  }

  /**
   * Prepend an older page of history (from scroll-up). The reducer is forward-only,
   * so this rebuilds it over the combined event list — correct across the page
   * boundary (e.g. a tool_call in the older page paired with its tool_result in the
   * loaded tail). Events not strictly older than the current head are ignored
   * (idempotent against overlap). Callers publishing their own paging snapshot
   * can suppress the intermediate notification.
   */
  prependHistory(
    events: readonly { seq: number; ts?: number | undefined; event: AgentEvent }[],
    options: { notify?: boolean } = {},
  ): void {
    this.installHistory(events, options.notify ?? true);
  }

  /** Install and publish the complete REST tail before the socket opens.
   * Socket replay still waits for its own `caught_up` watermark. */
  seedHistory(
    events: readonly { seq: number; ts?: number | undefined; event: AgentEvent }[],
  ): void {
    this.installHistory(events, true);
  }

  private installHistory(
    events: readonly { seq: number; ts?: number | undefined; event: AgentEvent }[],
    notify: boolean,
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
    const previousMessages = this.reducer.messages;
    this.eventFrames = [...fresh, ...this.eventFrames];
    this.reducer = new SessionReducer();
    for (const frame of this.eventFrames) {
      if (!this.suppressedOutput.has(frame.seq)) this.reducer.applyFrame(frame);
    }
    // Replaying the frames re-raises every `permission` in them. Re-settle the ones
    // the server already answered so scroll-up can't resurrect a dismissed card.
    for (const toolUseId of this.resolvedPermissions) this.reducer.resolvePermission(toolUseId);
    this.reducer.reuseMessageSnapshots(previousMessages);
    if (notify) this.opts.onUpdate?.(this.reducer.state);
  }

  /** Subscribe. No-op if already started (call-once) or stopped. */
  start(): void {
    this.started = true;
    if (this.stopped || this.paused || this.handle !== null) return;
    this.subscribe();
  }

  /** Leave the subscription while the app is backgrounded, preserving reducer
   * state and the resume cursor. Unlike stop(), this can be resumed. */
  pause(): void {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.setConnectionState('paused');
    const handle = this.handle;
    this.handle = null;
    handle?.close();
  }

  /** Resubscribe from the last received sequence after a background pause. */
  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    if (this.started && this.handle === null) this.subscribe();
  }

  /** End the subscription. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.setConnectionState('stopped');
    this.paused = false;
    const handle = this.handle;
    this.handle = null;
    handle?.close();
  }

  private subscribe(): void {
    // Every subscription has its own replay watermark. Keeping the previous
    // one would publish replay frames as live updates before this one confirms
    // it has caught up.
    markSessionSwitch(this.timing, 'replay-subscribe');
    this.caughtUp = false;
    this.setConnectionState('connecting');
    let handle: LiveSessionHandle | null = null;
    const current = (): boolean => !this.stopped && !this.paused && this.handle === handle;
    handle = this.opts.transport.subscribeSession(
      this.opts.sessionId,
      {
        cursor: () => this.lastSeq,
        event: (frame) => {
          if (current()) this.onEvent(frame);
        },
        caughtUp: () => {
          if (!current()) return;
          markSessionSwitch(this.timing, 'replay-caught-up');
          this.caughtUp = true;
          this.setConnectionState('connected');
          this.opts.onUpdate?.(this.reducer.state);
        },
        ended: (reason) => {
          if (!current()) return;
          this.handle = null;
          this.setConnectionState('stopped');
          this.opts.onError?.(endedMessage(reason));
        },
        disconnected: (message) => {
          if (!current()) return;
          // The connection resubscribes from the cursor once it is back; the
          // replay that follows waits for its own `caught_up` again.
          this.caughtUp = false;
          this.setConnectionState('reconnecting');
          if (message !== undefined) this.opts.onError?.(message);
        },
      },
      this.view,
    );
    this.handle = handle;
  }

  private onEvent(frame: { seq: number; ts?: number | undefined; event: AgentEvent }): void {
    // Replays can overlap after a reconnect. Never apply an already-seen frame
    // or let an out-of-order frame move the resume cursor backwards.
    if (frame.seq <= this.lastSeq) return;
    const eventFrame: StreamEventFrame = {
      k: 'event',
      seq: frame.seq,
      ...(frame.ts !== undefined ? { ts: frame.ts } : {}),
      event: frame.event,
    };
    if (
      frame.event.t === 'prompt' &&
      !frame.event.steered &&
      this.reducer.settledSeq > this.freezeAtSeq
    )
      this.outputFrozen = false;
    if (
      this.outputFrozen &&
      ['text', 'thinking', 'tool_call', 'permission', 'choices', 'automation_proposal'].includes(
        frame.event.t,
      )
    ) {
      // Keep the cursor and retained history, but never replay stopped generation.
      this.cancellingOutput?.add(frame.seq);
      this.suppressedOutput.add(frame.seq);
    } else {
      this.reducer.applyFrame(eventFrame);
    }
    this.eventFrames.push(eventFrame);
    this.lastSeq = frame.seq;
    // Batch the initial backlog: apply its events silently and emit ONCE at
    // `caught_up`, so the screen renders the whole history in a single pass and
    // the list anchors to the bottom without re-anchoring per backlog event.
    // After caught_up, emit per event for live streaming.
    if (this.caughtUp) this.opts.onUpdate?.(this.reducer.state);
  }

  private setConnectionState(state: SessionStreamConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.opts.onConnectionStateChange?.(state);
  }
}
