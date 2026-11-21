import type { FastifyRequest } from 'fastify';
import { requestCredential } from './auth.js';
import { authorizePairedRoute } from './paired-route-policy.js';
import type { ServerDeps } from './server-deps.js';

export function createMcpAppAuthorization(deps: Pick<ServerDeps, 'authRegistry' | 'eventStore'>) {
  return {
    async authorizeRequest(request: FastifyRequest): Promise<boolean> {
      const registry = deps.authRegistry;
      if (registry === undefined || !registry.isEnabled()) return true;
      const token = requestCredential(request);
      const userId = registry.resolveUserId(token);
      if (!registry.verify(token) || userId === undefined || userId !== request.localUserId)
        return false;
      return (
        (await authorizePairedRoute(
          deps.eventStore,
          userId,
          request.method,
          request.routeOptions.url ?? request.url,
          (request.params ?? {}) as Record<string, unknown>,
        )) === 'allow'
      );
    },
    captureDocumentAccess(request: FastifyRequest): () => Promise<boolean> {
      // Retain only the identity needed for revalidation, not the HTTP request.
      const token = requestCredential(request);
      const userId = request.localUserId;
      const { id, appId } = request.params as { id: string; appId: string };
      return async () => {
        const registry = deps.authRegistry;
        if (registry === undefined || !registry.isEnabled()) return true;
        if (!registry.verify(token) || !userId || registry.resolveUserId(token) !== userId)
          return false;
        return (
          (await authorizePairedRoute(
            deps.eventStore,
            userId,
            'GET',
            '/sessions/:id/mcp-apps/:appId',
            { id, appId },
          )) === 'allow'
        );
      };
    },
  };
}
