import {
  VerityApiError,
  type AttentionSignal,
  type VerityClient,
  type ProviderLimitSummary,
  type SessionPr,
  type SessionSummary,
} from '../api.js';
import { attentionCount, attentionQueue } from '../ui/attention.js';
import { attentionNotice, type AttentionNotice } from '../ui/attentionNotice.js';
import {
  FIVE_HOUR_WINDOW_SECONDS,
  rateLimitNotice,
  type RateLimit,
  type RateLimitNotice,
  type RateLimitWindow,
} from '../ui/rateLimit.js';

const DEFAULT_PROVIDER_LIMIT_ROWS = ['Claude', 'Codex'] as const;

export interface ProviderLimitState {
  status: string;
  resetsAt: number;
  window: RateLimitWindow;
  usedPercent?: number;
  scope?: string;
  observedAt?: number;
}

export interface ProviderLimitRow {
  providerLabel: string;
  fiveHour: ProviderLimitState | null;
  weekly: ProviderLimitState | null;
}

/** The render state the session-list screen consumes. */
export interface SessionListState {
  /** Sessions ordered attention-first (see {@link attentionQueue}). */
  sessions: SessionSummary[];
  /** How many need operator action (badge count). */
  attentionCount: number;
  /** A load is in flight (the LATEST one). */
  loading: boolean;
  /** Last load error, sanitized for display; cleared on the next success. */
  error: string | undefined;
  /** Latest active 5-hour rate-limit notice across the overview's sessions. */
  rateLimitNotice: RateLimitNotice | null;
  /** Provider quota meter rows for the overview header. */
  providerLimitRows: ProviderLimitRow[];
  /** A server-level condition to warn about (sealed, Updater unhealthy), or null. */
  serverAttention: AttentionNotice | null;
}

/** Cancels a scheduled poll. */
export type CancelPoll = () => void;

export interface SessionListModelOptions {
  client: Pick<VerityClient, 'listSessions' | 'renameSession' | 'deleteSession'> & {
    listProviderLimits?: () => Promise<ProviderLimitSummary[]>;
    /** Optional like {@link listProviderLimits}: absent, the model falls back to
     * the plain list and simply reports no server-level attention. */
    listSessionOverview?: () => Promise<{
      sessions: SessionSummary[];
      attention: AttentionSignal[];
    }>;
  };
  /** Notified with a fresh state snapshot on every change. */
  onChange?: (state: SessionListState) => void;
  /** Poll interval for the live list; default 2s. Kept short so auto-generated
   * session names (which land without a live event on the list) surface quickly. */
  pollIntervalMs?: number;
  /** Time-only recompute interval; default 30s. Lets reset windows disappear even
   * when the network poll is paused/stale. */
  timeTickMs?: number;
  /** Schedule recurring polls; returns a canceller. Default wraps setInterval —
   * injected in tests to drive polling deterministically. */
  schedule?: (poll: () => void, intervalMs: number) => CancelPoll;
}

/**
 * Headless controller for the session-list screen: orchestrates
 * {@link VerityClient.listSessions} (initial load + polling), applies the
 * attention-first ordering, and exposes plain {@link SessionListState} + actions.
 * All the orchestration (loading/error, the refresh race guard, polling
 * lifecycle) lives here so it's unit-tested in the server container; the RN
 * screen is a thin renderer over `state` that calls {@link refresh}/{@link stop}.
 */
export class SessionListModel {
  private _sessions: SessionSummary[] = [];
  private _attention: AttentionSignal[] = [];
  private _providerLimits: ProviderLimitSummary[] = [];
  private _loading = false;
  private _error: string | undefined;
  private cancelPoll: CancelPoll | undefined;
  private cancelTimeTick: CancelPoll | undefined;
  // Monotonic request id: a slower earlier load must not overwrite a newer one.
  private reqSeq = 0;
  private pendingSessionStatuses = new Map<
    string,
    { status: SessionSummary['status']; maxRequest: number }
  >();
  // Sessions being deleted stay hidden even if an overlapping poll returns the
  // server's pre-delete snapshot. A successful tombstone remains until a later
  // snapshot confirms the session is absent.
  private pendingDeletes = new Map<
    string,
    { active: number; removed: SessionSummary | undefined; succeeded: boolean }
  >();

  constructor(private readonly opts: SessionListModelOptions) {}

