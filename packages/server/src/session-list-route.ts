import { measureLatencyPhase, type EventStore, type SessionRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import type { AttentionSignal } from './attention.js';
import type { SessionSummary, SessionListEnvelope } from './server.js';

export interface SessionListRouteDeps {
  store: Pick<EventStore, 'listSessions' | 'sessionSortOrders' | 'linkedSessionIds'>;
  prunePrSummaryCache: (liveWorktrees: ReadonlySet<string>) => void;
  pruneBranchCache: (liveWorktrees: ReadonlySet<string>) => void;
  summarizeSessions: (sessions: SessionRecord[]) => Promise<SessionSummary[]>;
  collectAttention: () => Promise<AttentionSignal[]>;
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
  app.get('/sessions', async (request): Promise<SessionSummary[] | SessionListEnvelope> => {
    const sessions = await measureLatencyPhase('session_list', () => deps.store.listSessions());
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
    if ((request.query as { envelope?: unknown } | undefined)?.envelope !== '1') return summaries;
    const attention = await measureLatencyPhase('session_attention', deps.collectAttention);
    // Absent when healthy, so the envelope stays quiet in the steady state.
    return {
      sessions: summaries,
      sessionReordering: true,
      ...(attention.length > 0 ? { attention } : {}),
    };
  });
}
