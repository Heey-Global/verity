import { reuseSnapshotRecords } from '../snapshotIdentity.js';
import type { DomainEvent, LiveHint } from '@verity/events';
import {
  applyOverviewEvent,
  appliesToEarlierReads,
  keptWithout,
  withoutPermission,
} from '../live/overviewEvents.js';
import type { OverviewStore } from '../live/overviewStore.js';
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
  sessionReordering: boolean;
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
  client: Pick<
    VerityClient,
    'listSessions' | 'renameSession' | 'setSessionFavorite' | 'deleteSession'
  > & {
    reorderSessions?: (projectId: string | null, ids: string[]) => Promise<string[]>;
    listProviderLimits?: () => Promise<ProviderLimitSummary[]>;
    /** Optional like {@link listProviderLimits}: absent, the model falls back to
     * the plain list and simply reports no server-level attention. */
    listSessionOverview?: () => Promise<{
      sessions: SessionSummary[];
      attention: AttentionSignal[];
      sessionReordering?: boolean;
    }>;
  };
  /** Notified with a fresh state snapshot on every change. */
  onChange?: (state: SessionListState) => void;
  /** Safety-net poll interval; default 30s. Changes arrive as live hints
   * ({@link SessionListModel.applyHints}); the poll only catches what produced
   * none, and keeps time-derived fields fresh. */
  pollIntervalMs?: number;
  /** Time-only recompute interval; default 30s. Lets reset windows disappear even
   * when the network poll is paused/stale. */
  timeTickMs?: number;
  /** Schedule recurring polls; returns a canceller. Default wraps setInterval —
   * injected in tests to drive polling deterministically. */
  schedule?: (poll: () => void, intervalMs: number) => CancelPoll;
  /** Minimum spacing of list reloads caused only by transcript growth
   * (`events` hints); default 10s. Status, permission and session hints still
   * reload at once. */
  eventsRefreshMs?: number;
  /** Clock for {@link eventsRefreshMs}; injected in tests. */
  now?: () => number;
  /** The shared copy of sessions (ADR 0033) of this server and account, read
   * when needed because it changes with the account. Reads go into it, and the
   * list shows each session as it holds it, so an event or another view's read
   * changes Home at once. Without it the list keeps its own copy. */
  store?: () => OverviewStore | undefined;
  /** Whether a project's topic delivers its events live, `session.summary`
   * included. Its sessions' status and transcript growth then reach the list
   * as events, and the hints announcing them need no list read. */
  followsLive?: (projectId: string) => boolean;
  /** See {@link ROW_WAIT_MS}; injected in tests. */
  rowWaitMs?: number;
}

/** How long a skipped hint waits for its `session.summary` before the list
 * is read after all. The server publishes within two seconds. */
const ROW_WAIT_MS = 10_000;

/** Hint topics a `session.summary` event answers for a followed project. */
const SUMMARY_TOPICS: ReadonlySet<string> = new Set(['events', 'status']);

/** Home's read speaks for every session: `/sessions` and the project page
 * leave out the same ones. */
const EVERY_SESSION = { covers: () => true };

/**
 * Headless controller for the session-list screen: orchestrates
 * {@link VerityClient.listSessions} (initial load + polling), applies the
 * attention-first ordering, and exposes plain {@link SessionListState} + actions.
 * All the orchestration (loading/error, the refresh race guard, polling
 * lifecycle) lives here so it's unit-tested in the server container; the RN
 * screen is a thin renderer over `state` that calls {@link refresh}/{@link stop}.
 */
export class SessionListModel {
  private sessionReordering = false;
  private orderWrites = new Map<string | null, Promise<void>>();
  private orderMutations = new Map<string | null, number>();
  private confirmedOrders = new Map<string | null, Map<string, number | null | undefined>>();
  private pendingOrders = new Map<string | null, { ids: string[]; maxRequest: number }>();
  private _sessions: SessionSummary[] = [];
  private _attention: AttentionSignal[] = [];
  private _providerLimits: ProviderLimitSummary[] = [];
  private _loading = false;
  private _error: string | undefined;
  private cancelPoll: CancelPoll | undefined;
  /** The running model's coalescing refresh; undefined while stopped. */
  private poll: (() => void) | undefined;
  private cancelTimeTick: CancelPoll | undefined;
  // Monotonic request id: a slower earlier load must not overwrite a newer one.
  private reqSeq = 0;
  private favoriteMutations = new Map<string, number>();
  private confirmedFavorites = new Map<string, boolean>();
  private favoriteWrites = new Map<string, Promise<void>>();
  private pendingFavorites = new Map<string, { favorite: boolean; maxRequest: number }>();
  private pendingAutomations = new Map<
    string,
    { automation: SessionSummary['automation']; maxRequest: number }
  >();
  private pendingSessionStatuses = new Map<
    string,
    { status: SessionSummary['status']; maxRequest: number }
  >();
  private pendingPrStatuses = new Map<
    string,
    { pr: SessionPr; number?: number; maxRequest: number }
  >();
  // Sessions being deleted stay hidden even if an overlapping poll returns the
  // server's pre-delete snapshot. A successful tombstone remains until a later
  // snapshot confirms the session is absent.
  /** Answers received live, reapplied to list reads that started before them. */
  private answered: { event: DomainEvent; maxRequest: number }[] = [];
  private pendingDeletes = new Map<
    string,
    { active: number; removed: SessionSummary | undefined; succeeded: boolean }
  >();