  get state(): SessionListState {
    return {
      sessions: attentionQueue(this._sessions),
      attentionCount: attentionCount(this._sessions),
      loading: this._loading,
      error: this._error,
      rateLimitNotice: overviewRateLimitNotice(this._sessions, Date.now()),
      providerLimitRows: overviewProviderLimitRows(
        this._sessions,
        this._providerLimits,
        Date.now(),
      ),
      serverAttention: attentionNotice(this._attention),
    };
  }

  /** Reload the session list now. Safe to call concurrently with polling — a
   * stale response (superseded by a newer refresh) is discarded. */
  async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const req = ++this.reqSeq;
    if (!opts.silent) {
      this._loading = true;
      this.emit();
    }
    try {
      const overview = this.opts.client.listSessionOverview;
      const [list, providerLimits] = await Promise.all([
        overview === undefined
          ? this.opts.client.listSessions().then((sessions) => ({ sessions, attention: [] }))
          : overview.call(this.opts.client),
        this.opts.client.listProviderLimits?.().catch(() => this._providerLimits) ??
          Promise.resolve([]),
      ]);
      const sessions = list.sessions;
      if (req !== this.reqSeq) return; // superseded
      this._attention = list.attention;
      this._sessions = sessions
        .filter((session) => !this.pendingDeletes.has(session.sessionId))
        .map((session) => {
          const pending = this.pendingSessionStatuses.get(session.sessionId);
          if (pending === undefined) return session;
          this.pendingSessionStatuses.delete(session.sessionId);
          return req <= pending.maxRequest ? { ...session, status: pending.status } : session;
        });
      for (const [sessionId, deletion] of this.pendingDeletes) {
        const latest = sessions.find((session) => session.sessionId === sessionId);
        if (latest) deletion.removed = latest;
        if (deletion.active === 0 && deletion.succeeded && !latest) {
          this.pendingDeletes.delete(sessionId);
        }
      }
      this._providerLimits = providerLimits;
      this._error = undefined;
    } catch (error) {
      if (req !== this.reqSeq) return;
      this._error = error instanceof VerityApiError ? error.message : 'failed to load sessions';
    } finally {
      if (req === this.reqSeq) {
        this._loading = false;
        this.emit();
      }
    }
  }

  /**
   * Rename a session (set its display name, or clear it with `null`). Optimistic:
   * the new name shows immediately, then reconciles with the server's canonical
   * (trimmed) value on success. On failure the optimistic name is reverted (only
   * that session's name — concurrent poll updates to the rest of the list are
   * preserved) and the error surfaces until the next successful load.
   */
  async rename(sessionId: string, name: string | null): Promise<void> {
    const previousName = this._sessions.find((s) => s.sessionId === sessionId)?.name ?? null;
    this.applyName(sessionId, name); // optimistic — don't wait for the next poll
    this.emit();
    try {
      const { name: stored } = await this.opts.client.renameSession(sessionId, name);
      this.applyName(sessionId, stored);
      this._error = undefined;
    } catch (error) {
      this.applyName(sessionId, previousName); // revert just this name
      this._error = error instanceof VerityApiError ? error.message : 'failed to rename session';
    }
    this.emit();
  }

  /** Retire one permission immediately after its decision POST settles. The next
   * poll remains authoritative; this only removes the stale attention badge in
   * the gap before that poll arrives. */
  settlePermission(sessionId: string, toolUseId: string): void {
    this._sessions = this._sessions.map((session) => {
      if (session.sessionId !== sessionId || session.pendingPermissions === undefined) {
        return session;
      }
      const pendingPermissions = session.pendingPermissions.filter((id) => id !== toolUseId);
      if (pendingPermissions.length === session.pendingPermissions.length) return session;
      return {
        ...session,
        pendingPermissions,
        ...(session.permissionAwaitingInput === true && pendingPermissions.length === 0
          ? { status: 'running' as const, permissionAwaitingInput: undefined }
          : {}),
      };
    });
    this.emit();
  }

  /** Apply a PR action result immediately; the regular poll then reconciles it. */
  applyPullRequestStatus(sessionId: string, pr: SessionPr): void {
    this._sessions = this._sessions.map((session) =>
      session.sessionId === sessionId ? { ...session, pr } : session,
    );
    this.emit();
  }

  /** Reflect an accepted action (for example a notification reply) before polling. */
  applySessionStatus(sessionId: string, status: SessionSummary['status']): void {
    const present = this._sessions.some((session) => session.sessionId === sessionId);
    // Once present, any request in flight began before the action and is stale. During
    // initial loading, preserve the request and overlay this status when it lands.
    if (present) {
      this.pendingSessionStatuses.delete(sessionId);
      this.reqSeq += 1;
      this._loading = false;
    } else {
      this.pendingSessionStatuses.set(sessionId, { status, maxRequest: this.reqSeq });
    }
    this._sessions = this._sessions.map((session) =>
      session.sessionId === sessionId ? { ...session, status } : session,
    );
    this.emit();
  }

  /**
   * Permanently delete a session. Optimistic: the row disappears from the list
   * immediately, then the server call confirms it. On failure the row is
   * re-inserted (unless a concurrent poll already brought it back) and the error
   * surfaces until the next successful load — mirroring {@link rename}'s
   * preserve-concurrent-poll-updates revert. The visible order is reapplied by
   * {@link attentionQueue}, so the re-insert position doesn't matter.
   */
  async delete(sessionId: string, opts: { force?: boolean } = {}): Promise<void> {
    const removed = this._sessions.find((s) => s.sessionId === sessionId);
    const deletion = this.pendingDeletes.get(sessionId) ?? {
      active: 0,
      removed,
      succeeded: false,
    };
    deletion.active += 1;
    this.pendingDeletes.set(sessionId, deletion);
    this._sessions = this._sessions.filter((s) => s.sessionId !== sessionId);
    this.emit();
    try {
      if (opts.force) await this.opts.client.deleteSession(sessionId, opts);
      else await this.opts.client.deleteSession(sessionId);
      deletion.active -= 1;
      deletion.succeeded = true;
      this._error = undefined;
    } catch (error) {
      deletion.active -= 1;
      // Another overlapping request already completed the same deletion. A
      // later 404/409 is therefore not a user-visible failure.
      if (deletion.succeeded) {
        this._error = undefined;
        this.emit();
        return;
      }
      if (deletion.active === 0 && !deletion.succeeded) {
        this.pendingDeletes.delete(sessionId);
        if (deletion.removed && !this._sessions.some((s) => s.sessionId === sessionId)) {
          this._sessions = [...this._sessions, deletion.removed];
        }
      }
      this._error = error instanceof VerityApiError ? error.message : 'failed to delete session';
      this.emit();
      throw error;
    }
    this.emit();
  }

  /** Replace one session's name in the local list (no-op if it's not present). */
  private applyName(sessionId: string, name: string | null): void {
    this._sessions = this._sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s));
  }

  /** Initial load + start polling. Idempotent: cancels any existing poll first
   * so a double `start()` can't leak a timer. */
  start(): void {
    this.stop();
    const intervalMs = this.opts.pollIntervalMs ?? 2000;
    // Coalesce interval ticks while the previous poll is still in flight. Without
    // this guard, a slow /sessions response (> intervalMs) is superseded by every
    // following request and therefore never reaches state — the UI can remain on
    // the same PR/check count indefinitely while requests pile up.
    let inFlight = false;
    const poll = (): void => {
      if (inFlight) return;
      inFlight = true;
      void this.refresh({ silent: true }).finally(() => {
        inFlight = false;
      });
    };
    poll();
    this.cancelPoll = this.opts.schedule
      ? this.opts.schedule(poll, intervalMs)
      : defaultSchedule(poll, intervalMs);
    const tickIntervalMs = this.opts.timeTickMs ?? 30_000;
    const tick = (): void => this.emit();
    this.cancelTimeTick = this.opts.schedule
      ? this.opts.schedule(tick, tickIntervalMs)
      : defaultSchedule(tick, tickIntervalMs);
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    this.cancelPoll?.();
    this.cancelTimeTick?.();
    this.cancelPoll = undefined;
    this.cancelTimeTick = undefined;
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }
}

