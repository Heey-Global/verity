import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './auth.js';
import type { DependencyCapacity } from './dependency-capacity.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import {
  internalConnectionIdentity,
  internalConnectionGenerationSignal,
} from './internal-listener.js';

const common = {
  version: z.literal(1),
  sessionId: z.string().min(1).max(256),
  id: z.uuid().transform((id) => id.toLowerCase()),
};
const requestSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...common,
      action: z.literal('reserve'),
      kind: z.enum(['dependency-copy', 'dependency-prepare', 'dependency-private']),
      bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      inodes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ ...common, action: z.enum(['start', 'status', 'settle']) }).strict(),
]);

export function registerDependencyCapacityRoute(
  app: FastifyInstance,
  deps: {
    capabilities?: GhTokenCapabilityRegistry;
    capacity?: DependencyCapacity;
    store: Pick<EventStore, 'getSession'>;
  },
): void {
  if (!deps.capabilities || !deps.capacity) return;
  const { capabilities, capacity } = deps;
  app.post('/internal/dependency-storage', async (request, reply) => {
    const token = bearerToken(request.headers.authorization) ?? '';
    const binding = token ? await capabilities.resolve(token) : undefined;
    const socket = internalConnectionIdentity(request);
    if (
      !binding ||
      !socket ||
      socket.projectId !== binding.projectId ||
      socket.userId !== binding.userId ||
      socket.containerGeneration !== binding.containerGeneration
    )
      return reply.code(401).send({ error: 'unauthorized' });
    const generation = internalConnectionGenerationSignal(request);
    const authorized = async () => {
      if (generation?.aborted) return false;
      const current = await capabilities.resolve(token);
      return (
        !generation?.aborted &&
        current?.projectId === binding.projectId &&
        current.userId === binding.userId &&
        current.containerGeneration === binding.containerGeneration
      );
    };
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid dependency capacity request' });
    const session = await deps.store.getSession(parsed.data.sessionId);
    if (!session || session.projectId !== binding.projectId)
      return reply.code(404).send({ error: 'session not found in this project' });
    if (!(await authorized())) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const result = await capacity.request(
        {
          projectId: binding.projectId,
          userId: binding.userId,
          sessionId: session.sessionId,
          containerGeneration: binding.containerGeneration,
        },
        parsed.data,
      );
      // A revoked generation receives no start acknowledgement. Its persisted
      // reservation remains until the broker proves all inherited holders ended.
      if (!(await authorized())) return reply.code(401).send({ error: 'unauthorized' });
      return result;
    } catch (error) {
      // Capacity errors contain amounts and fixed explanations, never credentials
      // or arbitrary remote stderr. Unknown implementations stay a generic failure.
      const message =
        error instanceof Error &&
        /^(?:Dependency capacity|Build storage admission|Storage reservation)/u.test(error.message)
          ? error.message
          : 'Dependency capacity unavailable; existing data and uncertain reservations are preserved.';
      return reply.code(409).send({ error: message });
    }
  });
}
