import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProjectEgressError, type ProjectEgressStore } from '@verity/store';
import { isPublicEgressTarget } from './project-egress-policy.js';

const params = z.object({ id: z.string().min(1) });
const target = z
  .object({
    host: z.string().min(1).max(253),
    protocol: z.enum(['tcp', 'udp']),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
const decision = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    allow: z.boolean(),
  })
  .strict();
const reopen = z.object({ target, revision: z.number().int().nonnegative() }).strict();
const revoke = z
  .object({ grantId: z.string().uuid(), revision: z.number().int().nonnegative() })
  .strict();

/** Draft management only. There is intentionally no protected-mode activation endpoint. */
export function registerProjectEgressRoutes(app: FastifyInstance, store: ProjectEgressStore): void {
  const user = (request: FastifyRequest): string => {
    if (!request.localUserId) throw new ProjectEgressError('forbidden');
    return request.localUserId;
  };
  app.register((app, _options, done) => {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectEgressError) {
        const status = { invalid: 400, forbidden: 403, missing: 404, stale: 409, capacity: 429 }[
          error.code
        ];
        return reply.code(status).send({ error: error.code });
      }
      if (error instanceof z.ZodError)
        return reply.code(400).send({ error: 'invalid egress input' });
      throw error;
    });
    app.get('/projects/:id/egress', async (request) => ({
      enforcement: 'unavailable',
      policy: await store.read(params.parse(request.params).id, user(request)),
    }));
    app.post('/projects/:id/egress/requests', async (request) => {
      const input = target.parse(request.body);
      if (!isPublicEgressTarget(input)) throw new ProjectEgressError('invalid');
      return {
        enforcement: 'unavailable',
        request: await store.request(params.parse(request.params).id, user(request), input),
      };
    });
    app.post('/projects/:id/egress/decisions', async (request) => {
      const input = decision.parse(request.body);
      return {
        enforcement: 'unavailable',
        request: await store.decide(
          params.parse(request.params).id,
          user(request),
          input.requestId,
          input.revision,
          input.allow,
        ),
      };
    });
    app.post('/projects/:id/egress/reopen', async (request) => {
      const input = reopen.parse(request.body);
      if (!isPublicEgressTarget(input.target)) throw new ProjectEgressError('invalid');
      return {
        enforcement: 'unavailable',
        request: await store.reopen(
          params.parse(request.params).id,
          user(request),
          input.target,
          input.revision,
        ),
      };
    });
    app.post('/projects/:id/egress/revoke', async (request) => {
      const input = revoke.parse(request.body);
      await store.revoke(
        params.parse(request.params).id,
        user(request),
        input.grantId,
        input.revision,
      );
      return { enforcement: 'unavailable' };
    });
    app.post('/projects/:id/egress/permanent', async (request) => {
      const input = reopen.parse(request.body);
      if (!isPublicEgressTarget(input.target)) throw new ProjectEgressError('invalid');
      return {
        enforcement: 'unavailable',
        grant: await store.setPermanent(
          params.parse(request.params).id,
          user(request),
          input.target,
          input.revision,
        ),
      };
    });
    app.post('/projects/:id/egress/remove-request', async (request) => {
      const input = z
        .object({ requestId: z.string().uuid(), revision: z.number().int().nonnegative() })
        .strict()
        .parse(request.body);
      await store.removeRequest(
        params.parse(request.params).id,
        user(request),
        input.requestId,
        input.revision,
      );
      return { enforcement: 'unavailable' };
    });
    done();
  });
}
