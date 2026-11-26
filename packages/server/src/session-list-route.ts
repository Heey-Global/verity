import { conditionalJsonRoute } from './conditional-json.js';
import { planningPresented } from './session-row.js';
import { measureLatencyPhase, type EventStore, type SessionRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import type { AttentionSignal } from './attention.js';
import {
  openSubmissionViews,
  submissionAddressedTo,
  type ChangeSubmissionStore,
  type ChangeSubmissionView,
  type SubmissionListDeps,
} from './change-submissions.js';
import type { SessionSummary, SessionListEnvelope } from './server-types.js';
import {
  addressedTo,
  addressRequests,
  holdsCode,
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
  /** Changes members submitted for review (ADR 0023). Absent → none listed. */
  changeSubmissions?: SubmissionListDeps;
}

interface SessionListLoad {
  summaries: SessionSummary[];
  addressing: ReadonlyMap<string, RequestAddressing>;
  submissions: ReadonlyMap<string, ChangeSubmissionView>;
}

/**
 * Sessions as one person's lists show them: every session they may see, or
 * those of one project. `/sessions` and the project page both answer with it,
 * so the app's one copy of a session (ADR 0033) has the same fields whichever
 * list read it last, and both leave out the same sessions.
 */
export type SessionListReader = (
  localUserId: string | null | undefined,
  projectId?: string,
) => Promise<SessionSummary[]>;

export function registerSessionListRoute(
  app: FastifyInstance,
  deps: SessionListRouteDeps,
): SessionListReader {
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
  // One project's sessions (the project page) are loaded on their own; only
  // the full list knows which worktrees are gone from the caches.
  const load = async (projectId?: string): Promise<SessionListLoad> => {
    const [all, hidden] = await Promise.all([
      measureLatencyPhase('session_list', () => deps.store.listSessions()),
      deps.hiddenSessionIds?.(),
    ]);
    const sessions = all.filter(
      (session) =>
        !hidden?.has(session.sessionId) &&
        (projectId === undefined || session.projectId === projectId),
    );
    if (projectId === undefined) {
      const liveWorktrees = new Set(sessions.map((s) => s.worktree));
      deps.prunePrSummaryCache(liveWorktrees);
      deps.pruneBranchCache(liveWorktrees);
    }
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
    // Like addressing, a failed read leaves the list up without submissions.
    const submissions = deps.changeSubmissions
      ? await openSubmissionViews(deps.changeSubmissions, summaries).catch((error: unknown) => {
          app.log.warn({ err: error }, 'verity: could not read change submissions');
          return new Map<string, ChangeSubmissionView>();
        })
      : new Map<string, ChangeSubmissionView>();
    return { summaries, addressing, submissions };
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
  const listAs = async (localUserId: string | null | undefined, projectId?: string) => {
    const viewer = viewerId({ localUserId });
    const [{ summaries: all, addressing, submissions }, views, scope] = await Promise.all([
      projectId === undefined ? sharedLoad() : load(projectId),
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
      deps.requestAddressing !== undefined && localUserId != null
        ? { holdsCode: viewerCodeRights(deps.requestAddressing, viewer) }
        : undefined;
    const reviewers = new Map<string | null, Promise<boolean>>();
    const reviewerRights = (store: ChangeSubmissionStore, sessionProject: string | null) => {
      let held = reviewers.get(sessionProject);
      if (held === undefined) {
        held = holdsCode(store, viewer, sessionProject).catch(() => false);
        reviewers.set(sessionProject, held);
      }
      return held;
    };
    const submissionFor = async (
      summary: SessionSummary,
    ): Promise<Pick<SessionSummary, 'changeSubmission'>> => {
      const view = submissions.get(summary.sessionId);
      if (view === undefined) return {};
      if (personal === undefined || deps.changeSubmissions === undefined)
        return { changeSubmission: view };
      // Unlike a permission prompt, a review is only offered on confirmed Code.
      const holds = await reviewerRights(deps.changeSubmissions.store, summary.projectId);
      return {
        changeSubmission: {
          ...view,
          addressedToViewer: submissionAddressedTo(viewer, view, holds),
        },
      };
    };
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
            ...planningPresented({ planning: summary.planning, planningPlan }),
            lastSeenEventCount: view?.lastSeenEventCount ?? null,
            inboxDismissed: view?.inboxDismissed ?? [],
            ...(await submissionFor(summary)),
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
    return { summaries, scope };
  };
  app.get(
    '/sessions',
    conditionalJsonRoute,
    async (request): Promise<SessionSummary[] | SessionListEnvelope> => {
      const { summaries, scope } = await listAs(request.localUserId);
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
    },
  );
  return async (localUserId, projectId) => (await listAs(localUserId, projectId)).summaries;
}