function compareProviderLabels(a: string, b: string): number {
  const order = new Map([
    ['Claude', 0],
    ['Codex', 1],
  ]);
  return (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b);
}

function isLimitVisible(rateLimit: RateLimit, nowSeconds: number): boolean {
  if (rateLimit.resetsAt <= nowSeconds) return false;
  return rateLimit.status !== 'allowed' || rateLimit.usedPercent !== undefined;
}

function providerLimitWindow(rateLimit: RateLimit): RateLimitWindow {
  const providerLabel = rateLimit.providerLabel ?? 'Claude';
  const window = rateLimit.window ?? 'five_hour';
  // Older Verity versions assumed Codex `primary` always meant five-hour. Codex
  // now reports the weekly quota as `primary`, so repair persisted meter events
  // whose observed duration could not possibly be a five-hour window.
  if (
    providerLabel === 'Codex' &&
    window === 'five_hour' &&
    rateLimit.observedAt !== undefined &&
    rateLimit.resetsAt * 1000 - rateLimit.observedAt > FIVE_HOUR_WINDOW_SECONDS * 1000
  ) {
    return 'weekly';
  }
  return window;
}

function strongerLimit(
  a: ProviderLimitState | undefined,
  b: ProviderLimitState,
): ProviderLimitState {
  if (a === undefined) return b;
  if (a.observedAt !== undefined && b.observedAt !== undefined && b.observedAt !== a.observedAt)
    return b.observedAt > a.observedAt ? b : a;
  if (a.status === 'allowed' && b.status !== 'allowed') return b;
  if (a.status !== 'allowed' && b.status === 'allowed') return a;
  if (b.resetsAt !== a.resetsAt) return b.resetsAt > a.resetsAt ? b : a;
  return (b.usedPercent ?? -1) > (a.usedPercent ?? -1) ? b : a;
}

