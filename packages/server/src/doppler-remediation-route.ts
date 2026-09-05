import type { EventStore } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { bearerToken, type AuthTokenRegistry } from './auth.js';

const projectParams = z.object({ id: z.string().min(1) });
const remediationBody = z.object({
  evidence: z.literal('external-credential-rotated'),
});

export interface DopplerRemediationRouteDeps {
  eventStore: Pick<EventStore, 'confirmLegacyDopplerCredentialRemediation'>;
  authRegistry?: Pick<AuthTokenRegistry, 'isEnabled' | 'resolveId'>;
}

/** Registers authenticated confirmation that a legacy credential was rotated externally. */
export function registerDopplerRemediationRoute(
  app: FastifyInstance,
  deps: DopplerRemediationRouteDeps,
): void {
  app.post('/projects/:id/doppler-legacy-remediation', async (request, reply) => {
    const registry = deps.authRegistry;
    const actorId = registry?.resolveId(bearerToken(request.headers.authorization));
    if (registry === undefined || !registry.isEnabled() || actorId === undefined) {
      reply.code(401);
      return { error: 'authenticated device identity is required' };
    }
    const { id } = projectParams.parse(request.params);
    const { evidence } = remediationBody.parse(request.body);
    const confirmed = await deps.eventStore.confirmLegacyDopplerCredentialRemediation({
      projectId: id,
      actorId,
      evidence,
      requestId: request.id,
    });
    if (!confirmed) {
      reply.code(404);
      return { error: 'no unresolved legacy Doppler credential exists for this project' };
    }
    reply.code(204);
    return undefined;
  });
}
