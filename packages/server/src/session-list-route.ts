import { measureLatencyPhase, type EventStore, type SessionRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import type { AttentionSignal } from './attention.js';
import type { SessionSummary, SessionListEnvelope } from './server.js';
import { viewerId } from './view-state-routes.js';

export interface SessionListRouteDeps {
  store: Pick<EventStore, 'listSessions' | 'sessionSortOrders' | 'linkedSessionIds' | 'viewState'>;
  prunePrSummaryCache: (liveWorktrees: ReadonlySet<string>) => void;
  pruneBranchCache: (liveWorktrees: ReadonlySet<string>) => void;
  summarizeSessions: (sessions: SessionRecord[]) => Promise<SessionSummary[]>;
  collectAttention: () => Promise<AttentionSignal[]>;
  /** Sessions the server runs for itself (Wiki maintenance); no list shows them. */
  hiddenSessionIds?: () => Promise<ReadonlySet<string>>;
  /**
   * What `viewer` may see (ADR 0023 §1): everything, or the sessions of the
   * projects they can read, plus sessions without a project for an
   * administrator. Absent → everything, as for the single operator.
   */
  visibleTo?: (
    viewer: string,
  ) => Promise<
    { all: true } | { all: false; projectIds: ReadonlySet<string>; unassigned: boolean }
  >;
}

export function registerSessionListRoute(app: FastifyInstance, deps: SessionListRouteDeps): void {
  /**
   * The session list, and — only when the client asks for the envelope — the
   * server-level {@link AttentionSignal}s alongside it.
   *
   * WHY THE ENVELOPE IS OPT-IN. This route has always answered with a bare
   * JSON array, and the app parses it with `z.array(sessionSummarySchema)`. An
   * unconditional switch to an object would make every already-installed app
   * build fail that parse and show "failed to load sessions" — the session list
   * would break for exactly as long as it took each device to update, in order
   * to deliver a health banner. `?envelope=1` lets a new app opt in while an old
   * one keeps getting the array it understands, and costs one query parameter.
   */
  // Only concurrent computations share work; a completed read is never cached.
  // Authentication hooks still run independently before every handler invocation.
  let inFlight: Promise<SessionSummary[]> | undefined;
  const load = async (): Promise<SessionSummary[]> => {
    const [all, hidden] = await Promise.all([
      measureLatencyPhase('session_list', () => deps.store.listSessions()),
      deps.hiddenSessionIds?.(),
    ]);
    const sessions = all.filter((session) => !hidden?.has(session.sessionId));
    const liveWorktrees = new Set(sessions.map((s) => s.worktree));
    deps.prunePrSummaryCache(liveWorktrees);
    deps.pruneBranchCache(liveWorktrees);
    const summaries = await measureLatencyPhase('session_summaries', () =>
      deps.summarizeSessions(sessions),
    );
    const linked = await deps.store.linkedSessionIds();
    for (const summary of summaries) {
      if (linked.has(summary.sessionId)) summary.linked = true;
    }
    const orders = await deps.store.sessionSortOrders(sessions);
    for (const summary of summaries) summary.sortOrder = orders.get(summary.sessionId) ?? null;
    return summaries;
  };
  const sharedLoad = (): Promise<SessionSummary[]> => {
    if (inFlight !== undefined) return inFlight;
    const read = load();
    inFlight = read;
    void read
      .finally(() => {
        if (inFlight === read) inFlight = undefined;
      })
      .catch(() => undefined);
    return read;
  };
  app.get('/sessions', async (request): Promise<SessionSummary[] | SessionListEnvelope> => {
    const viewer = viewerId(request);
    const [all, views, scope] = await Promise.all([
      sharedLoad(),
      deps.store.viewState.sessionViews(viewer),
      deps.visibleTo?.(viewer) ?? Promise.resolve({ all: true as const }),
    ]);
    // A session of a project this person cannot read is not theirs to list.
    const shared = scope.all
      ? all
      : all.filter((summary) =>
          summary.projectId == null ? scope.unassigned : scope.projectIds.has(summary.projectId),
        );
    // The shared load may serve several people at once, so each answer gets its
    // own copies carrying the requester's read mark and dismissed Home items.
    // A session this person never touched is unread-neutral and hides nothing.
    const summaries = shared.map(({ planningPlan, ...summary }): SessionSummary => {
      const view = views.get(summary.sessionId);
      return {
        ...summary,
        // The plan text can run to pages and this route is polled by every
        // device; an overview only needs to know that a plan waits for approval.
        ...(summary.planning === 'active' && planningPlan != null
          ? { planningPresented: true as const }
          : {}),
        lastSeenEventCount: view?.lastSeenEventCount ?? null,
        inboxDismissed: view?.inboxDismissed ?? [],
      };
    });
    if ((request.query as { envelope?: unknown } | undefined)?.envelope !== '1') return summaries;
    // Server attention signals are the administrator's to act on.
    const attention =
      scope.all || scope.unassigned
        ? await measureLatencyPhase('session_attention', deps.collectAttention)
        : [];
    // Absent when healthy, so the envelope stays quiet in the steady state.
    return {
      sessions: summaries,
      sessionReordering: true,
      ...(attention.length > 0 ? { attention } : {}),
    };
  });
}
