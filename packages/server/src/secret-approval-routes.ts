import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';

import type { BrokeredToolApprovalStore } from './brokered-tool-approval-store.js';

const sessionParams = z.object({ id: z.string().min(1) });
const approvalParams = sessionParams.extend({ approvalId: z.uuid() });

/** History exposes only receipt metadata. Reopening requests consent; it does not grant it. */
export function registerSecretApprovalRoutes(
  app: FastifyInstance,
  deps: {
    approvals: BrokeredToolApprovalStore;
    store: Pick<EventStore, 'getSession'>;
    permitted: (userId: string | undefined, projectId: string) => Promise<boolean>;
    refresh: (sessionId: string) => Promise<void>;
  },
): void {
  app.get('/sessions/:id/secret-approvals', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    if (!(await deps.store.getSession(id)))
      return reply.code(404).send({ error: 'Session not found.' });
    const requests = (await deps.approvals.listReopenable(id)).map((record) => ({
      id: record.id,
      toolName: record.toolName,
      status: record.status === 'denied' ? 'denied' : 'expired',
      createdAt: record.createdAt,
      decidedAt: record.decidedAt,
    }));
    return { requests };
  });
  app.post('/sessions/:id/secret-approvals/:approvalId/reopen', async (request, reply) => {
    const { id, approvalId } = approvalParams.parse(request.params);
    const record = await deps.approvals.get(approvalId, id);
    if (!record || !(await deps.store.getSession(id)))
      return reply.code(404).send({ error: 'Approval not found.' });
    if (!(await deps.permitted(request.localUserId ?? undefined, record.projectId)))
      return reply.code(403).send({ error: 'Project execution permission is required.' });
    const reopened = await deps.approvals.reopen(approvalId, id);
    if (!reopened)
      return reply
        .code(409)
        .send({ error: 'Only denied or expired approvals can be requested again.' });
    await deps.refresh(id);
    return { requested: true, approvalId: reopened.id };
  });
}
