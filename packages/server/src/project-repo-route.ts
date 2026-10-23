import type { ProjectRecord } from '@verity/store';
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
  z.object({
    action: z.literal('pr.create'),
    title: text(256).min(1),
    body: text(65_536).default(''),
    head: branch,
    base: branch.optional(),
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
 * and its repository: a request can neither name another repository nor see a
 * token. Each action goes through the project's forge provider, so a new code
 * host needs no change here or in the sandbox.
 */
export function registerProjectRepoRoute(app: FastifyInstance, deps: ProjectRepoRouteDeps): void {
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
    const project = await deps.getProject(binding.projectId);
    if (project === undefined) return reply.code(404).send({ error: 'project not found' });
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
    const body = parsed.data;
    try {
      switch (body.action) {
        case 'pr.create': {
          const base = body.base ?? (await ops.defaultBranch());
          const existing = await ops.findPullRequest({ head: body.head });
          if (existing?.state === 'open')
            return reply.code(409).send({
              error: `pull request #${existing.number} is already open for ${body.head}`,
              pullRequest: existing,
            });
          const pullRequest = await ops.createPullRequest({
            head: body.head,
            base,
            title: body.title,
            body: body.body,
          });
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
          if (body.action === 'pr.view') return { host: repository.hostName, pullRequest: found };
          if (found.state !== 'open')
            return reply
              .code(409)
              .send({ error: `pull request #${found.number} is ${found.state}` });
          return {
            host: repository.hostName,
            pullRequest: await ops.markPullRequestReady(found.number),
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
