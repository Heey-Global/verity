import { secretContractIdSchema, secretToolInvocationSchema } from '@verity/secret-contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  SecretAuthorizationRejectedError,
  type AuthenticatedApprovalActor,
} from './secret-authorization.js';
import { SecretJobRejectedError } from './secret-job-executor.js';
import { SecretJobFrameSpoolError } from './secret-job-frame-spool.js';
import { SecretJobServiceRejectedError, type SecretJobService } from './secret-job-service.js';

const decisionBodySchema = z.discriminatedUnion('approved', [
  z.object({ approved: z.literal(false) }).strict(),
  z
    .object({
      approved: z.literal(true),
      jobId: secretContractIdSchema,
      absoluteDeadline: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
const framesQuerySchema = z
  .object({ nextSequence: z.coerce.number().int().nonnegative().optional() })
  .strict();

/** Register the authenticated transport adapter around the transport-neutral Secret Job service. */
export function registerSecretJobRoutes(
  app: FastifyInstance,
  service: SecretJobService,
  authenticate: (authorizationHeader: string | undefined) => AuthenticatedApprovalActor | undefined,
): void {
  const internalError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    request.log.error({ err: error }, 'Secret Job request failed');
    return reply.code(500).send({ error: 'internal server error' });
  };
  app.post('/secret-jobs/requests', async (request, reply) => {
    const actor = authenticate(request.headers.authorization);
    if (actor === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = secretToolInvocationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid secret job request' });
    try {
      return reply.code(202).send(await service.request(parsed.data, actor));
    } catch (error) {
      if (error instanceof SecretAuthorizationRejectedError) {
        return reply.code(403).send({ error: 'secret job request rejected' });
      }
      if (error instanceof SecretJobServiceRejectedError) {
        return reply.code(403).send({ error: 'secret job request rejected' });
      }
      return internalError(request, reply, error);
    }
  });

  app.post('/secret-jobs/approvals/:approvalId/decision', async (request, reply) => {
    const actor = authenticate(request.headers.authorization);
    if (actor === undefined) return reply.code(401).send({ error: 'unauthorized' });
    const params = z.object({ approvalId: secretContractIdSchema }).safeParse(request.params);
    const body = decisionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid secret job decision' });
    }
    try {
      const result = await service.decideAndStart({
        approvalId: params.data.approvalId,
        actor,
        ...body.data,
      });
      return reply.code(result.decision === 'approved' ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof SecretJobServiceRejectedError) {
        return reply.code(409).send({ error: 'secret job decision rejected' });
      }
      if (error instanceof SecretAuthorizationRejectedError) {
        return reply.code(403).send({ error: 'secret job decision rejected' });
      }
      return internalError(request, reply, error);
    }
  });

  app.get('/secret-jobs/:jobId', async (request, reply) => {
    const actor = authenticate(request.headers.authorization);
    if (actor === undefined) return reply.code(401).send({ error: 'unauthorized' });
    const params = z.object({ jobId: secretContractIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid secret job id' });
    try {
      const status = await service.status(params.data.jobId, actor);
      return status === undefined
        ? reply.code(404).send({ error: 'secret job not found' })
        : reply.send(status);
    } catch (error) {
      return internalError(request, reply, error);
    }
  });

  app.get('/secret-jobs/:jobId/frames', async (request, reply) => {
    const actor = authenticate(request.headers.authorization);
    if (actor === undefined) return reply.code(401).send({ error: 'unauthorized' });
    const params = z.object({ jobId: secretContractIdSchema }).safeParse(request.params);
    const query = framesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: 'invalid secret job frame request' });
    }
    try {
      return reply.send(
        await service.readFrames(params.data.jobId, actor, query.data.nextSequence),
      );
    } catch (error) {
      if (error instanceof SecretJobServiceRejectedError) {
        return reply.code(404).send({ error: 'secret job not found' });
      }
      if (error instanceof SecretJobFrameSpoolError) {
        return reply.code(400).send({ error: 'secret job frames unavailable' });
      }
      return internalError(request, reply, error);
    }
  });

  app.post('/secret-jobs/:jobId/cleanup', async (request, reply) => {
    const actor = authenticate(request.headers.authorization);
    if (actor === undefined) return reply.code(401).send({ error: 'unauthorized' });
    const params = z.object({ jobId: secretContractIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid secret job id' });
    try {
      return reply.send(await service.cleanup(params.data.jobId, actor));
    } catch (error) {
      if (
        error instanceof SecretJobServiceRejectedError ||
        error instanceof SecretJobRejectedError
      ) {
        return reply.code(404).send({ error: 'secret job not found' });
      }
      return internalError(request, reply, error);
    }
  });
}
