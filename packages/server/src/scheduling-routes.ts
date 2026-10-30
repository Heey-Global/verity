// Scheduling request routes for the app: the request cards and the overview sheet read them,
// and the operator can revoke a request from its card. Creating and sending requests happens
// only through the agent tool and its approval card.
import type { EventStore, SchedulingRequest } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SchedulingService } from './scheduling-service.js';

const sessionParams = z.object({ id: z.string().min(1) });
const requestParams = z.object({ id: z.string().min(1), requestId: z.string().uuid() });

export interface SchedulingRequestView {
  id: string;
  sessionId: string;
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

export async function schedulingRequestView(
  store: Pick<EventStore, 'scheduling'>,
  service: Pick<SchedulingService, 'publicLink'>,
  request: SchedulingRequest,
): Promise<SchedulingRequestView> {
  const holds = await store.scheduling.holds(request.id);
  return {
    id: request.id,
    sessionId: request.sessionId,
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

  // Across sessions for the overview sheet; administrators only (no member rule is declared).
  app.get('/scheduling-requests', async () => ({
    requests: await Promise.all((await deps.eventStore.scheduling.listRecent()).map(view)),
  }));

  app.post('/sessions/:id/scheduling-requests/:requestId/revoke', async (request, reply) => {
    const { id, requestId } = requestParams.parse(request.params);
    try {
      return { request: await view(await deps.service.revoke(requestId, id)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not revoke the request';
      reply.code(message === 'Scheduling request not found' ? 404 : 409);
      return { error: message };
    }
  });
}
