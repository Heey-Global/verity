import { projectForRepository, type EventStore, type ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './auth.js';
import { isSafeRefName } from './branches.js';
import {
  ForgeOperationError,
  type ForgeIssueList,
  type ForgeRepositoryOperations,
} from './forge-provider.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { internalConnectionIdentity } from './internal-listener.js';

/** The code host behind one project, with server-held credentials. */
export interface ProjectRepository {
  /** Shown to the agent, e.g. `Forgejo`. */
  hostName: string;
  operations: ForgeRepositoryOperations;
  listIssues: () => Promise<ForgeIssueList>;
}

export interface ProjectRepoRouteDeps {
  capabilities: GhTokenCapabilityRegistry;
  store?: Pick<
    EventStore,
    | 'getProjectRepository'
    | 'listProjectRepositories'
    | 'recordRepositoryPullRequest'
    | 'upsertSessionRepositoryWorkspace'
  >;
  openRepository?: (sessionId: string, repositoryId: string) => Promise<unknown>;
  currentRepositoryBranch?: (
    sessionId: string,
    repositoryId: string,
  ) => Promise<string | undefined>;
  getSession?: EventStore['getSession'];
  getProject: (projectId: string) => Promise<ProjectRecord | undefined>;
  /** Undefined when the project has no usable code host (local, or connection gone). */
  repositoryFor: (project: ProjectRecord) => Promise<ProjectRepository | undefined>;
}

const branch = z
  .string()
  .min(1)
  .max(255)
  // Existing forge branches follow Git's grammar, rather than our naming policy.
  .refine(isSafeRefName, 'invalid branch name');
const number = z.number().int().positive();
const text = (max: number) => z.string().max(max);

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('repository.list') }),
  z.object({
    action: z.literal('repository.open'),
    repositoryId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    action: z.literal('pr.create'),
    title: text(256).min(1),
    body: text(65_536).default(''),
    head: branch,
    base: branch.optional(),
    dependsOn: z
      .array(z.url().refine((value) => ['https:', 'http:'].includes(new URL(value).protocol)))
      .max(20)
      .optional(),
  }),
  z.object({ action: z.literal('pr.ready'), number: number.optional(), head: branch.optional() }),
  z.object({ action: z.literal('pr.view'), number: number.optional(), head: branch.optional() }),
  z.object({ action: z.literal('issue.list') }),
  z.object({ action: z.literal('issue.view'), number }),
  z.object({ action: z.literal('issue.comment'), number, body: text(65_536).min(1) }),
]);

/**
 * `POST /internal/project/repo` — the sandbox's `verity-repo` tool. Like project
 * memory it authenticates with the per-container capability AND the project
 * socket it arrived on, and the server alone decides the project, its code host
 * and its repository: a request can select only an assigned repository and never see a
 * token. Each action goes through the project's forge provider, so a new code
 * host needs no change here or in the sandbox.
 */
