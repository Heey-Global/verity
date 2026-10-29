import type { EventStore } from '@verity/store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface AssistantRouteDeps {
  /** Returns the assistant session id, creating the session in Verity Control if it is gone. */
  ensureSession(): Promise<string>;
  /** Whether the stored session still exists; reads never create it. */
  sessionExists(sessionId: string): Promise<boolean>;
  /** Stops the session's running turn when the assistant is switched off. */
  cancel(sessionId: string): Promise<boolean>;
}

/** System and per-project settings of the Verity assistant (docs/assistant.md). */
export function registerAssistantRoutes(
  app: FastifyInstance,
  store: EventStore,
  deps: AssistantRouteDeps,
): void {
  const administrator = async (request: FastifyRequest) =>
    request.localUserId != null && (await store.isActiveAdministrator(request.localUserId));
  // A read only reports the session: capture opens this on every sheet, and a failed or
  // racing spawn there would hide the assistant. Turning it on (again) recreates it.
  const status = async () => {
    const settings = await store.assistant.settings();
    const sessionId =
      settings.enabled &&
      settings.session_id !== null &&
      (await deps.sessionExists(settings.session_id))
        ? settings.session_id
        : null;
    return {
      enabled: settings.enabled,
      sessionId,
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
    const wasEnabled = (await store.assistant.settings()).enabled;
    await store.assistant.configure(enabled, request.localUserId!);
    if (enabled) {
      try {
        await deps.ensureSession();
      } catch {
        // Turning it on must not leave a switch without a session; a retry on an
        // already enabled assistant keeps it on.
        if (!wasEnabled) await store.assistant.configure(false, request.localUserId!);
        return reply
          .code(503)
          .send({ error: 'The assistant session could not be created. Try again.' });
      }
    }
    const sessionId = (await store.assistant.settings()).session_id;
    if (!enabled && sessionId !== null) await deps.cancel(sessionId);
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
    if (!(await store.getProject(id))) return reply.code(404).send({ error: 'Project not found' });
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
    const project = await store.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (mode !== 'off' && !(await store.assistant.settings()).enabled)
      return reply.code(409).send({ error: 'Enable the assistant in system settings first' });
    if (project.kind === 'control_plane')
      return reply.code(409).send({ error: 'The assistant can only be granted project access' });
    await store.assistant.setGrant(id, request.localUserId!, mode);
    return { mode };
  });
}
