import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  internalConnectionIdentity,
  type InternalConnectionIdentity,
} from './internal-listener.js';

const query = z.strictObject({
  name: z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
  type: z.enum(['A', 'AAAA']),
});

/**
 * The relay's controlled DNS answerer under the project fence. Identity comes only
 * from the project-bound socket; the answer is exactly what the host admitted for
 * this generation, so a name without a current direct grant resolves to nothing.
 */
export function registerProjectDnsRoute(
  app: FastifyInstance,
  deps: {
    resolveDirect?:
      | ((
          identity: InternalConnectionIdentity,
          name: string,
        ) => Promise<{ addresses: readonly string[]; ttlSeconds: number } | undefined>)
      | undefined;
  },
): void {
  const resolveDirect = deps.resolveDirect;
  if (!resolveDirect) return;
  app.post('/internal/dns', async (request, reply) => {
    const identity = internalConnectionIdentity(request);
    if (!identity) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = query.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid name query' });
    const family = parsed.data.type === 'A' ? 4 : 6;
    let answer: Awaited<ReturnType<typeof resolveDirect>>;
    try {
      answer = await resolveDirect(identity, parsed.data.name);
    } catch {
      // Unknown host state answers nothing rather than an unverified address.
      return reply.code(503).send({ error: 'name authority unavailable' });
    }
    // `granted` distinguishes a refused name from a granted name without this family.
    return {
      granted: answer !== undefined,
      addresses: (answer?.addresses ?? []).filter((address) => isIP(address) === family),
      ttlSeconds: answer?.ttlSeconds ?? 1,
    };
  });
}