export function registerProjectRepoRoute(app: FastifyInstance, deps: ProjectRepoRouteDeps): void {
  const creating = new Map<
    string,
    Promise<{
      pr: Awaited<ReturnType<ForgeRepositoryOperations['createPullRequest']>>;
      dependsOn?: string[] | undefined;
    }>
  >();
  app.post('/internal/project/repo', async (request, reply) => {
    const presented = bearerToken(request.headers.authorization) ?? '';
    const binding = presented === '' ? undefined : await deps.capabilities.resolve(presented);
    const socketIdentity = internalConnectionIdentity(request);
    if (
      binding === undefined ||
      socketIdentity === undefined ||
      socketIdentity.projectId !== binding.projectId ||
      socketIdentity.containerGeneration !== binding.containerGeneration
    ) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
    let project = await deps.getProject(binding.projectId);
    if (project === undefined) return reply.code(404).send({ error: 'project not found' });
    if (parsed.data.action === 'repository.list')
      return { repositories: (await deps.store?.listProjectRepositories(project.id)) ?? [] };
    if (parsed.data.action === 'repository.open') {
      const session = await deps.getSession?.(parsed.data.sessionId);
      if (!session || session.projectId !== project.id)
        return reply.code(404).send({ error: 'project session not found' });
      if (!deps.openRepository)
        return reply.code(503).send({ error: 'repository checkout unavailable' });
      try {
        return await deps.openRepository(parsed.data.sessionId, parsed.data.repositoryId);
      } catch {
        return reply.code(409).send({ error: 'repository checkout unavailable' });
      }
    }
    const repositoryId = z
      .object({
        repositoryId: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
      })
      .safeParse(request.body);
    if (!repositoryId.success) return reply.code(400).send({ error: 'invalid repository target' });
    const selectedId = repositoryId.data.repositoryId;
    const sessionId = repositoryId.data.sessionId;
    if (sessionId !== undefined) {
      const session = await deps.getSession?.(sessionId);
      if (!session || session.projectId !== project.id)
        return reply.code(404).send({ error: 'project session not found' });
    }
    if (selectedId !== undefined) {
      const selected = await deps.store?.getProjectRepository(project.id, selectedId);
      if (!selected)
        return reply.code(404).send({ error: 'repository is not connected to this project' });
      project = projectForRepository(project, selected);
    }
    if (project.kind === 'local' || project.kind === 'control_plane') {
      return reply.code(409).send({
        error:
          'this project has no code host; connect it to GitHub or Forgejo in project settings first',
      });
    }
    const repository = await deps.repositoryFor(project);
    if (repository === undefined)
      return reply.code(503).send({ error: 'the code host connection is unavailable' });
    const ops = repository.operations;
    const remember = async (
      pr: Awaited<ReturnType<typeof ops.createPullRequest>>,
      dependsOn?: string[],
    ) => {
      const actualBranch = sessionId
        ? await deps.currentRepositoryBranch?.(sessionId, selectedId ?? `default:${project.id}`)
        : undefined;
      if (sessionId && deps.currentRepositoryBranch && actualBranch !== pr.head) return pr;
      if (sessionId && (selectedId === undefined || selectedId === `default:${project.id}`)) {
        const session = await deps.getSession?.(sessionId);
        if (session?.projectId === project.id)
          await deps.store?.upsertSessionRepositoryWorkspace({
            sessionId,
            projectId: project.id,
            repositoryId: `default:${project.id}`,
            worktree: session.worktree,
            branch: pr.head,
          });
      }
      await deps.store?.recordRepositoryPullRequest(
        project.id,
        selectedId ?? `default:${project.id}`,
        pr.head,
        {
          ...pr,
          ...(dependsOn === undefined ? {} : { dependsOn }),
        },
        actualBranch === pr.head ? sessionId : undefined,
      );
      return pr;
    };
    const body = parsed.data;
    try {
      switch (body.action) {
        case 'pr.create': {
          const key = `${project.id}:${selectedId ?? `default:${project.id}`}:${body.head}`;
          let operation = creating.get(key);
          if (!operation) {
            operation = (async () => {
              const existing = await ops.findPullRequest({ head: body.head });
              if (existing?.state === 'open') return { pr: existing };
              return {
                pr: await ops.createPullRequest({
                  head: body.head,
                  base: body.base ?? (await ops.defaultBranch()),
                  title: body.title,
                  body: [body.body, ...(body.dependsOn ?? []).map((url) => `Depends on: ${url}`)]
                    .filter(Boolean)
                    .join('\n\n'),
                }),
                dependsOn: body.dependsOn,
              };
            })();
            creating.set(key, operation);
          }
          let pullRequest: Awaited<ReturnType<typeof ops.createPullRequest>>;
          try {
            const result = await operation;
            pullRequest = await remember(result.pr, result.dependsOn);
          } finally {
            if (creating.get(key) === operation) creating.delete(key);
          }
          request.log.info(
            { projectId: project.id, number: pullRequest.number },
            'verity: agent opened pull request',
          );
          return { host: repository.hostName, pullRequest };
        }
        case 'pr.ready':
        case 'pr.view': {
          if (body.number === undefined && body.head === undefined)
            return reply.code(400).send({ error: 'name a pull request number or branch' });
          const found = await ops.findPullRequest(
            body.number !== undefined ? { number: body.number } : { head: body.head! },
          );
          if (found === null) return reply.code(404).send({ error: 'no pull request found' });
          if (body.action === 'pr.view')
            return { host: repository.hostName, pullRequest: await remember(found) };
          if (found.state !== 'open')
            return reply
              .code(409)
              .send({ error: `pull request #${found.number} is ${found.state}` });
          return {
            host: repository.hostName,
            pullRequest: await remember(await ops.markPullRequestReady(found.number)),
          };
        }
        case 'issue.list': {
          const list = await repository.listIssues();
          if (!list.connected)
            return reply.code(503).send({ error: 'issues are unavailable on this code host' });
          return { host: repository.hostName, issues: list.issues };
        }
        case 'issue.view': {
          const issue = await ops.viewIssue(body.number);
          if (issue === null)
            return reply.code(404).send({ error: `issue #${body.number} not found` });
          return { host: repository.hostName, issue };
        }
        case 'issue.comment':
          return {
            host: repository.hostName,
            comment: await ops.commentOnIssue(body.number, body.body),
          };
      }
    } catch (error) {
      if (error instanceof ForgeOperationError)
        return reply.code(error.status).send({ error: error.message });
      request.log.warn(
        { err: error, projectId: project.id },
        'verity: repository operation failed',
      );
      return reply.code(502).send({ error: 'the code host request failed' });
    }
  });
}
