import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { sessionParams } from './session-route-schemas.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const meetingParams = sessionParams.extend({ meetingId: id });
const noteParams = meetingParams.extend({ noteId: id });
const commandParams = meetingParams.extend({ commandId: id });
const meetingBody = z.object({
  engine: z.enum(['apple-speech', 'apple-dictation', 'fluid-nemotron', 'fluid-parakeet']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  state: z.enum(['active', 'interrupted', 'ended']),
  transcript: z.string().max(1_000_000),
  captureStatus: z.enum(['preparing', 'downloading', 'listening', 'paused']),
  ownerToken: z.string().min(32).max(256),
  revision: z.number().int().positive(),
});
const ownerHash = (token: string) => createHash('sha256').update(token).digest('hex');
const noteBody = z.object({
  atSeconds: z.number().finite().nonnegative(),
  text: z.string().max(10_000),
  revision: z.number().int().positive(),
});

export function registerLiveMeetingRoutes(app: FastifyInstance, store: EventStore): void {
  app.get('/sessions/:id/live-meetings', async (request, reply) => {
    const { id: sessionId } = sessionParams.parse(request.params);
    if (!(await store.getSession(sessionId))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const { after } = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .parse(request.query);
    return store.liveMeetings.changes(sessionId, after);
  });

  app.put('/sessions/:id/live-meetings/:meetingId', async (request, reply) => {
    const { id: sessionId, meetingId } = meetingParams.parse(request.params);
    if (!(await store.getSession(sessionId))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const body = meetingBody.parse(request.body);
    const { ownerToken, ...meeting } = body;
    const accepted = await store.liveMeetings.putMeeting({
      id: meetingId,
      sessionId,
      ...meeting,
      ownerTokenHash: ownerHash(ownerToken),
    });
    if (!accepted) {
      reply.code(409);
      return { error: 'meeting owner or session mismatch' };
    }
    return { accepted: true };
  });

  app.get('/sessions/:id/live-meetings/:meetingId/commands', async (request, reply) => {
    const { id: sessionId, meetingId } = meetingParams.parse(request.params);
    const token = request.headers['x-meeting-owner-token'];
    const commands =
      typeof token === 'string'
        ? await store.liveMeetings.ownerCommands(sessionId, meetingId, ownerHash(token))
        : await store.liveMeetings.commands(sessionId, meetingId);
    if (!commands) {
      reply.code(404);
      return { error: 'meeting not found' };
    }
    return {
      commands,
      recorderOnline: await store.liveMeetings.recorderOnline(sessionId, meetingId),
    };
  });

  app.post('/sessions/:id/live-meetings/:meetingId/commands', async (request, reply) => {
    const { id: sessionId, meetingId } = meetingParams.parse(request.params);
    const { action } = z
      .object({ action: z.enum(['pause', 'resume', 'stop']) })
      .parse(request.body);
    const commandId = randomUUID();
    const result = await store.liveMeetings.requestCommand(sessionId, meetingId, commandId, action);
    if (result !== 'accepted') {
      reply.code(result === 'pending' ? 409 : 404);
      return { error: result };
    }
    return { commandId };
  });

  app.put('/sessions/:id/live-meetings/:meetingId/commands/:commandId', async (request, reply) => {
    const { id: sessionId, meetingId, commandId } = commandParams.parse(request.params);
    const { state, error } = z
      .object({ state: z.enum(['completed', 'failed']), error: z.string().max(1000).nullable() })
      .parse(request.body);
    const token = request.headers['x-meeting-owner-token'];
    const accepted =
      typeof token === 'string' &&
      (await store.liveMeetings.acknowledgeCommand(
        sessionId,
        meetingId,
        commandId,
        ownerHash(token),
        state,
        error,
      ));
    if (!accepted) {
      reply.code(404);
      return { error: 'command not found for meeting owner' };
    }
    return { accepted: true };
  });

  app.put('/sessions/:id/live-meetings/:meetingId/notes/:noteId', async (request, reply) => {
    const { id: sessionId, meetingId, noteId } = noteParams.parse(request.params);
    if (!(await store.getSession(sessionId))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const body = noteBody.parse(request.body);
    const accepted = await store.liveMeetings.putNote(sessionId, {
      id: noteId,
      meetingId,
      ...body,
    });
    if (!accepted) {
      reply.code(404);
      return { error: 'meeting not found in session' };
    }
    return { accepted: true };
  });
}
