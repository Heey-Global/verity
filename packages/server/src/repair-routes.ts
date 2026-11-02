import { hasFreshRepairEvidence } from './qa-coordinator.js';
import type { EventStore } from '@verity/store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export function registerRepairRoutes(app: FastifyInstance, store: EventStore): void {
  const params = z.object({ id: z.string().min(1) });
  const allowed = async (
    request: FastifyRequest,
    projectId: string,
    permission: 'read' | 'execute',
  ) => {
    const userId = request.localUserId;
    return (
      userId != null &&
      ((await store.isActiveAdministrator(userId)) ||
        (await store.hasProjectPermission(userId, projectId, permission)))
    );
  };
  app.get('/projects/:id/repairs', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'read')))
      return reply.code(403).send({ error: 'Project access required' });
    return {
      qaEnabled: (await store.repairs.qa()).enabled,
      mandate: (await store.repairs.mandate(id)) ?? null,
      incidents: await store.repairs.incidents(id),
    };
  });
  app.put('/projects/:id/repairs', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'execute')))
      return reply.code(403).send({ error: 'Project execution permission required' });
    const { mode } = z
      .object({ mode: z.enum(['off', 'monitor', 'automatic']) })
      .strict()
      .parse(request.body);
    if (mode !== 'off' && !(await store.repairs.qa()).enabled)
      return reply.code(409).send({ error: 'Enable QA in system settings first' });
    const project = await store.getProject(id);
    if (!project || !['github', 'forgejo'].includes(project.kind ?? 'github'))
      return reply.code(409).send({ error: 'A code forge project is required' });
    await store.repairs.configure(id, request.localUserId!, mode);
    return { mandate: await store.repairs.mandate(id) };
  });
  app.post('/projects/:id/repairs/approval', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'execute')))
      return reply.code(403).send({ error: 'Project execution permission required' });
    const { proposalId, allow } = z
      .object({ proposalId: z.string(), allow: z.boolean() })
      .strict()
      .parse(request.body);
    const project = await store.getProject(id);
    if (!project || !['github', 'forgejo'].includes(project.kind ?? 'github'))
      return reply.code(409).send({ error: 'QA requires a coding project connected to a forge' });
    if (!(await store.repairs.qaApprove(proposalId, id, request.localUserId!, allow)))
      return reply
        .code(409)
        .send({ error: 'This request is no longer current. Refresh QA activity.' });
    return { accepted: true };
  });
  app.get('/sessions/:id/qa-approvals', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!request.localUserId || !(await store.isActiveAdministrator(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    if ((await store.repairs.qa()).session_id !== id) return { proposals: [] };
    return { proposals: await store.repairs.qaProposals() };
  });
  app.post('/projects/:id/repairs/retry', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'execute')))
      return reply.code(403).send({ error: 'Project execution permission required' });
    const { incidentId } = z.object({ incidentId: z.string() }).strict().parse(request.body);
    const incident = (await store.repairs.incidents(id)).find((row) => row.id === incidentId);
    if (
      !incident ||
      incident.owner_session_id ||
      !hasFreshRepairEvidence(incident) ||
      !(await store.repairs.qa()).enabled ||
      (await store.repairs.budgetUsed(id, incident.resource)) >= 2
    )
      return reply
        .code(409)
        .send({ error: 'Incident cannot be retried; inspect the assigned session' });
    if (!(await store.repairs.retry(incidentId)))
      return reply.code(409).send({ error: 'Incident did not transition to retry' });
    return { accepted: true };
  });
}

export function registerQASettingsRoutes(
  app: FastifyInstance,
  store: EventStore,
  cancel: (id: string) => Promise<boolean>,
): void {
  const status = async () => {
    const state = await store.repairs.qa();
    return { enabled: state.enabled, health: state.health, session_id: state.session_id };
  };
  app.get('/settings/qa', async (request, reply) => {
    if (!request.localUserId || !(await store.isActiveAdministrator(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    return status();
  });
  app.put('/settings/qa', async (request, reply) => {
    if (!request.localUserId || !(await store.isActiveAdministrator(request.localUserId)))
      return reply.code(403).send({ error: 'Administrator access required' });
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    await store.repairs.configureQA(enabled, request.localUserId);
    if (enabled) await store.repairs.seedQAMonitoring(request.localUserId);
    const state = await store.repairs.qa();
    if (!enabled && state.session_id && state.active_dispatch) await cancel(state.session_id);
    return status();
  });
}
