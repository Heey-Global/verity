import type { EventStore } from '@verity/store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface AssistantRouteDeps {
  /** Returns the assistant session id, creating the session in Verity Control if it is gone. */
  ensureSession(): Promise<string>;
}

/** System and per-project settings of the Verity assistant (docs/assistant.md). */
export function registerAssistantRoutes(
  app: FastifyInstance,
  store: EventStore,
  deps: AssistantRouteDeps,
): void {
  const administrator = async (request: FastifyRequest) =>
    request.localUserId != null && (await store.isActiveAdministrator(request.localUserId));
  const status = async () => {
    const settings = await store.assistant.settings();
    return {
      enabled: settings.enabled,
      sessionId: settings.enabled ? await deps.ensureSession() : null,
      grants: (await store.assistant.grants())
        .filter((grant) => grant.mode !== 'off')
        .map((grant) => ({ projectId: grant.project_id, mode: grant.mode })),
    };
  };
  app.get('/settings/assistant', async (request, reply) => {
    if (!(await administrator(request)))
      return reply.code(403).send({ error: 'Administrator access required' });
    return status();
  });
  app.put('/settings/assistant', async (request, reply) => {
    if (!(await administrator(request)))
      return reply.code(403).send({ error: 'Administrator access required' });
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    await store.assistant.configure(enabled, request.localUserId!);
    return status();
  });

  const params = z.object({ id: z.string().min(1) });
  const allowed = async (
    request: FastifyRequest,
    projectId: string,
    permission: 'read' | 'execute',
  ) =>
    request.localUserId != null &&
    ((await store.isActiveAdministrator(request.localUserId)) ||
      (await store.hasProjectPermission(request.localUserId, projectId, permission)));
  app.get('/projects/:id/assistant', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'read')))
      return reply.code(403).send({ error: 'Project access required' });
    const grant = await store.assistant.grant(id);
    return {
      assistantEnabled: (await store.assistant.settings()).enabled,
      mode: grant?.mode ?? 'off',
    };
  });
  app.put('/projects/:id/assistant', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'execute')))
      return reply.code(403).send({ error: 'Project execution permission required' });
    const { mode } = z
      .object({ mode: z.enum(['off', 'tasks', 'delegate']) })
      .strict()
      .parse(request.body);
    if (mode !== 'off' && !(await store.assistant.settings()).enabled)
      return reply.code(409).send({ error: 'Enable the assistant in system settings first' });
    const project = await store.getProject(id);
    if (!project || project.kind === 'control_plane')
      return reply.code(409).send({ error: 'The assistant can only be granted project access' });
    await store.assistant.setGrant(id, request.localUserId!, mode);
    return { mode };
  });
}
