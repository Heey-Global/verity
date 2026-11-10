import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { viewerId } from './view-state-routes.js';
import {
  isInstallationPlaceholder,
  LOCAL_PROJECT_OWNER,
  PROJECT_NAME_MAX_CHARS,
  type EventStore,
  type ProjectRecord,
  type ProjectUpsertInput,
} from '@verity/store';
import {
  containerNameFor,
  parseOwnerRepo,
  parseForgejoRepository,
  slugifyProjectName,
} from './canonical.js';

const orderBody = z.object({ ids: z.array(z.string().min(1)) });
// The project's own name. Optional for a repository project, which is then
// named after its repository; a local project is named by it.
const projectName = z
  .string()
  .trim()
  .min(1)
  .refine(
    (name) => name.length <= PROJECT_NAME_MAX_CHARS,
    `project name is limited to ${PROJECT_NAME_MAX_CHARS} characters`,
  );
const createBody = z.union([
  z.object({
    repo: z.string().min(1),
    kind: z.enum(['github', 'forgejo']).optional(),
    connectionId: z.string().min(1).optional(),
    name: projectName.optional(),
    imageRef: z.string().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal('local'),
    name: projectName,
    imageRef: z.string().min(1).nullable().optional(),
  }),
]);

/** How many numbered slugs a local project tries when its name's slug is taken. */
const LOCAL_SLUG_ATTEMPTS = 20;

/** The `n`-th candidate directory slug for a local project: the slug itself,
 *  then `<slug>-2`, `<slug>-3`, … — kept within the 100 characters a repo
 *  name allows. Two projects may share a name; their directories must differ. */
function numberedLocalSlug(slug: string, n: number): string {
  if (n === 1) return slug;
  const suffix = `-${String(n)}`;
  return `${slug.slice(0, 100 - suffix.length).replace(/[._-]+$/, '')}${suffix}`;
}

export interface ProjectCollectionRouteDeps {
  store: Pick<
    EventStore,
    | 'createProject'
    | 'createRepositoryProject'
    | 'getProject'
    | 'renameProject'
    | 'setProjectSetupStatus'
    | 'upsertProject'
    | 'forgeConnections'
    | 'isActiveAdministrator'
  >;
  forgejoEnabled?: boolean;
  /** `viewer` owns the fold state and dismissed Home items in the answer. */
  listOverview: (userId: string | null, viewer: string) => Promise<unknown[]>;
  reorder: (ids: string[], viewer: string) => Promise<unknown[]>;
  listAvailableRepositories: () => Promise<ProjectRecord[]>;
  presentRepositories: (projects: ProjectRecord[]) => Promise<unknown[]>;
  localIdentityReservations: { has(key: string): boolean };
  githubTargetReservations: { has(key: string): boolean };
  isUniqueViolation: (error: unknown) => boolean;
}

/**
 * The stored shape of a new local project. Shared by `POST /projects` and the
 * starter project a fresh installation creates, so both land on disk and in the
 * overview the same way.
 */
export function localProjectInput(slug: string): ProjectUpsertInput {
  const identity = { owner: LOCAL_PROJECT_OWNER, repo: slug };
  return {
    id: randomUUID(),
    ...identity,
    containerName: containerNameFor(identity),
    kind: 'local',
    // Linking later rewrites owner/repo; the pinned directory keeps existing
    // absolute session worktree paths valid.
    cloneDir: `${identity.owner}-${identity.repo}`,
    state: 'absent',
    restore: true,
    overviewVisible: true,
  };
}

/**
 * The GitHub repositories a new project can start from: each repository the
 * installation offers exactly once, whether or not projects already use it.
 * Every project of a repository carries the repository's own metadata, so the
 * first one stands for it.
 */
export function repositoryCatalog(projects: readonly ProjectRecord[]): ProjectRecord[] {
  const byRepository = new Map<string, ProjectRecord>();
  for (const project of projects) {
    if (project.archived === true) continue;
    if (project.kind !== undefined && project.kind !== 'github') continue;
    if ((project.forgeConnectionId ?? 'legacy-github') !== 'legacy-github') continue;
    const key = `${project.owner}/${project.repo}`.toLowerCase();
    const current = byRepository.get(key);
    if (
      current === undefined ||
      (project.repositoryInstance ?? 1) < (current.repositoryInstance ?? 1)
    ) {
      byRepository.set(key, project);
    }
  }
  // Only an installation placeholder is offered as itself. A repository behind
  // a project, current or removed, is offered as the repository alone: the
  // picker must not hand out that project's ID, state or sandbox details.
  // Choosing it still restores a removed first project (createRepositoryProject).
  return [...byRepository.values()].map((project) =>
    isInstallationPlaceholder(project) ? project : repositoryOnly(project),
  );
}

/** A repository-level record built from an allowlist, so no project-level
 *  field (container, visibility, order, sandbox state) can leak through. */
