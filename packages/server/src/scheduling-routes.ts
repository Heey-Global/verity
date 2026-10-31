// Scheduling request routes for the app: the request cards and the overview sheet read them,
// and the operator can revoke a request from its card. Creating and sending requests happens
// only through the agent tool and its approval card.
import type { EventStore, SchedulingRequest } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SchedulingService } from './scheduling-service.js';

const sessionParams = z.object({ id: z.string().min(1) });
const revokeParams = z.object({ requestId: z.string().uuid() });

interface SchedulingRequestView {
  id: string;
  sessionId: string;
  /** The project the request was prepared in; it decides who may see it. */
  projectId: string | null;
  state: SchedulingRequest['state'];
  title: string;
  durationMinutes: number;
  addGoogleMeet: boolean;
  timeZone: string;
  guest: { email: string; name: string | null };
  colleagues: { email: string; name?: string }[];
  closesAt: string;
  windows: { start: string; end: string; state: string }[];
  emailSentAt: string | null;
  booked: { start: string; end: string } | null;
  failure: string | null;
  /** Holds that could not be removed yet; the overview lists these first. */
  pendingCleanups: number;
  /** The guest's link including its PIN, while the link is served. Operator-only. */
  link: string | null;
  createdAt: string;
}

async function schedulingRequestView(
  store: Pick<EventStore, 'scheduling'>,
  service: Pick<SchedulingService, 'publicLink'>,
  request: SchedulingRequest,
): Promise<SchedulingRequestView> {
  const holds = await store.scheduling.holds(request.id);
  return {
    id: request.id,
    sessionId: request.sessionId,
    projectId: request.projectId,
    state: request.state,
    title: request.title,
    durationMinutes: request.durationMinutes,
    addGoogleMeet: request.addMeet,
    timeZone: request.timeZone,
    guest: { email: request.guestEmail, name: request.guestName },
    colleagues: request.colleagues,
    closesAt: request.closesAt.toISOString(),
    windows: holds.map((hold) => ({
      start: hold.windowStart.toISOString(),
      end: hold.windowEnd.toISOString(),
      state: hold.state,
    })),
    emailSentAt: request.emailSentAt?.toISOString() ?? null,
    booked:
      request.bookedStart && request.bookedEnd
        ? { start: request.bookedStart.toISOString(), end: request.bookedEnd.toISOString() }
        : null,
    failure: request.failure,
    pendingCleanups: holds.filter((hold) => hold.state === 'cancel_pending' && hold.attempts > 0)
      .length,
    link: request.state === 'open' ? ((await service.publicLink(request.id)) ?? null) : null,
    createdAt: request.createdAt.toISOString(),
  };
}

export function registerSchedulingRoutes(
  app: FastifyInstance,
  deps: { eventStore: EventStore; service: SchedulingService },
): void {
  const view = (request: SchedulingRequest) =>
    schedulingRequestView(deps.eventStore, deps.service, request);

  app.get('/sessions/:id/scheduling-requests', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if (!(await deps.eventStore.getSession(id))) {
      reply.code(404);
      return { error: `session ${id} not found` };
    }
    return {
      requests: await Promise.all((await deps.eventStore.scheduling.listForSession(id)).map(view)),
    };
  });

  /**
   * Whether the caller may see and steer a request: execute access to its project, because
   * the view carries the guest's link with its PIN. Requests outlive their session, so the
   * project they were made in decides, never the session.
   */
  const mayUse = async (userId: string | null, projectId: string | null): Promise<boolean> => {
    // No auth gate: the implicit administrator reaches every request.
    if (userId === null) return true;
    if (projectId === null) return deps.eventStore.isActiveAdministrator(userId);
    return deps.eventStore.hasProjectPermission(userId, projectId, 'execute');
  };

  // The overview across sessions, filtered to the requests the caller may use.
  app.get('/scheduling-requests', async (request) => {
    const usable = new Map<string | null, boolean>();
    const visible: SchedulingRequest[] = [];
    for (const stored of await deps.eventStore.scheduling.listRecent()) {
      if (!usable.has(stored.projectId))
        usable.set(stored.projectId, await mayUse(request.localUserId, stored.projectId));
      if (usable.get(stored.projectId)) visible.push(stored);
    }
    return { requests: await Promise.all(visible.map(view)) };
  });

  // The assistant's overview: requests of the projects granted to it and its own, still
  // filtered to what the caller may use. Every caller learns the assistant's session id, so
  // the app shows the overview there and nowhere else.
  app.get('/assistant/scheduling-requests', async (request) => {
    const settings = await deps.eventStore.assistant.settings();
    if (!settings.enabled || settings.session_id === null)
      return { assistantSessionId: null, requests: [] };
    // The same projects the assistant itself may use: granted, and neither hidden nor archived.
    const granted = new Set<string>();
    for (const grant of await deps.eventStore.assistant.grants()) {
      if (grant.mode === 'off') continue;
      const project = await deps.eventStore.getProject(grant.project_id);
      if (project && project.hiddenAt === null && !project.archived) granted.add(project.id);
    }
    const usable = new Map<string | null, boolean>();
    const visible: SchedulingRequest[] = [];
    for (const stored of await deps.eventStore.scheduling.listRecent()) {
      const own = stored.sessionId === settings.session_id;
      if (!own && (stored.projectId === null || !granted.has(stored.projectId))) continue;
      if (!usable.has(stored.projectId))
        usable.set(stored.projectId, await mayUse(request.localUserId, stored.projectId));
      if (usable.get(stored.projectId)) visible.push(stored);
    }
    return {
      assistantSessionId: settings.session_id,
      // Requests outlive their chat; the overview links to the chat only while it exists.
      requests: await Promise.all(
        visible.map(async (stored) => ({
          ...(await view(stored)),
          sessionAvailable: (await deps.eventStore.getSession(stored.sessionId)) !== undefined,
        })),
      ),
    };
  });

  // Also for requests whose session was deleted: they keep running until withdrawn.
  app.post('/scheduling-requests/:requestId/revoke', async (request, reply) => {
    const { requestId } = revokeParams.parse(request.params);
    const stored = await deps.eventStore.scheduling.get(requestId);
    if (!stored || !(await mayUse(request.localUserId, stored.projectId))) {
      reply.code(404);
      return { error: 'Scheduling request not found' };
    }
    try {
      return { request: await view(await deps.service.revoke(requestId)) };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : 'Could not revoke the request' };
    }
  });
}
