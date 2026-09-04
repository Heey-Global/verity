import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

// Exactly one target selects either a new branch, an existing local branch, or
// a pushed branch checked out detached for preview. `onDirty` controls what
// happens to uncommitted work before the switch.
const branchBody = z
  .object({
    newBranch: z.string().min(1).max(200).optional(),
    branch: z.string().min(1).max(200).optional(),
    preview: z.string().min(1).max(200).optional(),
    onDirty: z.enum(['block', 'stash', 'commit']).optional(),
  })
  .refine((body) => [body.newBranch, body.branch, body.preview].filter(Boolean).length === 1, {
    message: 'specify exactly one of newBranch / branch / preview',
  });

type SessionBranchSwitchBody = z.infer<typeof branchBody>;

export interface SessionBranchSwitchRouteDeps {
  switchBranch: (
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    body: SessionBranchSwitchBody,
  ) => Promise<unknown>;
}

/** Registers switching the working branch while retaining the session chat. */
export function registerSessionBranchSwitchRoute(
  app: FastifyInstance,
  deps: SessionBranchSwitchRouteDeps,
): void {
  app.post('/sessions/:id/branch', (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    const body = branchBody.parse(request.body);
    return deps.switchBranch(request, reply, id, body);
  });
}