function repositoryOnly(project: ProjectRecord): ProjectRecord {
  const id = `repository:${project.owner}/${project.repo}`;
  return {
    id,
    name: project.repo,
    owner: project.owner,
    repo: project.repo,
    containerName: id,
    kind: 'github',
    forgeConnectionId: project.forgeConnectionId ?? null,
    archived: project.archived ?? false,
    state: 'absent',
    imageRef: null,
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    overviewVisible: false,
    latestReleaseTag: project.latestReleaseTag,
    latestReleaseName: project.latestReleaseName,
    latestReleaseUrl: project.latestReleaseUrl,
    latestReleasePublishedAt: project.latestReleasePublishedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    stateChangedAt: project.stateChangedAt,
  };
}

/** Registers project collection, ordering, repository-picker, and creation routes. */
export function registerProjectCollectionRoutes(
  app: FastifyInstance,
  deps: ProjectCollectionRouteDeps,
): void {
  app.get('/projects', async (request): Promise<unknown[]> =>
    deps.listOverview(request.localUserId, viewerId(request)),
  );

  app.patch('/projects/order', async (request, reply): Promise<unknown> => {
    const body = orderBody.parse(request.body);
    if (new Set(body.ids).size !== body.ids.length) {
      reply.code(400);
      return { error: 'duplicate project id' };
    }
    try {
      return await deps.reorder(body.ids, viewerId(request));
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
    return deps.presentRepositories(repositoryCatalog(projects));
  });

  app.post('/projects', async (request, reply): Promise<unknown> => {
    const body = createBody.parse(request.body);
    // A local project's directory slug comes from its name; a name without a
    // single usable character still gets a directory.
    const localName = body.kind === 'local' ? body.name : undefined;
    const localSlug =
      localName !== undefined ? (slugifyProjectName(localName) ?? 'project') : undefined;
    let parsed =
      localSlug !== undefined
        ? { owner: LOCAL_PROJECT_OWNER, repo: localSlug }
        : parseOwnerRepo((body as { repo: string }).repo);
    const connectionId = body.kind !== 'local' ? body.connectionId : undefined;
    let forgeKind: 'github' | 'forgejo' = 'github';
    if (connectionId || body.kind === 'forgejo') {
      if (!connectionId) return reply.code(400).send({ error: 'connection required' });
      if (!request.localUserId || !(await deps.store.isActiveAdministrator(request.localUserId)))
        return reply.code(403).send({ error: 'administrator required' });
      const connection = await deps.store.forgeConnections.get(connectionId);
      if (!connection) return reply.code(404).send({ error: 'connection not found' });
      if (connection.provider === 'github' && connection.id !== 'legacy-github')
        return reply
          .code(400)
          .send({ error: 'only the existing GitHub App connection is supported' });
      forgeKind = connection.provider;
      if (connection.provider === 'forgejo' && body.kind !== 'local')
        parsed = parseForgejoRepository(body.repo, connection.baseUrl);
      if (body.kind && body.kind !== forgeKind)
        return reply.code(400).send({ error: 'provider does not match connection' });
      if (forgeKind === 'forgejo' && !deps.forgejoEnabled)
        return reply.code(503).send({ error: 'Forgejo sandbox integration unavailable' });
    }
    if (parsed === undefined) {
      reply.code(400);
      return { error: 'invalid project' };
    }
    const imageRef = body.imageRef !== undefined ? { imageRef: body.imageRef } : {};
    let project: ProjectRecord | undefined;
    if (localSlug !== undefined && localName !== undefined) {
      // Names may repeat; directories may not. Take the first free numbered slug.
      for (let n = 1; n <= LOCAL_SLUG_ATTEMPTS && project === undefined; n++) {
        const slug = numberedLocalSlug(localSlug, n);
        if (deps.localIdentityReservations.has(`${LOCAL_PROJECT_OWNER}/${slug}`)) continue;
        try {
          project = await deps.store.createProject({
            ...localProjectInput(slug),
            name: localName,
            ...imageRef,
          });
        } catch (error) {
          if (!deps.isUniqueViolation(error)) throw error;
        }
      }
      if (project === undefined) {
        reply.code(409);
        return { error: 'too many projects with that name' };
      }
    } else {
      // A repository may back several projects, so a link in flight to the same
      // repository is no reason to refuse: the store gives each its own instance.
      project = await deps.store.createRepositoryProject({
        id: randomUUID(),
        owner: parsed.owner,
        repo: parsed.repo,
        containerName: containerNameFor(parsed, connectionId),
        kind: forgeKind,
        ...(connectionId ? { forgeConnectionId: connectionId } : {}),
        ...(forgeKind === 'forgejo' ? { cloneDir: containerNameFor(parsed, connectionId) } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        state: 'absent' as const,
        restore: true,
        overviewVisible: true,
        ...imageRef,
      });
      // Choosing a repository can restore its removed first project, which
      // keeps its stored name; the name given now is the one meant.
      if (body.name !== undefined && project.name !== body.name)
        project = (await deps.store.renameProject(project.id, body.name)) ?? project;
    }
    await deps.store.setProjectSetupStatus(project.id, 'pending');
    reply.code(201);
    return { project: (await deps.store.getProject(project.id))! };
  });
}
