// Live meetings that start before anyone chose a project (docs/attendee-live-meetings.md
// §Unassigned meetings). Verity joins first; the operator assigns the meeting to a project
// later, which creates a session there and publishes everything said so far, or discards it.
// Unassigned meetings are kept for a retention period after they end and then discarded.
import { createHash } from 'node:crypto';
import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  UnassignedMeetingNotFoundError,
  type AttendeeMeetings,
  type UnassignedOnlineMeeting,
} from './attendee-meetings.js';
import type { SpawnSession } from './session-create-route.js';

export const DEFAULT_UNASSIGNED_MEETING_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

const meetingParams = z.object({ meetingId: z.string().uuid() });
const assignBody = z.union([
  z.object({ projectId: z.string().min(1) }).strict(),
  z.object({ sessionId: z.string().min(1) }).strict(),
]);

type MeetingSource = Pick<AttendeeMeetings, 'unassigned' | 'assign' | 'discard'>;

export interface LiveMeetingIntakeDeps {
  store: EventStore;
  meetings: MeetingSource;
  spawn: SpawnSession;
  /** Whether the user may read the session; undefined user means no auth gate. */
  canReadSession: (userId: string | undefined, sessionId: string) => Promise<boolean>;
  log: { warn(obj: unknown, msg?: string): void };
  now?: () => number;
}

/** The session an assignment creates. Derived from meeting and project so a retried
 * request finds the session the first attempt created instead of creating another. */
export function assignedSessionId(meetingId: string, projectId: string): string {
  const digest = createHash('sha256').update(`live-meeting:${meetingId}:${projectId}`).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function retentionDays(
  store: Pick<EventStore, 'getVeritySettingsRaw'>,
): Promise<number> {
  const settings = await store.getVeritySettingsRaw();
  return settings?.unassignedMeetingRetentionDays ?? DEFAULT_UNASSIGNED_MEETING_RETENTION_DAYS;
}

/** Discards every unassigned meeting whose retention ended. A meeting still running has
 * no end yet and is never due. */
export async function discardExpiredUnassignedMeetings(
  deps: Pick<LiveMeetingIntakeDeps, 'store' | 'meetings' | 'log'> & { now: number },
): Promise<number> {
  const keepMs = (await retentionDays(deps.store)) * DAY_MS;
  let discarded = 0;
  for (const meeting of await deps.meetings.unassigned()) {
    if (meeting.endedAt === null || meeting.endedAt + keepMs > deps.now) continue;
    try {
      if (await deps.meetings.discard(meeting.id)) discarded += 1;
    } catch (err) {
      deps.log.warn({ err, meetingId: meeting.id }, 'unassigned meeting expiry failed');
    }
  }
  return discarded;
}

export function registerLiveMeetingIntakeRoutes(
  app: FastifyInstance,
  deps: LiveMeetingIntakeDeps,
): void {
  const now = deps.now ?? Date.now;
  const isAdministrator = async (userId: string | null): Promise<boolean> =>
    userId === null || (await deps.store.isActiveAdministrator(userId));

  // Running meetings for the floating meeting card: those in sessions the caller may read,
  // and, for administrators, the unassigned ones. Unassigned meetings belong to no project,
  // so like project-less sessions only administrators see them.
  app.get('/live-meetings/active', async (request) => {
    const userId = request.localUserId;
    const running = [];
    for (const meeting of await deps.store.liveMeetings.running()) {
      if (!(await deps.canReadSession(userId ?? undefined, meeting.sessionId))) continue;
      const session = await deps.store.getSession(meeting.sessionId);
      if (session === undefined) continue;
      running.push({
        ...meeting,
        sessionName: session.name,
        projectId: session.projectId,
      });
    }
    const unassigned: UnassignedOnlineMeeting[] = (await isAdministrator(userId))
      ? await deps.meetings.unassigned()
      : [];
    return { running, unassigned, retentionDays: await retentionDays(deps.store) };
  });

  // Assign to a project (creates a session named after the meeting) or to an existing
  // session ("Continue here" on a session's meeting screen).
  app.post('/live-meetings/unassigned/:meetingId/assign', async (request, reply) => {
    const { meetingId } = meetingParams.parse(request.params);
    const body = assignBody.parse(request.body);
    const meeting = (await deps.meetings.unassigned()).find((item) => item.id === meetingId);
    if (meeting === undefined) {
      reply.code(404);
      return { error: new UnassignedMeetingNotFoundError().message };
    }
    let sessionId: string;
    if ('sessionId' in body) {
      if ((await deps.store.getSession(body.sessionId)) === undefined) {
        reply.code(404);
        return { error: 'Session not found.' };
      }
      sessionId = body.sessionId;
    } else {
      sessionId = assignedSessionId(meetingId, body.projectId);
      const created = await deps.spawn(
        {
          projectId: body.projectId,
          sessionId,
          name: (meeting.title?.trim() || 'Online meeting').slice(0, 80),
        },
        request.log,
      );
      const result = created.result;
      if (!('sessionId' in result)) {
        reply.code(created.statusCode >= 400 ? created.statusCode : 409);
        return {
          error:
            'awaitingProvisioning' in result
              ? 'The project is starting. Try again in a moment.'
              : 'requiresConfirmation' in result
                ? 'The project needs attention before new sessions can start. Open it first.'
                : result.error,
        };
      }
    }
    try {
      await deps.meetings.assign(meetingId, sessionId);
    } catch (error) {
      if (error instanceof UnassignedMeetingNotFoundError) {
        reply.code(404);
        return { error: error.message };
      }
      reply.code(409);
      return { error: error instanceof Error ? error.message : 'Could not assign the meeting.' };
    }
    return { sessionId, meetingId };
  });

  app.delete('/live-meetings/unassigned/:meetingId', async (request, reply) => {
    const { meetingId } = meetingParams.parse(request.params);
    if (!(await deps.meetings.discard(meetingId))) {
      reply.code(404);
      return { error: new UnassignedMeetingNotFoundError().message };
    }
    return { discarded: true };
  });

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  const expire = () => {
    if (running) return;
    running = discardExpiredUnassignedMeetings({ ...deps, now: now() })
      .catch((err: unknown) => deps.log.warn({ err }, 'unassigned meeting expiry failed'))
      .finally(() => {
        running = undefined;
      });
  };
  app.addHook('onReady', () => {
    timer = setInterval(expire, EXPIRY_INTERVAL_MS);
    timer.unref();
    expire();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
