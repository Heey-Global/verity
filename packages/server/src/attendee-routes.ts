import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AttendeeMeetings } from './attendee-meetings.js';

const params = z.object({ id: z.string(), meetingId: z.string().uuid() });
const edits = z.object({
  speakerNames: z.record(z.string(), z.string().max(200)).optional(),
  speakerCorrections: z
    .array(
      z
        .object({
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          speaker: z.number().int().nonnegative().nullable(),
        })
        .refine((item) => item.end > item.start),
    )
    .max(10_000)
    .optional(),
  speakerMerges: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

export function registerAttendeeRoutes(
  app: FastifyInstance,
  service: AttendeeMeetings,
  writable: () => boolean,
) {
  app.get('/settings/attendee', () => service.config());
  app.put('/settings/attendee', async (request, reply) => {
    if (!writable()) return reply.code(503).send({ error: 'Unlock the secret store first.' });
    const config = z
      .object({
        apiKey: z.string().trim().min(1).max(20_000),
        webhookSecret: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .min(24)
          .max(2000),
      })
      .nullable()
      .parse(request.body);
    return service.configure(config);
  });
  app.post('/settings/attendee/test', () => service.test());
  app.post('/sessions/:id/live-meetings/online', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ meetingUrl: z.url().max(2048), listenForVerity: z.boolean().default(false) })
      .parse(request.body);
    const url = new URL(body.meetingUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !['meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'zoom.us', 'www.zoom.us'].some(
        (host) =>
          url.hostname === host || (host === 'zoom.us' && url.hostname.endsWith('.zoom.us')),
      )
    )
      throw new Error('Enter a Google Meet, Teams or Zoom HTTPS meeting link.');
    return service.start(id, body.meetingUrl, body.listenForVerity);
  });
  app.post('/sessions/:id/live-meetings/:meetingId/online/stop', async (request) => {
    const { id, meetingId } = params.parse(request.params);
    return service.stop(id, meetingId);
  });
  app.patch('/sessions/:id/live-meetings/:meetingId/online/speakers', async (request) => {
    const { id, meetingId } = params.parse(request.params);
    return service.edit(id, meetingId, edits.parse(request.body));
  });
}
