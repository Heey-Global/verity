import { z } from 'zod';
import type { EventStore } from '@verity/store';
import { resolveGoogleServiceCredential } from './google-service-credentials.js';
import {
  SCHEDULING_LINK_PLACEHOLDER,
  SCHEDULING_MAX_BOOKING_DAYS,
  type SchedulingService,
} from './scheduling-service.js';
import { ControlPlaneSessionAuthorityError } from './session-handoff-tool.js';

const person = z
  .object({ email: z.string().email().max(320), name: z.string().min(1).max(200).optional() })
  .strict();
const requestId = z.string().uuid();

export const schedulingRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('prepare'),
      title: z.string().min(1).max(200),
      durationMinutes: z.number().int().min(5).max(480),
      windows: z
        .array(
          z
            .object({
              start: z.string().datetime({ offset: true }),
              end: z.string().datetime({ offset: true }),
            })
            .strict(),
        )
        .min(1)
        .max(10),
      guest: person,
      colleagues: z.array(person).max(10).default([]),
      addGoogleMeet: z
        .boolean()
        .describe('Ask the user whether to add Google Meet; never assume a default.'),
      calendarId: z.string().min(1).max(1024).default('primary'),
      timeZone: z.string().min(1).max(64),
      language: z.enum(['en', 'de']),
      bookingDays: z
        .number()
        .int()
        .min(1)
        .max(SCHEDULING_MAX_BOOKING_DAYS)
        .default(SCHEDULING_MAX_BOOKING_DAYS),
      organizerName: z.string().min(1).max(200),
      email: z
        .object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(10_000) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('send'), requestId, digest: z.string().regex(/^[0-9a-f]{64}$/u) })
    .strict(),
  z.object({ action: z.literal('status'), requestId }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('revoke'), requestId }).strict(),
]);
export type SchedulingToolRequest = z.infer<typeof schedulingRequestSchema>;

export const SCHEDULING_TOOL_DESCRIPTION = `Offer meeting times to one guest through a booking link. prepare checks the organizer's calendar, derives the start times (each window is cut into slots of durationMinutes from its start; a slot must fit completely) and stores a draft; nothing leaves Verity yet. Ask the user whether to add Google Meet before prepare. Use only email addresses supplied or confirmed by the user. Colleagues are invited to the holds and the final meeting; the guest only gets the link. The email body must contain ${SCHEDULING_LINK_PLACEHOLDER} where the link goes, and should not list times; omit email to use the default text. Show the user the prepared summary, then call send with the requestId and digest unchanged: the user approves the whole request at once (holds in the calendar, the email, booking the time the guest picks, and removing the remaining holds afterwards). After sending, Verity runs the request on its own until it is booked, expires (at most ${String(SCHEDULING_MAX_BOOKING_DAYS)} days) or is revoked. status reports one request, list this session's requests, revoke withdraws a request after approval.`;

/** Reads and drafts need no card; sending and revoking change calendars and mailboxes. */
export function schedulingHasStandingAuthorization(request: unknown): boolean {
  const parsed = schedulingRequestSchema.safeParse(request);
  return parsed.success && ['prepare', 'status', 'list'].includes(parsed.data.action);
}

interface Input {
  projectId: string;
  sessionId: string;
  request: unknown;
}

export function createSchedulingTool(deps: {
  store: Pick<EventStore, 'getSession' | 'getGoogleServiceCredentials' | 'scheduling'>;
  service: () => SchedulingService;
}) {
  const authorize = async (input: Input) => {
    const request = schedulingRequestSchema.parse(input.request);
    const session = await deps.store.getSession(input.sessionId);
    if (session?.projectId !== input.projectId)
      throw new ControlPlaneSessionAuthorityError(
        'Scheduling is restricted to the calling session',
      );
    await resolveGoogleServiceCredential(deps.store, input.sessionId, 'calendar');
    if (request.action === 'prepare' || request.action === 'send')
      await resolveGoogleServiceCredential(deps.store, input.sessionId, 'gmail');
    return request;
  };

  /** The approval card's content: the stored draft, never the agent's own description of it. */
  const presentation = async (input: Input): Promise<Record<string, unknown> | undefined> => {
    const parsed = schedulingRequestSchema.safeParse(input.request);
    if (!parsed.success || (parsed.data.action !== 'send' && parsed.data.action !== 'revoke'))
      return undefined;
    const summary = await deps.service().approvalSummary(parsed.data.requestId, input.sessionId);
    return summary ? { scheduling: summary } : undefined;
  };

  const invoke = async (input: Input): Promise<unknown> => {
    const request = await authorize(input);
    const service = deps.service();
    switch (request.action) {
      case 'prepare': {
        const prepared = await service.prepare({
          sessionId: input.sessionId,
          projectId: input.projectId,
          title: request.title,
          durationMinutes: request.durationMinutes,
          windows: request.windows,
          guest: request.guest,
          colleagues: request.colleagues,
          addGoogleMeet: request.addGoogleMeet,
          calendarId: request.calendarId,
          timeZone: request.timeZone,
          language: request.language,
          bookingDays: request.bookingDays,
          organizerName: request.organizerName,
          email: request.email,
        });
        return {
          ...prepared,
          note: 'Nothing has been sent. Show this summary to the user, then call send with requestId and digest unchanged.',
        };
      }
      case 'send':
        return service.send(request.requestId, input.sessionId, request.digest);
      case 'status': {
        const stored = await deps.store.scheduling.get(request.requestId);
        if (!stored || stored.sessionId !== input.sessionId)
          throw new Error('Scheduling request not found');
        return service.summarize(stored, await deps.store.scheduling.holds(stored.id));
      }
      case 'list':
        return {
          requests: (await deps.store.scheduling.listForSession(input.sessionId)).map((stored) => ({
            requestId: stored.id,
            state: stored.state,
            title: stored.title,
            guest: stored.guestEmail,
            closesAt: stored.closesAt.toISOString(),
            ...(stored.bookedStart ? { bookedStart: stored.bookedStart.toISOString() } : {}),
          })),
        };
      case 'revoke': {
        const revoked = await service.revoke(request.requestId, input.sessionId);
        return { requestId: revoked.id, state: revoked.state };
      }
    }
  };

  return { authorize, presentation, invoke };
}
