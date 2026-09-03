import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LOCAL_PROJECT_OWNER,
  isLocalProject,
  type EventStore,
  type ProjectRecord,
  type ProjectUpsertInput,
} from '@verity/store';
import { containerNameFor, parseOwnerRepo, slugifyProjectName } from './canonical.js';

const orderBody = z.object({ ids: z.array(z.string().min(1)) });
const createBody = z.union([
  z.object({
    repo: z.string().min(1),
    kind: z.literal('github').optional(),
    imageRef: z.string().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal('local'),
    name: z.string().min(1).max(100),
    imageRef: z.string().min(1).nullable().optional(),
  }),
]);

export interface ProjectCollectionRouteDeps {
  store: Pick<
    EventStore,
    'createProject' | 'getProject' | 'setProjectSetupStatus' | 'upsertProject'
  >;
  listOverview: () => Promise<unknown[]>;
  reorder: (ids: string[]) => Promise<unknown[]>;
  listAvailableRepositories: () => Promise<ProjectRecord[]>;
  presentRepositories: (projects: ProjectRecord[]) => Promise<unknown[]>;
  localIdentityReservations: { has(key: string): boolean };
  githubTargetReservations: { has(key: string): boolean };
  isUniqueViolation: (error: unknown) => boolean;
}

/** Registers project collection, ordering, repository-picker, and creation routes. */
export function registerProjectCollectionRoutes(
  app: FastifyInstance,
  deps: ProjectCollectionRouteDeps,
): void {
  app.get('/projects', async (): Promise<unknown[]> => deps.listOverview());

  app.patch('/projects/order', async (request, reply): Promise<unknown> => {
    const body = orderBody.parse(request.body);
    if (new Set(body.ids).size !== body.ids.length) {
      reply.code(400);
      return { error: 'duplicate project id' };
    }
    try {
      return await deps.reorder(body.ids);
    } catch (error) {
      if (error instanceof Error && /project order/i.test(error.message)) {
        reply.code(400);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.get('/github/repositories', async (): Promise<unknown[]> => {
    const projects = await deps.listAvailableRepositories();
    return deps.presentRepositories(
      projects.filter(
        (project) =>
          project.state === 'absent' &&
          !isLocalProject(project) &&
          (project.hiddenAt !== null || project.overviewVisible !== true),
      ),
    );
  });

  app.post('/projects', async (request, reply): Promise<unknown> => {
    const body = createBody.parse(request.body);
    const local = body.kind === 'local';
    const parsed = local
      ? ((slug) => (slug === undefined ? undefined : { owner: LOCAL_PROJECT_OWNER, repo: slug }))(
          slugifyProjectName(body.name),
        )
      : parseOwnerRepo(body.repo);
    if (parsed === undefined) {
      reply.code(400);
      return { error: local ? 'invalid project name' : 'invalid project' };
    }
    const parsedKey = `${parsed.owner}/${parsed.repo}`;
    if (
      deps.localIdentityReservations.has(parsedKey) ||
      deps.githubTargetReservations.has(parsedKey)
    ) {
      reply.code(409);
      return {
        error: local
          ? 'a project with that name already exists'
          : `${parsedKey} is currently being linked`,
      };
    }
    const input: ProjectUpsertInput = {
      id: randomUUID(),
      owner: parsed.owner,
      repo: parsed.repo,
      containerName: containerNameFor(parsed),
      ...(local
        ? {
            kind: 'local' as const,
            // Linking later rewrites owner/repo; the pinned directory keeps existing
            // absolute session worktree paths valid.
            cloneDir: `${parsed.owner}-${parsed.repo}`,
          }
        : {}),
      ...(body.imageRef !== undefined ? { imageRef: body.imageRef } : {}),
      state: 'absent',
      restore: true,
      overviewVisible: true,
    };
    let project: ProjectRecord;
    try {
      project = local
        ? await deps.store.createProject(input)
        : await deps.store.upsertProject(input);
    } catch (error) {
      if (local && deps.isUniqueViolation(error)) {
        reply.code(409);
        return { error: 'a project with that name already exists' };
      }
      throw error;
    }
    await deps.store.setProjectSetupStatus(project.id, 'pending');
    reply.code(201);
    return { project: (await deps.store.getProject(project.id))! };
  });
}
