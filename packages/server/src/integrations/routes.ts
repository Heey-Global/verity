import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IntegrationEvent, IntegrationStore } from '@verity/store';
import { z } from 'zod';
import { affectedChatDay, projectChatDay } from './knowledge-projection.js';

function hasNoControls(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}
const identifier = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => hasNoControls(value) && !/\s/u.test(value));
const displayName = z.string().min(1).max(160).refine(hasNoControls);
const account = z
  .object({
    id: identifier,
    endpoint: z.url().startsWith('https://'),
    displayName,
    status: z.enum(['online', 'offline', 'error']),
    lastError: z.string().max(500).nullable().optional(),
  })
  .strict();
const source = z
  .object({
    accountId: identifier,
    sourceId: identifier,
    displayName,
    inviter: identifier.nullable().optional(),
  })
  .strict();
const event = z
  .object({
    accountId: identifier,
    sourceId: identifier,
    eventId: identifier,
    targetEventId: identifier.nullable(),
    kind: z.enum(['message', 'edit', 'redaction']),
    sender: identifier,
    occurredAt: z.iso.datetime({ offset: true }),
    body: z.string().max(16_384).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'message' && (value.body === null || value.targetEventId !== null)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid message event' });
    }
    if (value.kind !== 'message' && value.targetEventId === null) {
      ctx.addIssue({ code: 'custom', message: 'Change requires target event' });
    }
    if (value.kind === 'redaction' && value.body !== null) {
      ctx.addIssue({ code: 'custom', message: 'Redaction must not contain text' });
    }
  });

function authorized(request: FastifyRequest, token: string | undefined): boolean {
  if (!token || token.length < 32) return false;
  const candidate = request.headers.authorization;
  if (!candidate?.startsWith('Bearer ')) return false;
  const left = createHash('sha256').update(candidate.slice(7)).digest();
  const right = createHash('sha256').update(token).digest();
  return timingSafeEqual(left, right);
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: { store: IntegrationStore; dataRoot?: string; connectorToken?: string },
): void {
  const { store } = deps;
  void app.register((instance, _options, done) => {
    instance.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError)
        return reply.code(400).send({ error: 'Invalid integration request' });
      throw error;
    });

    // These routes inherit paired-device auth from the server-wide gate.
    instance.get('/integrations', async () => ({
      accounts: await store.listAccounts(),
      sources: await store.listSources(),
    }));
    instance.get('/integrations/matrix/config', async () => {
      return { config: await store.matrixConfigSummary() };
    });
    instance.put('/integrations/matrix/config', async (request, reply) => {
      const input = z
        .object({
          endpoint: z.url().startsWith('https://'),
          username: identifier,
          password: z.string().min(1).max(1024),
        })
        .strict()
        .parse(request.body);
      try {
        await store.saveMatrixConfig(input);
      } catch (error) {
        return reply
          .code(409)
          .send({ error: error instanceof Error ? error.message : 'Cannot save Matrix account' });
      }
      return { config: await store.matrixConfigSummary() };
    });
    instance.get('/projects/:id/integrations', async (request) => {
      const { id } = z.object({ id: identifier }).parse(request.params);
      return { sources: await store.listSources(id) };
    });
    instance.post('/integrations/sources/bind', async (request, reply) => {
      const input = source
        .pick({ accountId: true, sourceId: true })
        .extend({ projectId: identifier })
        .strict()
        .parse(request.body);
      try {
        const bound = await store.setSourceBinding(
          input.accountId,
          input.sourceId,
          input.projectId,
        );
        if (!bound) return reply.code(404).send({ error: 'Room invitation not found' });
        return { source: bound };
      } catch (error) {
        return reply
          .code(409)
          .send({ error: error instanceof Error ? error.message : 'Cannot connect room' });
      }
    });
    instance.post('/integrations/sources/pause', async (request) => {
      const input = source
        .pick({ accountId: true, sourceId: true })
        .extend({ paused: z.boolean() })
        .strict()
        .parse(request.body);
      await store.setSourcePaused(input.accountId, input.sourceId, input.paused);
      return { ok: true };
    });
    instance.post('/integrations/sources/disconnect', async (request, reply) => {
      const input = source.pick({ accountId: true, sourceId: true }).strict().parse(request.body);
      const deleted = await store.deleteSource(input.accountId, input.sourceId);
      if (!deleted) return reply.code(404).send({ error: 'Room not found' });
      return { ok: true };
    });

    // The worker credential can only report its account, discover rooms, read its
    // bindings, and submit events. It cannot choose a project or access Knowledge.
    const workerOnly = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
      if (!authorized(request, deps.connectorToken)) {
        return reply.code(401).send({ error: 'Unauthorized connector' });
      }
    };
    instance.get('/internal/integrations/matrix/config', { preHandler: workerOnly }, async () => ({
      config: await store.matrixConfigForWorker(),
    }));
    instance.get(
      '/internal/integrations/matrix/bindings',
      { preHandler: workerOnly },
      async (request) => {
        const { accountId } = z.object({ accountId: identifier }).strict().parse(request.query);
        return {
          sources: (await store.listSources()).filter(
            (item) => item.accountId === accountId && item.projectId !== null,
          ),
        };
      },
    );
    instance.post(
      '/internal/integrations/matrix/account',
      { preHandler: workerOnly },
      async (request) => {
        const input = account.parse(request.body);
        await store.upsertAccount({ ...input, provider: 'matrix' });
        return { ok: true };
      },
    );
    instance.post(
      '/internal/integrations/matrix/source',
      { preHandler: workerOnly },
      async (request) => {
        await store.discoverSource(source.parse(request.body));
        return { ok: true };
      },
    );
    instance.post(
      '/internal/integrations/matrix/event',
      { preHandler: workerOnly, bodyLimit: 32_768 },
      async (request, reply) => {
        const parsed = event.parse(request.body);
        if (!deps.dataRoot) return reply.code(503).send({ error: 'Knowledge storage unavailable' });
        const input: IntegrationEvent = { ...parsed, occurredAt: new Date(parsed.occurredAt) };
        const target = input.targetEventId
          ? await store.getEvent(input.accountId, input.sourceId, input.targetEventId)
          : null;
        // Changes to unknown or non-message events are not useful Knowledge data.
        if (input.kind !== 'message' && target?.kind !== 'message') {
          return reply.code(422).send({ error: 'Target message not found' });
        }
        let result: { projectId: string; inserted: boolean };
        try {
          result = await store.ingestEvent(input);
        } catch (error) {
          return reply
            .code(409)
            .send({ error: error instanceof Error ? error.message : 'Room unavailable' });
        }
        const day = affectedChatDay(input, target);
        if (day) {
          const binding = (await store.listSources(result.projectId)).find(
            (item) => item.accountId === input.accountId && item.sourceId === input.sourceId,
          );
          if (!binding?.activatedAt) return reply.code(409).send({ error: 'Room binding changed' });
          await projectChatDay(store, deps.dataRoot, {
            accountId: input.accountId,
            sourceId: input.sourceId,
            projectId: result.projectId,
            displayName: binding.displayName,
            activatedAt: binding.activatedAt,
            day,
          });
          await store.markProjected(input.accountId, input.sourceId);
        }
        return { accepted: result.inserted };
      },
    );
    done();
  });
}