  /** Names being saved, shown over the store's copy until the answer. */
  private pendingNames = new Map<string, { name: string | null; mutation: number }>();
  private nameMutations = 0;
  /** Favorites and orders the server stored while a newer write was out,
   * which the store has not taken. */
  private favoritesStored = new Set<string>();
  private ordersStored = new Set<string | null>();
  /** The newest rename of each session the server stored; older answers
   * stay out of the store. Kept, since an older answer may still arrive. */
  private storedRenames = new Map<string, number>();
  /** Names the server stored while a later rename of the session was out. */
  private confirmedNames = new Map<string, string | null>();
  /** The store that took the last read; the list shows its copies while it
   * is the current one. */
  private readStore: OverviewStore | undefined;
  /** Reads the store refused in a row; only the first is repeated at once. */
  private refusedReads = 0;
  private lastEventsRefreshAt = Number.NEGATIVE_INFINITY;
  /** Sessions whose skipped hint awaits its `session.summary`. */
  private readonly awaitedRows = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; after: number }
  >();
  private eventsRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: SessionListModelOptions) {}

  // Equal polls and quota-only ticks must not invalidate every memoized session row.
  private publishedSessions: SessionSummary[] = [];
  private orderedSource: SessionSummary[] | undefined;
  private orderedVersion = -1;
  private orderedOwnChanges = -1;
  /** Counts the model's own changes, each announced by `emit`. */
  private ownChanges = 0;
  /** Set while the model writes into the store; it announces that itself. */
  private writingStore = false;
  private shownSessions: SessionSummary[] = [];

  get state(): SessionListState {
    const store = this.currentStore();
    const version = store === undefined ? -1 : store.getVersion();
    // From the store, Home's pending changes are laid on too; they can change
    // without a new `_sessions`, but never without an `emit`.
    const own = store === undefined ? -1 : this.ownChanges;
    if (
      this.orderedSource !== this._sessions ||
      this.orderedVersion !== version ||
      this.orderedOwnChanges !== own
    ) {
      this.shownSessions = store === undefined ? this._sessions : this.shownFrom(store);
      this.publishedSessions = reuseSnapshotRecords(
        this.publishedSessions,
        orderedSessions(this.shownSessions),
        (session) => session.sessionId,
      );
      this.orderedSource = this._sessions;
      this.orderedVersion = version;
      this.orderedOwnChanges = own;
    }
    const shown = this.shownSessions;
    return {
      sessions: this.publishedSessions,
      sessionReordering: this.sessionReordering,
      attentionCount: attentionCount(shown),
      loading: this._loading,
      error: this._error,
      rateLimitNotice: overviewRateLimitNotice(shown, this._providerLimits, Date.now()),
      providerLimitRows: overviewProviderLimitRows(shown, this._providerLimits, Date.now()),
      serverAttention: attentionNotice(this._attention),
    };
  }

  /** The store whose copies the list shows: the current one, once it took a
   * read. Until then, or after it refused one, the list shows its own read. */
  private currentStore(): OverviewStore | undefined {
    const store = this.opts.store?.();
    return store !== undefined && store === this.readStore ? store : undefined;
  }

  /** The store's copy of each listed session, in the list's order, then the
   * sessions other views read since; none the store dropped. Home's own changes not yet confirmed by a
   * read (favorites, order, deletions) stay on top. */
  private shownFrom(store: OverviewStore): SessionSummary[] {
    const listed = new Set(this._sessions.map((session) => session.sessionId));
    // A session the store no longer holds was dropped by a newer read or an
    // event since Home's read, which the store took: it is gone for every view.
    const shown = this._sessions.flatMap((own) => {
      const held = store.session(own.sessionId);
      return held === undefined ? [] : [this.withOwnChanges(held)];
    });
    for (const held of store.sessions()) {
      if (listed.has(held.sessionId) || this.pendingDeletes.has(held.sessionId)) continue;
      shown.push(this.withOwnChanges(held));
    }
    return shown;
  }

  /** Only writes still out: a confirmed one is in the store, which keeps it
   * from older reads, and laying it on would hide a newer change from
   * elsewhere. */
  private withOwnChanges(session: SessionSummary): SessionSummary {
    let next = session;
    const name = this.pendingNames.get(session.sessionId);
    if (name !== undefined && next.name !== name.name) next = { ...next, name: name.name };
    const favorite = this.pendingFavorites.get(session.sessionId);
    if (favorite?.maxRequest === Infinity && (session.favorite === true) !== favorite.favorite) {
      next = { ...next, favorite: true };
      if (!favorite.favorite) delete next.favorite;
    }
    const order = this.pendingOrders.get(session.projectId ?? null);
    if (order?.maxRequest === Infinity) {
      const position = order.ids.indexOf(session.sessionId);
      const sortOrder = position < 0 ? null : position;
      if (next.sortOrder !== sortOrder) next = { ...next, sortOrder };
    }
    return next;
  }

  /** Put an accepted change into the store's copy, which a list read that
   * started earlier then no longer replaces. */
  private adopt(sessionId: string, change: (session: SessionSummary) => SessionSummary): void {
    this.adoptWhere((session) => session.sessionId === sessionId, change);
  }

  /** {@link adopt} for every held session `covers` selects, in one change. */
  private adoptWhere(
    covers: (session: SessionSummary) => boolean,
    change: (session: SessionSummary) => SessionSummary,
  ): void {
    const store = this.opts.store?.();
    const held = store?.sessions().filter(covers) ?? [];
    if (store === undefined || held.length === 0) return;
    this.writingStore = true;
    try {
      store.applySessions(store.beginRead(), held.map(change), { covers });
    } finally {
      this.writingStore = false;
    }
  }

  /** A confirmed or restored order, as {@link applyOrder} shows it. */
  private adoptOrder(projectId: string | null, ids: readonly string[]): void {
    const positions = new Map(ids.map((id, index) => [id, index]));
    this.adoptWhere(
      (session) => (session.projectId ?? null) === projectId,
      (session) => ({ ...session, sortOrder: positions.get(session.sessionId) ?? null }),
    );
  }

  private adoptFavorite(sessionId: string, favorite: boolean): void {
    this.adopt(sessionId, (session) => {
      const next: SessionSummary = { ...session, favorite: true };
      if (!favorite) delete next.favorite;
      return next;
    });
  }

  /** A deleted session leaves the store, so no other view lists it either. */
  private forget(sessionId: string): void {
    const store = this.opts.store?.();
    if (store?.session(sessionId) === undefined) return;
    this.writingStore = true;
    try {
      store.applySessions(store.beginRead(), [], {
        covers: (session) => session.sessionId === sessionId,
      });
    } finally {
      this.writingStore = false;
    }
  }

  /** The store changed (an event, another view's read). Shown only while the
   * list runs; {@link start} catches up. */
  storeChanged(): void {
    if (this.poll !== undefined && !this.writingStore) this.opts.onChange?.(this.state);
  }

  /** Reload the session list now. Safe to call concurrently with polling — a
   * stale response (superseded by a newer refresh) is discarded. */
  async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const req = ++this.reqSeq;
    if (!opts.silent) {
      this._loading = true;
      this.emit();
    }
    // Events that arrive while the read is out are applied again on top of it.
    const target = this.opts.store?.();
    const read = target?.beginRead();
    try {
      const overview = this.opts.client.listSessionOverview;
      const [list, providerLimits] = await Promise.all([
        overview === undefined
          ? this.opts.client
              .listSessions()
              .then((sessions) => ({ sessions, attention: [], sessionReordering: false }))
          : overview.call(this.opts.client),
        this.opts.client.listProviderLimits?.().catch(() => this._providerLimits) ??
          Promise.resolve([]),
      ]);
      const sessions = list.sessions;
      if (req !== this.reqSeq) return; // superseded
      this._attention = list.attention;
      this.sessionReordering = list.sessionReordering === true;
      this._sessions = sessions
        .filter((session) => !this.pendingDeletes.has(session.sessionId))
        .map((session) => {
          const favorite = this.pendingFavorites.get(session.sessionId);
          if (favorite !== undefined) {
            if (req <= favorite.maxRequest) {
              session = { ...session };
              if (favorite.favorite) session.favorite = true;
              else delete session.favorite;
            } else {
              this.pendingFavorites.delete(session.sessionId);
              this.confirmedFavorites.delete(session.sessionId);
            }
          }
          const automation = this.pendingAutomations.get(session.sessionId);
          if (automation !== undefined) {
            this.pendingAutomations.delete(session.sessionId);
            if (req <= automation.maxRequest) {
              session = { ...session };
              if (automation.automation === undefined) delete session.automation;
              else session.automation = automation.automation;
            }
          }
          const pendingPr = this.pendingPrStatuses.get(session.sessionId);
          if (pendingPr !== undefined) {
            this.pendingPrStatuses.delete(session.sessionId);
            if (req <= pendingPr.maxRequest)
              session = this.withPrStatus(session, pendingPr.pr, pendingPr.number);
          }
          const pending = this.pendingSessionStatuses.get(session.sessionId);
          if (pending === undefined) return session;
          this.pendingSessionStatuses.delete(session.sessionId);
          return req <= pending.maxRequest ? { ...session, status: pending.status } : session;
        });
      this.answered = this.answered.filter(({ maxRequest }) => req <= maxRequest);
      for (const { event } of this.answered) {
        const effect = applyOverviewEvent(this._sessions, event);
        if (effect.kind === 'local') this._sessions = effect.sessions;
      }
      for (const [projectId, pending] of this.pendingOrders) {
        if (req <= pending.maxRequest) this.applyOrder(projectId, pending.ids);
        else {
          this.pendingOrders.delete(projectId);
          this.confirmedOrders.delete(projectId);
        }
      }
      for (const [sessionId, deletion] of this.pendingDeletes) {
        const latest = sessions.find((session) => session.sessionId === sessionId);
        if (latest) deletion.removed = latest;
        if (deletion.active === 0 && deletion.succeeded && !latest) {
          this.pendingDeletes.delete(sessionId);
        }
      }
      this._providerLimits = providerLimits;
      this._error = undefined;
      if (target !== undefined && read !== undefined) {
        // Announced once by the `emit` below, with `readStore` already set.
        this.writingStore = true;
        let applied: boolean;
        try {
          applied = target.applySessions(read, sessions, EVERY_SESSION);
        } finally {
          this.writingStore = false;
        }
        this.readStore = applied ? target : undefined;
        // Events this read would need replayed were dropped: read once more.
        if (applied) this.refusedReads = 0;
        else if (this.refusedReads++ === 0) queueMicrotask(() => this.poll?.());
      }
    } catch (error) {
      if (req !== this.reqSeq) return;
      this._error =
        error instanceof VerityApiError ||
        (error instanceof Error && error.name === 'VerityConnectionError')
          ? error.message
          : 'failed to load sessions';
    } finally {
      // Ends a read that failed or was superseded; after `applySessions` it
      // changes nothing.
      if (read !== undefined) target?.endRead(read);
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
    const mutation = ++this.nameMutations;
    this.pendingNames.set(sessionId, { name, mutation });
    this.emit();
    // Answers may come in any order. A newer rename still out decides for
    // itself; one already stored is newer than this answer.
    const newerOut = () => (this.pendingNames.get(sessionId)?.mutation ?? 0) > mutation;
    const settled = () => {
      if (this.pendingNames.get(sessionId)?.mutation !== mutation) return;
      this.pendingNames.delete(sessionId);
      this.confirmedNames.delete(sessionId);
    };
    try {
      const { name: stored } = await this.opts.client.renameSession(sessionId, name);
      this.applyName(sessionId, stored);
      if ((this.storedRenames.get(sessionId) ?? 0) < mutation) {
        this.storedRenames.set(sessionId, mutation);
        // Kept for a newer rename still out, should that one fail.
        if (newerOut()) this.confirmedNames.set(sessionId, stored);
        else this.adopt(sessionId, (session) => ({ ...session, name: stored }));
      }
      settled();
      this._error = undefined;
    } catch (error) {
      // An earlier rename the server stored while this one was out is the
      // name now, which the store has not taken yet.
      const confirmed = this.confirmedNames.get(sessionId);
      if (!newerOut() && confirmed !== undefined)
        this.adopt(sessionId, (session) => ({ ...session, name: confirmed }));
      settled();
      this.applyName(sessionId, previousName); // revert just this name
      this._error = error instanceof VerityApiError ? error.message : 'failed to rename session';
    }
    this.emit();
  }

  /**
   * Mark or unmark a session as a favorite. Optimistic like {@link rename}: the
   * highlight changes immediately, and on failure only this session's flag is
   * reverted while the error surfaces until the next successful load.
   */
  async setFavorite(sessionId: string, favorite: boolean): Promise<void> {
    const mutation = (this.favoriteMutations.get(sessionId) ?? 0) + 1;
    this.favoriteMutations.set(sessionId, mutation);
    const previous = this._sessions.find((s) => s.sessionId === sessionId)?.favorite === true;
    if (!this.confirmedFavorites.has(sessionId)) this.confirmedFavorites.set(sessionId, previous);
    this.pendingFavorites.set(sessionId, { favorite, maxRequest: Infinity });
    this.applyFavorite(sessionId, favorite);
    this.emit();
    // Parallel requests can commit in reverse order even when stale responses are ignored.
    const write = async (): Promise<void> => {
      try {
        const { favorite: stored } = await this.opts.client.setSessionFavorite(sessionId, favorite);
        this.confirmedFavorites.set(sessionId, stored);
        // A newer choice is on its way; the store takes its answer instead.
        if (this.favoriteMutations.get(sessionId) !== mutation) {
          this.favoritesStored.add(sessionId);
          return;
        }
        this.favoritesStored.delete(sessionId);
        this.pendingFavorites.set(sessionId, { favorite: stored, maxRequest: this.reqSeq });
        this.applyFavorite(sessionId, stored);
        this.adoptFavorite(sessionId, stored);
        this._error = undefined;
      } catch (error) {
        if (this.favoriteMutations.get(sessionId) !== mutation) return;
        const confirmed = this.confirmedFavorites.get(sessionId) ?? previous;
        this.pendingFavorites.set(sessionId, { favorite: confirmed, maxRequest: this.reqSeq });
        this.applyFavorite(sessionId, confirmed);
        // The store never took the choice that failed; it lacks only an
        // earlier one the server stored meanwhile.
        if (this.favoritesStored.delete(sessionId)) this.adoptFavorite(sessionId, confirmed);
        this._error = error instanceof VerityApiError ? error.message : 'failed to update favorite';
      }
      this.emit();
    };
    const previousWrite = this.favoriteWrites.get(sessionId);
    const pending = previousWrite ? previousWrite.then(write) : write();
    this.favoriteWrites.set(sessionId, pending);
    await pending;
    if (this.favoriteWrites.get(sessionId) === pending) this.favoriteWrites.delete(sessionId);
  }

  /** Persist drag results in order; polls cannot overwrite an unconfirmed drag. */
  async reorder(projectId: string | null, ids: string[]): Promise<void> {
    if (!this.sessionReordering || !this.opts.client.reorderSessions) return;
    const mutation = (this.orderMutations.get(projectId) ?? 0) + 1;
    this.orderMutations.set(projectId, mutation);
    if (!this.confirmedOrders.has(projectId)) {
      this.confirmedOrders.set(
        projectId,
        new Map(
          this._sessions
            .filter((s) => (s.projectId ?? null) === projectId)
            .map((s) => [s.sessionId, s.sortOrder]),
        ),
      );
    }
    this.pendingOrders.set(projectId, { ids: [...ids], maxRequest: Infinity });
    this.applyOrder(projectId, ids);
    this.emit();
    const write = async (): Promise<void> => {
      try {
        const stored = await this.opts.client.reorderSessions!(projectId, ids);
        this.confirmedOrders.set(projectId, new Map(stored.map((id, index) => [id, index])));
        if (this.orderMutations.get(projectId) !== mutation) {
          this.ordersStored.add(projectId);
          return;
        }
        this.ordersStored.delete(projectId);
        this.pendingOrders.set(projectId, { ids: stored, maxRequest: this.reqSeq });
        this.applyOrder(projectId, stored);
        this.adoptOrder(projectId, stored);
        this._error = undefined;
      } catch (error) {
        if (this.orderMutations.get(projectId) !== mutation) return;
        const confirmed = this.confirmedOrders.get(projectId)!;
        this._sessions = this._sessions.map((s) =>
          (s.projectId ?? null) === projectId
            ? { ...s, sortOrder: confirmed.get(s.sessionId) ?? null }
            : s,
        );
        // As for favorites: only an earlier order the server stored meanwhile.
        if (this.ordersStored.delete(projectId))
          this.adoptWhere(
            (s) => (s.projectId ?? null) === projectId,
            (s) => ({ ...s, sortOrder: confirmed.get(s.sessionId) ?? null }),
          );
        // Preserve rollback against refreshes that began before the failed write.
        this.pendingOrders.delete(projectId);
        this.confirmedOrders.delete(projectId);
        this.reqSeq += 1;
        this._loading = false;
        this._error =
          error instanceof VerityApiError ? error.message : 'failed to reorder sessions';
      }
      this.emit();
    };
    const previous = this.orderWrites.get(projectId);
    const pending = previous ? previous.then(write) : write();
    this.orderWrites.set(projectId, pending);
    await pending;
    if (this.orderWrites.get(projectId) === pending) this.orderWrites.delete(projectId);
  }

  private applyOrder(projectId: string | null, ids: readonly string[]): void {
    const positions = new Map(ids.map((id, index) => [id, index]));
    this._sessions = this._sessions.map((s) =>
      (s.projectId ?? null) === projectId
        ? { ...s, sortOrder: positions.get(s.sessionId) ?? null }
        : s,
    );
  }

  /** Retire one permission immediately after its decision POST settles. The next
   * poll remains authoritative; this only removes the stale attention badge in
   * the gap before that poll arrives. */
  settlePermission(sessionId: string, toolUseId: string): void {
    this._sessions = this._sessions.map((session) =>
      session.sessionId === sessionId ? withoutPermission(session, toolUseId) : session,
    );
    this.adopt(sessionId, (session) => withoutPermission(session, toolUseId));
    this.emit();
  }

  /**
   * Apply an overview event from the live connection (ADR 0033). It applies
   * whether or not the list is on screen: an answered request must not come
   * back when Home is shown again. A list read that started before the event
   * may still carry the answered card, so the answer is reapplied to such
   * reads; reads started after it are the server's word. A question opened
   * after an answer may be stripped from such an older read; its own
   * `choices.opened` reload brings it back.
   */
  applyDomainEvent(event: DomainEvent): void {
    // A row the list already reflects counts as arrived; one it dropped as
    // unreadable does not, so the wait still ends in a read.
    const reflected =
      event.t === 'session.summary' &&
      (this._sessions.find((s) => s.sessionId === event.sessionId)?.summaryRev ?? -1) >= event.rev;
    const effect = applyOverviewEvent(this._sessions, event);
    if (event.t === 'session.summary' && (reflected || effect.kind === 'local'))
      this.rowArrived(event.sessionId, event.rev);
    if (effect.kind === 'reload') {
      // `poll` coalesces: a burst of requests is one read in flight plus one.
      this.poll?.();
      return;
    }
    if (appliesToEarlierReads(event)) {
      this.answered = keptWithout(this.answered, event);
      this.answered.push({ event, maxRequest: this.reqSeq });
      if (this.answered.length > 256) this.answered.shift();
    }
    if (effect.kind === 'local') {
      this._sessions = effect.sessions;
      this.emit();
    }
  }

  /** Apply a PR action result immediately; the regular poll then reconciles it. */
  applyPullRequestStatus(sessionId: string, pr: SessionPr, number?: number): void {
    this.pendingPrStatuses.set(sessionId, {
      pr,
      ...(number === undefined ? {} : { number }),
      maxRequest: this.reqSeq,
    });
    this._sessions = this._sessions.map((session) =>
      session.sessionId === sessionId ? this.withPrStatus(session, pr, number) : session,
    );
    this.adopt(sessionId, (session) => this.withPrStatus(session, pr, number));
    this.emit();
  }

  private withPrStatus(session: SessionSummary, pr: SessionPr, number?: number): SessionSummary {
    if (number !== undefined && session.pullRequest && session.pullRequest.number !== number)
      return session;
    return {
      ...session,
      pr,
      ...(session.pullRequest
        ? { pullRequest: { ...session.pullRequest, ...pr, mergeState: pr.mergeState } }
        : {}),
    };
  }

  /** Reflect a confirmed, paused, resumed, or deleted automation before polling. */
  applySessionAutomation(sessionId: string, automation: SessionSummary['automation']): void {
    // Responses already in flight predate the confirmed mutation.
    this.pendingAutomations.set(sessionId, { automation, maxRequest: this.reqSeq });
    const withAutomation = (session: SessionSummary): SessionSummary => {
      const next = { ...session };
      if (automation === undefined) delete next.automation;
      else next.automation = automation;
      return next;
    };
    this._sessions = this._sessions.map((session) =>
      session.sessionId === sessionId ? withAutomation(session) : session,
    );
    this.adopt(sessionId, withAutomation);
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
    this.adopt(sessionId, (session) => ({ ...session, status }));
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
  async delete(sessionId: string, opts: { force?: boolean; wiki?: boolean } = {}): Promise<void> {
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
      // Only the options asked for are sent, so a plain delete stays a plain call.
      if (opts.force || opts.wiki)
        await this.opts.client.deleteSession(sessionId, {
          ...(opts.force ? { force: true } : {}),
          ...(opts.wiki ? { wiki: true } : {}),
        });
      else await this.opts.client.deleteSession(sessionId);
      deletion.active -= 1;
      deletion.succeeded = true;
      this.forget(sessionId);
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

  /** Replace one session's favorite flag in the local list; `false` drops the
   * field, matching the server, which omits it for unmarked sessions. */
  private applyFavorite(sessionId: string, favorite: boolean): void {
    this._sessions = this._sessions.map((s) => {
      if (s.sessionId !== sessionId) return s;
      const next: SessionSummary = { ...s, favorite: true };
      if (!favorite) delete next.favorite;
      return next;
    });
  }

  /** Replace one session's name in the local list (no-op if it's not present). */
  private applyName(sessionId: string, name: string | null): void {
    this._sessions = this._sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s));
  }

  /**
   * Live hints from the server: these sessions changed. Refetches the list (the
   * hint carries no content), coalescing a burst into one request; a hint that
   * lands while a request is in flight queues exactly one more, so the change it
   * announced is never answered by a response that predates it.
   */
  applyHints(all: readonly LiveHint[]): void {
    const hints = all.filter((hint) => {
      if (!this.answeredByEvents(hint)) return true;
      this.awaitRow(hint.sessionId);
      return false;
    });
    // Every hint was answered by events of followed projects.
    if (all.length > 0 && hints.length === 0) return;
    for (const hint of hints) {
      if (hint.deleted === true) {
        const deletion = this.pendingDeletes.get(hint.sessionId) ?? {
          active: 0,
          removed: this._sessions.find((session) => session.sessionId === hint.sessionId),
          succeeded: true,
        };
        deletion.succeeded = true;
        this.pendingDeletes.set(hint.sessionId, deletion);
        this.forget(hint.sessionId);
        this._sessions = this._sessions.filter((s) => s.sessionId !== hint.sessionId);
      }
    }
    if (hints.some((hint) => hint.deleted === true)) this.emit();
    const urgent =
      hints.length === 0 ||
      hints.some(
        (hint) =>
          hint.deleted === true ||
          hint.topics.length === 0 ||
          hint.topics.some((t) => t !== 'events'),
      );
    if (urgent) {
      this.cancelEventsRefresh();
      this.poll?.();
      return;
    }
    // Every streamed chunk of every readable session hints `events`. Reloading
    // the whole list for each of them re-sent the full overview several times a
    // second while any agent was writing; transcript growth only moves unread
    // marks and previews, which may trail by a few seconds.
    if (this.poll === undefined || this.eventsRefreshTimer !== undefined) return;
    const spacing = this.opts.eventsRefreshMs ?? 10_000;
    const wait = this.lastEventsRefreshAt + spacing - (this.opts.now ?? Date.now)();
    const run = (): void => {
      this.eventsRefreshTimer = undefined;
      this.poll?.();
    };
    if (wait <= 0) run();
    else this.eventsRefreshTimer = setTimeout(run, wait);
  }

  /** A skipped hint expects the session's `session.summary`; one that does
   * not come (the server could not compute it, or this app could not read
   * it) is made up for by a list read. */
  private awaitRow(sessionId: string): void {
    // Each hint waits for a row from after it, so a row of an earlier change
    // cannot answer for a later one whose row then fails. The deadline stays
    // that of the first hint: a stream hints every moment and would otherwise
    // never reach it.
    const after = this._sessions.find((s) => s.sessionId === sessionId)?.summaryRev ?? -1;
    const pending = this.awaitedRows.get(sessionId);
    if (pending !== undefined) {
      pending.after = Math.max(pending.after, after);
      return;
    }
    const timer = setTimeout(() => {
      this.awaitedRows.delete(sessionId);
      this.poll?.();
    }, this.opts.rowWaitMs ?? ROW_WAIT_MS);
    this.awaitedRows.set(sessionId, { timer, after });
  }

  /** A row newer than the one the list held when the hint came answers it. */
  private rowArrived(sessionId: string, rev: number): void {
    const wait = this.awaitedRows.get(sessionId);
    if (wait === undefined || rev <= wait.after) return;
    clearTimeout(wait.timer);
    this.awaitedRows.delete(sessionId);
  }

  /** A hint only of status or transcript growth, for a listed session whose
   * project the list follows live: its `session.summary` brings the change. */
  private answeredByEvents(hint: LiveHint): boolean {
    if (hint.deleted === true || hint.topics.length === 0) return false;
    if (!hint.topics.every((topic) => SUMMARY_TOPICS.has(topic))) return false;
    const projectId = this._sessions.find((s) => s.sessionId === hint.sessionId)?.projectId;
    return projectId != null && this.opts.followsLive?.(projectId) === true;
  }

  private cancelEventsRefresh(): void {
    clearTimeout(this.eventsRefreshTimer);
    this.eventsRefreshTimer = undefined;
  }

  /** Initial load + start polling. Idempotent: cancels any existing poll first
   * so a double `start()` can't leak a timer. */
  start(): void {
    this.stop();
    this.refusedReads = 0;
    // Changes the store took while the list was hidden show at once.
    if ((this.currentStore()?.getVersion() ?? -1) !== this.orderedVersion) this.emit();
    const intervalMs = this.opts.pollIntervalMs ?? 30_000;
    // Coalesce requests while one is in flight. Without this guard, a slow
    // /sessions response is superseded by every following request and therefore
    // never reaches state — the UI can remain on the same PR/check count
    // indefinitely while requests pile up.
    let inFlight = false;
    let again = false;
    const poll = (): void => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      this.cancelEventsRefresh();
      // Every list read carries the transcript growth seen so far, so it also
      // restarts the spacing of reloads that only report such growth.
      this.lastEventsRefreshAt = (this.opts.now ?? Date.now)();
      void this.refresh({ silent: true }).finally(() => {
        inFlight = false;
        if (again && this.poll === poll) {
          again = false;
          poll();
        }
      });
    };
    this.poll = poll;
    poll();
    this.cancelPoll =
      intervalMs === 0
        ? undefined
        : this.opts.schedule
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
    this.poll = undefined;
    this.cancelEventsRefresh();
    for (const { timer } of this.awaitedRows.values()) clearTimeout(timer);
    this.awaitedRows.clear();
    this.cancelPoll?.();
    this.cancelTimeTick?.();
    this.cancelPoll = undefined;
    this.cancelTimeTick = undefined;
  }

  private emit(): void {
    this.ownChanges += 1;
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
  if (a.observedAt === undefined && b.observedAt !== undefined) return b;
  if (a.observedAt !== undefined && b.observedAt === undefined) return a;
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
  const providerLabel = rateLimit.providerLabel ?? 'Claude';
  // Any reading proves the provider is connected — an expired window or a
  // model-scoped limit too — so it keeps its row; only the meters go blank.
  const bucket = byProvider.get(providerLabel) ?? {};
  byProvider.set(providerLabel, bucket);
  if (!isLimitVisible(rateLimit, nowSeconds)) return;
  // The overview rows represent the provider-wide quota. Model-specific weekly
  // limits remain available in session data but must not replace "all models".
  if (rateLimit.scope !== undefined && rateLimit.scope !== 'all_models') return;
  const window = providerLimitWindow(rateLimit);
  bucket[window] = strongerLimit(bucket[window], {
    status: rateLimit.status,
    resetsAt: rateLimit.resetsAt,
    window,
    ...(rateLimit.usedPercent !== undefined ? { usedPercent: rateLimit.usedPercent } : {}),
    ...(rateLimit.observedAt !== undefined ? { observedAt: rateLimit.observedAt } : {}),
  });
}

