import type { FastifyInstance } from 'fastify';
import {
  PROJECT_MEMORY_MAX_CHARS,
  ProjectMemoryTooLargeError,
  type EventStore,
} from '@verity/store';
import { bearerToken } from './auth.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { internalConnectionIdentity } from './internal-listener.js';

export interface ProjectMemoryRouteDeps {
  store: Pick<EventStore, 'appendProjectMemory'>;
  capabilities?: GhTokenCapabilityRegistry | undefined;
}

/** Registers the project-bound memory append broker. */
export function registerProjectMemoryRoute(
  app: FastifyInstance,
  deps: ProjectMemoryRouteDeps,
): void {
  // `POST /internal/project/memory` — called by the sandbox's `verity-memory`
  // wrapper, NOT the operator (ADR 0008). Like the gh-token broker it is pre-auth
  // allowlisted and authenticates with the per-container CAPABILITY, and the server
  // resolves that capability to its server-side project binding — the sandbox never
  // names the project, so a container can only append to ITS OWN project's memory,
  // and only from inside the internal network the origin guard enforces. Gated on
  // capability resolution alone (no token-mint needed), so it works in any
  // capability-provisioned deployment.
  if (deps.capabilities !== undefined) {
    const ghTokenCapabilities = deps.capabilities;
    app.post(
      '/internal/project/memory',
      async (request, reply): Promise<{ ok: true; length: number } | { error: string }> => {
        const presented = bearerToken(request.headers.authorization) ?? '';
        const binding = presented === '' ? undefined : await ghTokenCapabilities.resolve(presented);
        const socketIdentity = internalConnectionIdentity(request);
        if (
          binding === undefined ||
          socketIdentity === undefined ||
          socketIdentity.projectId !== binding.projectId ||
          socketIdentity.containerGeneration !== binding.containerGeneration
        ) {
          reply.code(401);
          return { error: 'unauthorized' };
        }
        const body = request.body as { text?: unknown } | null | undefined;
        const text = typeof body?.text === 'string' ? body.text : undefined;
        if (text === undefined) {
          reply.code(400);
          return { error: 'expected a JSON body with a string "text" field' };
        }
        try {
          const settings = await deps.store.appendProjectMemory(binding.projectId, text);
          if (settings === undefined) {
            // Capability resolved but the project row is gone (deprovisioned mid-flight).
            reply.code(404);
            return { error: 'project not found' };
          }
          request.log.info(
            { projectId: binding.projectId, length: settings.memory?.length ?? 0 },
            'verity: appended project memory',
          );
          return { ok: true, length: settings.memory?.length ?? 0 };
        } catch (error) {
          if (error instanceof ProjectMemoryTooLargeError) {
            reply.code(413);
            return {
              error: `project memory limit is ${PROJECT_MEMORY_MAX_CHARS} characters; edit or prune it in Project Settings`,
            };
          }
          throw error;
        }
      },
    );
  }
}
