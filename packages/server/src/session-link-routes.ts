import { isSessionLinkProject, type EventStore, type ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const paramsSchema = z.object({ id: z.string().min(1).max(128) });
const targetSchema = z.object({ targetSessionId: z.string().min(1).max(128) }).strict();

/** Linkable, and present: a type guard over {@link isSessionLinkProject}. */
export function sessionLinkProjectAvailable(
  project: ProjectRecord | undefined,
): project is ProjectRecord {
  return project !== undefined && isSessionLinkProject(project);
}

export function registerSessionLinkRoutes(app: FastifyInstance, store: EventStore): void {
  app.get('/sessions/:id/links', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    if (!(await store.getSession(id))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const links = await store.listSessionLinks(id);
    const projects = await store.listProjects();
    return {
      links: links.map((link) => {
        const project = projects.find((item) => item.id === link.peerProjectId);
        return {
          sessionId: link.peerSessionId,
          name: link.peerName,
          projectId: link.peerProjectId,
          projectName: project?.repo ?? link.peerProjectId,
        };
      }),
    };
  });

  app.post('/sessions/:id/links', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const { targetSessionId } = targetSchema.parse(request.body);
    const [source, target] = await Promise.all([
      store.getSession(id),
      store.getSession(targetSessionId),
    ]);
    if (!source || !target) {
      reply.code(404);
      return { error: 'session not found' };
    }
    if (!source.projectId || !target.projectId || source.projectId === target.projectId) {
      reply.code(400);
      return { error: 'choose a session in another project' };
    }
    const [sourceProject, targetProject] = await Promise.all([
      store.getProject(source.projectId),
      store.getProject(target.projectId),
    ]);
    if (
      !sessionLinkProjectAvailable(sourceProject) ||
      !sessionLinkProjectAvailable(targetProject)
    ) {
      reply.code(400);
      return { error: 'both sessions must belong to available projects' };
    }
    const created = await store.createSessionLink(id, targetSessionId);
    reply.code(created ? 201 : 200);
    return { linked: true };
  });

  app.delete('/sessions/:id/links/:targetId', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const { targetId } = z.object({ targetId: z.string().min(1).max(128) }).parse(request.params);
    if (!(await store.getSession(id))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    await store.deleteSessionLink(id, targetId);
    return { linked: false };
  });
}
