import {
  readOrMigrateProjectOverview,
  projectMemoryRevision,
  replaceProjectOverview,
} from './project-overview-file.js';
import type { EventStore } from '@verity/store';
import { ContextConflictError } from '@verity/store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readProjectInstructions, replaceProjectInstructions } from './project-instructions.js';

export function registerProjectContextRoutes(
  app: FastifyInstance,
  store: EventStore,
  dataRoot: string,
): void {
  const params = z.object({ id: z.string().min(1) });
  const allowed = async (request: FastifyRequest, id: string, permission: 'read' | 'manage') =>
    !!request.localUserId &&
    ((await store.isActiveAdministrator(request.localUserId)) ||
      (await store.hasProjectPermission(request.localUserId, id, permission)));
  const memorySnapshot = async (id: string) => {
    const memory =
      (await readOrMigrateProjectOverview(dataRoot, id, async () => {
        const approved = await store.knowledge.getProjectOverview(id);
        return (
          approved?.bodyMarkdown ?? (await store.getProjectSettingsRaw(id))?.memory ?? undefined
        );
      })) ?? '';
    return { memory, revision: projectMemoryRevision(memory) };
  };
  app.get('/projects/:id/memory', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'read')))
      return reply.code(403).send({ error: 'Project access required' });
    if (!(await store.getProject(id))) return reply.code(404).send({ error: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return memorySnapshot(id);
  });
  app.put('/projects/:id/memory', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'manage')))
      return reply.code(403).send({ error: 'Project manage permission required' });
    if (!(await store.getProject(id))) return reply.code(404).send({ error: 'Project not found' });
    const body = z
      .object({ revision: z.string(), memory: z.string().max(8_000) })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid project Memory' });
    await memorySnapshot(id);
    try {
      return await replaceProjectOverview(dataRoot, id, body.data.revision, body.data.memory);
    } catch (error) {
      if (error instanceof ContextConflictError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.get('/projects/:id/instructions', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'read')))
      return reply.code(403).send({ error: 'Project access required' });
    if (!(await store.getProject(id))) return reply.code(404).send({ error: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return readProjectInstructions(dataRoot, id);
  });
  app.put('/projects/:id/instructions', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(request, id, 'manage')))
      return reply.code(403).send({ error: 'Project manage permission required' });
    if (!(await store.getProject(id))) return reply.code(404).send({ error: 'Project not found' });
    const body = z
      .object({ revision: z.string(), instructions: z.string().max(12_000) })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid project Instructions' });
    try {
      return await replaceProjectInstructions(
        dataRoot,
        id,
        body.data.revision,
        body.data.instructions,
      );
    } catch (error) {
      if (error instanceof ContextConflictError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
