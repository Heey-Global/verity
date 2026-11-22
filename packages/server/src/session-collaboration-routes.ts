import type { EventStore, ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from './server-context.js';

export type CollaborationDirection = 'asked' | 'askedBy' | 'handedOver';
export type CollaborationState = 'waitingForYou' | 'working' | 'answer' | 'done';

export interface CollaborationEntry {
  sessionId: string;
  sessionName: string | null;
  projectId: string;
  projectName: string;
  direction: CollaborationDirection;
  state: CollaborationState;
  updatedAt: string;
  /** `current` sits in the header row; `earlier` only in the sheet's Earlier section. */
  section: 'current' | 'earlier';
}

/** A finished entry stays in the header row this long. */
export const COLLABORATION_RECENT_MS = 24 * 60 * 60 * 1000;
/** A finished entry stays under Earlier this long, then it is dropped. */
export const COLLABORATION_EARLIER_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_RANK: Record<CollaborationState, number> = {
  waitingForYou: 0,
  working: 1,
  answer: 2,
  done: 3,
};

export interface SessionCollaborationDeps {
  store: Pick<
    EventStore,
    | 'getSession'
    | 'listProjects'
    | 'getEventsBeforeSeq'
    | 'listPendingSessionLinkMessages'
    | 'projectInquiries'
    | 'sessionCoordination'
  >;
  authorized(userId: string | null, projectId: string): Promise<boolean>;
  busy(sessionId: string): boolean;
  now?: () => number;
}

type Candidate = {
  peerSessionId: string;
  direction: CollaborationDirection;
  state: CollaborationState;
  at: number;
};

/**
 * The sessions this one works with, derived from what already happened: a
 * question or handover it made through coordination, and project inquiries in
 * either direction. Manual links alone are not collaboration and are not listed.
 */
export async function readSessionCollaboration(
  deps: SessionCollaborationDeps,
  sessionId: string,
  userId: string | null,
): Promise<CollaborationEntry[]> {
  const now = (deps.now ?? Date.now)();
  const { store } = deps;
  const [requests, inquiries, ownPending] = await Promise.all([
    store.sessionCoordination.listForSession(sessionId),
    store.projectInquiries.list(sessionId),
    store.listPendingSessionLinkMessages(sessionId),
  ]);
  const candidates: Candidate[] = [];
  for (const request of requests) {
    // A revoked link ended the collaboration; the peer's later work is its own.
    if (request.linkedAt === null) continue;
    const outgoing = request.sourceSessionId === sessionId;
    candidates.push({
      peerSessionId: outgoing ? request.targetSessionId : request.sourceSessionId,
      direction: !outgoing ? 'askedBy' : request.createdSession ? 'handedOver' : 'asked',
      state: 'done',
      at: request.linkedAt.getTime(),
    });
  }
  for (const inquiry of inquiries) {
    const outgoing = inquiry.sourceSessionId === sessionId;
    const state: CollaborationState =
      inquiry.status === 'pending'
        ? 'waitingForYou'
        : inquiry.status === 'approved' || inquiry.status === 'queued'
          ? 'working'
          : inquiry.status === 'answered' && outgoing
            ? 'answer'
            : 'done';
    candidates.push({
      peerSessionId: outgoing ? inquiry.targetSessionId : inquiry.sourceSessionId,
      direction: outgoing ? 'asked' : 'askedBy',
      state,
      at: Date.parse(inquiry.createdAt),
    });
  }
  // A message held for approval waits on this session's card.
  const waitingPeers = new Set(
    ownPending.filter((item) => item.approvedAt === null).map((item) => item.targetSessionId),
  );

  const merged = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (candidate.peerSessionId === sessionId) continue;
    const previous = merged.get(candidate.peerSessionId);
    if (!previous) {
      merged.set(candidate.peerSessionId, candidate);
      continue;
    }
    const preferred =
      STATE_RANK[candidate.state] < STATE_RANK[previous.state] ||
      (candidate.state === previous.state && candidate.at > previous.at)
        ? candidate
        : previous;
    merged.set(candidate.peerSessionId, { ...preferred, at: Math.max(previous.at, candidate.at) });
  }

  const projects = new Map<string, ProjectRecord>(
    (await store.listProjects()).map((project) => [project.id, project]),
  );
  const access = new Map<string, Promise<boolean>>();
  const allowed = (projectId: string) => {
    let decision = access.get(projectId);
    if (!decision) {
      decision = deps.authorized(userId, projectId);
      access.set(projectId, decision);
    }
    return decision;
  };
  // Read peers in parallel: the route is polled while the session screen is open.
  const resolved = await Promise.all(
    [...merged.values()].map(async (candidate): Promise<CollaborationEntry | null> => {
      const peer = await store.getSession(candidate.peerSessionId);
      const project = peer?.projectId ? projects.get(peer.projectId) : undefined;
      if (!peer || !project || !(await allowed(project.id))) return null;
      const latest = (await store.getEventsBeforeSeq(peer.sessionId, 1)).events[0]?.ts ?? 0;
      const at = Math.max(candidate.at, latest);
      let state = candidate.state;
      if (waitingPeers.has(peer.sessionId)) state = 'waitingForYou';
      else if (deps.busy(peer.sessionId)) state = 'working';
      const age = now - at;
      // An answer is news only for a day; after that it is simply done.
      if (state === 'answer' && age > COLLABORATION_RECENT_MS) state = 'done';
      if (state === 'done' && age > COLLABORATION_EARLIER_MS) return null;
      return {
        sessionId: peer.sessionId,
        sessionName: peer.name,
        projectId: project.id,
        projectName: project.name,
        direction: candidate.direction,
        state,
        updatedAt: new Date(at).toISOString(),
        section: state === 'done' && age > COLLABORATION_RECENT_MS ? 'earlier' : 'current',
      };
    }),
  );
  const entries = resolved.filter((entry): entry is CollaborationEntry => entry !== null);
  const waitingFirst = (entry: CollaborationEntry) => (entry.state === 'waitingForYou' ? 0 : 1);
  return entries.sort(
    (left, right) =>
      waitingFirst(left) - waitingFirst(right) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export function registerSessionCollaborationRoutes(
  app: FastifyInstance,
  deps: SessionCollaborationDeps,
): void {
  const params = z.object({ id: z.string().min(1).max(128) });
  app.get('/sessions/:id/collaboration', async (request, reply) => {
    const { id } = params.parse(request.params);
    const userId = (request as { localUserId?: string }).localUserId ?? null;
    const session = await deps.store.getSession(id);
    if (!session || (session.projectId && !(await deps.authorized(userId, session.projectId)))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    return { entries: await readSessionCollaboration(deps, id, userId) };
  });
}

/** Read-only: every entry comes from coordination and inquiry records already kept. */
export function installSessionCollaboration(
  app: FastifyInstance,
  ctx: ServerContext,
  wiring: { authorized(userId: string | null, projectId: string): Promise<boolean> },
): void {
  registerSessionCollaborationRoutes(app, {
    store: ctx.deps.eventStore,
    authorized: (userId, projectId) => wiring.authorized(userId, projectId),
    busy: (sessionId) => ctx.conductor.isBusy(sessionId),
  });
}
