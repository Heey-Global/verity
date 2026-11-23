import { measureLatencyPhase, type EventStore, type SessionRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import type { AttentionSignal } from './attention.js';
import type { SessionSummary, SessionListEnvelope } from './server-types.js';
import {
  addressedTo,
  addressRequests,
  viewerCodeRights,
  type RequestAddressing,
  type RequestAddressingDeps,
} from './session-request-addressees.js';
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
  /** Address each session's requests to a person (ADR 0023). Absent → every
   *  request is for everyone, as for the single operator. */
  requestAddressing?: RequestAddressingDeps;
}

interface SessionListLoad {
  summaries: SessionSummary[];
  addressing: ReadonlyMap<string, RequestAddressing>;
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
  let inFlight: Promise<SessionListLoad> | undefined;
  const load = async (): Promise<SessionListLoad> => {
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
    // Addressing only narrows Home; a failed rights check must not take the list
    // down for everyone, so it falls back to everything for everyone.
    const addressing = deps.requestAddressing
      ? await addressRequests(deps.requestAddressing, summaries).catch((error: unknown) => {
          app.log.warn({ err: error }, 'verity: could not address session requests');
          return new Map<string, RequestAddressing>();
        })
      : new Map<string, RequestAddressing>();
    return { summaries, addressing };
  };
  const sharedLoad = (): Promise<SessionListLoad> => {
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
    const [{ summaries: all, addressing }, views, scope] = await Promise.all([
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
    // Without accounts every request is the one operator's, so nothing is addressed.
    const personal =
      deps.requestAddressing !== undefined && request.localUserId != null
        ? { holdsCode: viewerCodeRights(deps.requestAddressing, viewer) }
        : undefined;
    const summaries = await Promise.all(
      shared.map(
        async ({
          planningPlan,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-omit
          requestInitiator,
          ...summary
        }): Promise<SessionSummary> => {
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
            ...(personal === undefined
              ? {}
              : await addressedTo(
                  viewer,
                  summary,
                  addressing.get(summary.sessionId),
                  personal.holdsCode,
                )),
          };
        },
      ),
    );
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
