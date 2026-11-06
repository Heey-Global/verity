import type { EventStore, ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSafeRefName } from './branches.js';
import type { ProjectRepository } from './project-repo-route.js';

const params = z.object({ id: z.string().min(1) });
const identity = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u);
const create = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['github', 'forgejo']),
    owner: identity,
    repo: identity,
    forgeConnectionId: z.string().min(1).nullable().optional(),
    defaultBranch: z.string().refine(isSafeRefName).nullable().optional(),
  })
  .strict();

export function registerProjectRepositoriesRoutes(
  app: FastifyInstance,
  deps: {
    store: EventStore;
    repositoryFor?:
      ((project: ProjectRecord) => Promise<ProjectRepository | undefined>) | undefined;
  },
): void {
  app.get('/projects/:id/repositories', async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await deps.store.getProject(id)))
      return reply.code(404).send({ error: 'project not found' });
    return { repositories: await deps.store.listProjectRepositories(id) };
  });
  app.post('/projects/:id/repositories', async (request, reply) => {
    const { id } = params.parse(request.params);
    const parsed = create.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid repository' });
    const project = await deps.store.getProject(id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const body = { ...parsed.data, forgeConnectionId: parsed.data.forgeConnectionId ?? null };
    if (body.kind === 'forgejo') {
      const connection = body.forgeConnectionId
        ? await deps.store.forgeConnections.get(body.forgeConnectionId)
        : undefined;
      if (connection?.provider !== 'forgejo')
        return reply.code(400).send({ error: 'Forgejo connection required' });
    } else if (body.forgeConnectionId && body.forgeConnectionId !== 'legacy-github') {
      return reply.code(400).send({ error: 'unsupported GitHub connection' });
    }
    // Validate actual remote access before granting the sandbox a new target.
    const remote = await deps.repositoryFor?.({ ...project, ...body });
    if (!remote) return reply.code(503).send({ error: 'code host unavailable' });
    try {
      const remoteDefaultBranch = await remote.operations.defaultBranch();
      const defaultBranch = body.defaultBranch ?? remoteDefaultBranch;
      const repository = await deps.store.addProjectRepository({
        ...body,
        projectId: id,
        defaultBranch,
      });
      return { repository };
    } catch {
      return reply.code(409).send({ error: 'repository is unavailable or already connected' });
    }
  });
  app.delete('/projects/:id/repositories/:repositoryId', async (request, reply) => {
    const { id, repositoryId } = params
      .extend({ repositoryId: z.string().min(1) })
      .parse(request.params);
    if (repositoryId === `default:${id}`)
      return reply
        .code(409)
        .send({ error: 'disconnect the default repository through project settings' });
    if (!(await deps.store.removeProjectRepository(id, repositoryId)))
      return reply.code(404).send({ error: 'repository not found' });
    return { removed: true };
  });
}