function addProviderLimit(
  byProvider: Map<string, Partial<Record<RateLimitWindow, ProviderLimitState>>>,
  rateLimit: RateLimit,
  nowSeconds: number,
): void {
  if (!isLimitVisible(rateLimit, nowSeconds)) return;
  // The overview rows represent the provider-wide quota. Model-specific weekly
  // limits remain available in session data but must not replace "all models".
  if (rateLimit.scope !== undefined && rateLimit.scope !== 'all_models') return;
  const providerLabel = rateLimit.providerLabel ?? 'Claude';
  const window = providerLimitWindow(rateLimit);
  const bucket = byProvider.get(providerLabel) ?? {};
  bucket[window] = strongerLimit(bucket[window], {
    status: rateLimit.status,
    resetsAt: rateLimit.resetsAt,
    window,
    ...(rateLimit.usedPercent !== undefined ? { usedPercent: rateLimit.usedPercent } : {}),
    ...(rateLimit.observedAt !== undefined ? { observedAt: rateLimit.observedAt } : {}),
  });
  byProvider.set(providerLabel, bucket);
}

function overviewProviderLimitRows(
  sessions: readonly SessionSummary[],
  providerLimits: readonly RateLimit[],
  nowMs: number,
): ProviderLimitRow[] {
  const nowSeconds = Math.floor(nowMs / 1000);
  const byProvider = new Map<string, Partial<Record<RateLimitWindow, ProviderLimitState>>>();
  for (const rateLimit of providerLimits) addProviderLimit(byProvider, rateLimit, nowSeconds);
  for (const session of sessions) {
    const rateLimits = session.rateLimits ?? (session.rateLimit ? [session.rateLimit] : []);
    for (const rateLimit of rateLimits) addProviderLimit(byProvider, rateLimit, nowSeconds);
  }
  for (const providerLabel of DEFAULT_PROVIDER_LIMIT_ROWS) {
    if (!byProvider.has(providerLabel)) byProvider.set(providerLabel, {});
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => compareProviderLabels(a, b))
    .map(([providerLabel, limits]) => ({
      providerLabel,
      fiveHour: limits.five_hour ?? null,
      weekly: limits.weekly ?? null,
    }));
}

function defaultSchedule(poll: () => void, intervalMs: number): CancelPoll {
  const id = setInterval(poll, intervalMs);
  return () => {
    clearInterval(id);
  };
}

function overviewRateLimitNotice(
  sessions: readonly SessionSummary[],
  nowMs: number,
): RateLimitNotice | null {
  let latest: RateLimitNotice | null = null;
  const nowSeconds = Math.floor(nowMs / 1000);
  for (const session of sessions) {
    // Overview is an account/provider-level memory: keep a provider limit visible
    // until its reset even if this session has since switched to another model.
    const rateLimits = session.rateLimits ?? (session.rateLimit ? [session.rateLimit] : []);
    for (const rateLimit of rateLimits) {
      if (rateLimit.scope !== undefined && rateLimit.scope !== 'all_models') continue;
      const notice = rateLimitNotice(
        { ...rateLimit, window: providerLimitWindow(rateLimit) },
        nowMs,
      );
      if (!notice || notice.resetsAt <= nowSeconds) continue;
      if (!latest || notice.resetsAt > latest.resetsAt) latest = notice;
    }
  }
  return latest;
}