/** Provider quota rows from server probes plus any per-session readings. */
export function overviewProviderLimitRows(
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
  // Only providers that report a limit get a row: the server's probes yield
  // nothing for an agent without credentials, so a fixed Claude/Codex pair would
  // show an empty meter for an agent that was never connected.
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
  providerLimits: readonly RateLimit[],
  nowMs: number,
): RateLimitNotice | null {
  let latest: RateLimitNotice | null = null;
  const nowSeconds = Math.floor(nowMs / 1000);
  for (const row of overviewProviderLimitRows(sessions, providerLimits, nowMs)) {
    for (const rateLimit of [row.fiveHour, row.weekly]) {
      if (rateLimit === null) continue;
      const notice = rateLimitNotice({ ...rateLimit, providerLabel: row.providerLabel }, nowMs);
      if (!notice || notice.resetsAt <= nowSeconds) continue;
      if (!latest || notice.resetsAt > latest.resetsAt) latest = notice;
    }
  }
  return latest;
}

/** Preserve the overview's group slots; only manual groups bypass attention priority. */
function orderedSessions(sessions: SessionSummary[]): SessionSummary[] {
  const queued = attentionQueue(sessions);
  const manual = new Map<string | null, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.projectId ?? null;
    if (session.sortOrder != null && !manual.has(key)) manual.set(key, []);
  }
  for (const session of sessions) manual.get(session.projectId ?? null)?.push(session);
  for (const group of manual.values())
    group.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
  const offsets = new Map<string | null, number>();
  return queued.map((session) => {
    const key = session.projectId ?? null;
    const group = manual.get(key);
    if (!group) return session;
    const index = offsets.get(key) ?? 0;
    offsets.set(key, index + 1);
    return group[index]!;
  });
}
