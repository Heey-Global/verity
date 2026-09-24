import { SessionBusyError } from '@verity/session';
import { ProvisioningError } from './provisioner.js';
import { RepositoryHasNoCommitsError } from './worktree.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionParams } from './session-route-schemas.js';
import { SessionMoveError } from './session-move-files.js';

const moveBody = z.object({
  project: z.string().min(1),
  operationId: z.uuid(),
  onCommits: z.enum(['block', 'leave']).default('block'),
});
export type SessionMoveRequest = z.infer<typeof moveBody>;
export function registerSessionMoveRoute(
  app: FastifyInstance,
  deps: {
    move: (id: string, body: SessionMoveRequest) => Promise<unknown>;
  },
): void {
  app.post('/sessions/:id/project', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const body = moveBody.parse(request.body);
    try {
      return await deps.move(id, body);
    } catch (error) {
      if (error instanceof SessionBusyError || error instanceof ProvisioningError) {
        reply.code(409);
        return { error: error.message, code: 'busy' };
      }
      if (error instanceof RepositoryHasNoCommitsError) {
        reply.code(409);
        return {
          error: 'Create an initial commit in the target project before moving.',
          code: 'empty_target',
        };
      }
      if (!(error instanceof SessionMoveError)) throw error;
      reply.code(error.status);
      return { error: error.message, code: error.code };
    }
  });
}
