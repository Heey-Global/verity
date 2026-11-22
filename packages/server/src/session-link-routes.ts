import { isSessionLinkProject, type EventStore, type ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const paramsSchema = z.object({ id: z.string().min(1).max(128) });

/** Linkable, and present: a type guard over {@link isSessionLinkProject}. */
export function sessionLinkProjectAvailable(
  project: ProjectRecord | undefined,
): project is ProjectRecord {
  return project !== undefined && isSessionLinkProject(project);
}

export function registerSessionLinkRoutes(app: FastifyInstance, store: EventStore): void {
  app.get('/sessions/:id/linked-message-approvals', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    if (!(await store.getSession(id))) {
      reply.code(404);
      return { error: 'session not found' };
    }
    const pending = await store.listPendingSessionLinkMessages(id);
    return {
      approvals: pending.map((item) => ({
        id: item.id,
        targetSessionId: item.targetSessionId,
        message: item.message,
        approved: item.approvedAt !== null,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

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
}
