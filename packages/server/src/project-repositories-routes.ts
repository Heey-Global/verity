import {
  projectForRepository,
  type EventStore,
  type ProjectRecord,
  type ProjectRepositoryRecord,
} from '@verity/store';
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

/** Larger than any instructions file worth reading; beyond it the text is cut
 *  and marked, so a stray generated file cannot flood the settings screen. */
export const REPOSITORY_INSTRUCTIONS_MAX_CHARS = 100_000;

export type RepositoryInstructions = Pick<
  ProjectRepositoryRecord,
  'id' | 'name' | 'kind' | 'owner' | 'repo' | 'isDefault'
> &
  (
    | {
        status: 'present';
        branch: string;
        path: 'AGENTS.md';
        instructions: string;
        revision: string;
        truncated: boolean;
      }
    | { status: 'missing'; branch: string; path: 'AGENTS.md' }
    | { status: 'unavailable'; branch: string | null; path: 'AGENTS.md' }
  );

/** Each code host request has its own deadline, but one repository can need
 *  several in a row; this bounds the whole lookup so a slow host cannot hold
 *  the list for every other repository. */
const REPOSITORY_INSTRUCTIONS_TIMEOUT_MS = 20_000;

/**
 * The root AGENTS.md of every repository connected to the project, read from the
 * code host at the repository's default branch. Each repository is resolved on
 * its own: one host being down or slow marks that repository unavailable and
 * leaves the others readable, and "unavailable" is never reported as "no AGENTS.md".
 */
export async function readRepositoryInstructions(
  store: Pick<EventStore, 'listProjectRepositories'>,
  project: ProjectRecord,
  repositoryFor: ((project: ProjectRecord) => Promise<ProjectRepository | undefined>) | undefined,
  timeoutMs = REPOSITORY_INSTRUCTIONS_TIMEOUT_MS,
): Promise<RepositoryInstructions[]> {
  const repositories = (await store.listProjectRepositories(project.id)).filter(
    (repository) => repository.kind === 'github' || repository.kind === 'forgejo',
  );
  return Promise.all(
    repositories.map(async (repository): Promise<RepositoryInstructions> => {
      const identity = {
        id: repository.id,
        name: repository.isDefault ? `${repository.owner}/${repository.repo}` : repository.name,
        kind: repository.kind as 'github' | 'forgejo',
        owner: repository.owner,
        repo: repository.repo,
        isDefault: repository.isDefault,
        path: 'AGENTS.md' as const,
      };
      let branch: string | null = repository.defaultBranch;
      const read = async (): Promise<RepositoryInstructions> => {
        const remote = await repositoryFor?.(projectForRepository(project, repository));
        if (!remote) return { ...identity, status: 'unavailable', branch };
        branch ??= await remote.operations.defaultBranch();
        const file = await remote.operations.readFile('AGENTS.md', branch);
        if (file === null) return { ...identity, status: 'missing', branch };
        const truncated = file.content.length > REPOSITORY_INSTRUCTIONS_MAX_CHARS;
        return {
          ...identity,
          status: 'present',
          branch,
          instructions: truncate(file.content, REPOSITORY_INSTRUCTIONS_MAX_CHARS),
          revision: file.revision,
          truncated,
        };
      };
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          read(),
          new Promise<RepositoryInstructions>((resolve) => {
            timer = setTimeout(
              () => resolve({ ...identity, status: 'unavailable', branch }),
              timeoutMs,
            );
          }),
        ]);
      } catch {
        return { ...identity, status: 'unavailable', branch };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Cut at a character boundary: a cut through a surrogate pair leaves half an emoji. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

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
  app.get('/projects/:id/repository-instructions', async (request, reply) => {
    const { id } = params.parse(request.params);
    const project = await deps.store.getProject(id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    reply.header('cache-control', 'no-store');
    return {
      repositories: await readRepositoryInstructions(deps.store, project, deps.repositoryFor),
    };
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
