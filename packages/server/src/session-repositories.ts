import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { projectForRepository, type EventStore, type ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FORGE_PROXY_CA_FILE } from './brokered-forge-proxy.js';
import type { GitOutput } from './branches.js';
import { containerPathFor } from './project-backend.js';
import { projectClonePath } from './provisioner.js';

export function sessionRepositoryRoot(projectRoot: string, sessionId: string): string {
  return join(
    projectRoot,
    '.verity-repositories',
    createHash('sha256').update(sessionId).digest('hex').slice(0, 20),
  );
}

export async function removeSessionRepositoryWorkspaces(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  await rm(sessionRepositoryRoot(projectRoot, sessionId), { recursive: true, force: true });
}

export function createSessionRepositories(deps: {
  store: EventStore;
  cloneRoot?: string | undefined;
  git?: ((project: ProjectRecord, clonePath: string) => GitOutput) | undefined;
}) {
  const pending = new Map<string, Promise<unknown>>();
  async function list(sessionId: string) {
    const session = await deps.store.getSession(sessionId);
    if (!session?.projectId) throw new Error('project session required');
    const workspaces = await deps.store.listSessionRepositoryWorkspaces(sessionId);
    return {
      repositories: (
        await deps.store.listProjectRepositories(session.projectId, { includeRemoved: true })
      ).map((repository) => ({
        ...repository,
        workspace:
          workspaces.find((workspace) => workspace.repositoryId === repository.id) ??
          (repository.isDefault
            ? {
                sessionId,
                repositoryId: repository.id,
                projectId: session.projectId,
                worktree: session.worktree,
                branch: null,
              }
            : null),
      })),
    };
  }
  async function open(sessionId: string, repositoryId: string) {
    const key = `${sessionId}:${repositoryId}`;
    const running = pending.get(key);
    if (running) return running;
    const operation = (async () => {
      const session = await deps.store.getSession(sessionId);
      if (!session?.projectId) throw new Error('project session required');
      if (session.planning === 'active')
        throw new Error('repository checkout is unavailable while planning');
      const project = await deps.store.getProject(session.projectId);
      const repository = await deps.store.getProjectRepository(session.projectId, repositoryId);
      if (!project || !repository) throw new Error('repository is not connected to this project');
      if (repository.isDefault)
        return {
          workspace: {
            sessionId,
            repositoryId,
            projectId: project.id,
            worktree: session.worktree,
            branch: null,
          },
        };
      const existing = (await deps.store.listSessionRepositoryWorkspaces(sessionId)).find(
        (workspace) => workspace.repositoryId === repositoryId,
      );
      if (existing) return { workspace: existing };
      if (!deps.cloneRoot || !deps.git) throw new Error('project sandbox unavailable');
      const root = projectClonePath(deps.cloneRoot, project);
      const git = deps.git(project, root);
      const slot = createHash('sha256').update(repositoryId).digest('hex').slice(0, 20);
      const worktree = join(sessionRepositoryRoot(root, sessionId), slot);
      const target = projectForRepository(project, repository);
      let origin = 'https://github.com';
      if (target.kind === 'forgejo') {
        const connection = target.forgeConnectionId
          ? await deps.store.forgeConnections.get(target.forgeConnectionId)
          : undefined;
        if (!connection) throw new Error('code host connection unavailable');
        origin = connection.baseUrl.replace(/\/$/u, '');
      }
      // Copy the existing broker transport into the module checkout. Runtime
      // environment config is scoped to the default forge origin, so another host
      // needs its own settings before the initial fetch as well as later agent git.
      const proxy = (
        await git(['-C', session.worktree, 'config', '--get-regexp', '^http\\..*\\.proxy$'])
      )
        .trim()
        .split('\n')
        .map((line) => line.slice(line.indexOf(' ') + 1))
        .find(Boolean);
      if (!proxy) throw new Error('forge proxy transport unavailable');
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const transport = [
        `http.${origin}.proxy=${proxy}`,
        `http.${origin}.sslCAInfo=${FORGE_PROXY_CA_FILE}`,
        `http.${origin}.sslVerify=true`,
        `http.${origin}.version=HTTP/1.1`,
        `credential.${origin}.helper=`,
        `credential.${origin}.helper=!VERITY_FORGE_AUTHORITY=${quote(new URL(origin).host)} /opt/agent-seed/bin/verity-gh-cred`,
      ];
      const url = `${origin}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}.git`;
      const branch = `verity/${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}-${slot}`;
      const path = containerPathFor(worktree, root);
      // Every git command executes in the sandbox; credentials stay in the broker.
      // A clone left by an interrupted request is reused rather than overwritten.
      try {
        const discovered = (await git(['-C', worktree, 'rev-parse', '--show-toplevel'])).trim();
        if (discovered !== path) throw new Error('module checkout root mismatch');
      } catch {
        await git([
          '-C',
          session.worktree,
          'clone',
          ...transport.flatMap((config) => ['--config', config]),
          ...(repository.defaultBranch ? ['--branch', repository.defaultBranch] : []),
          '--',
          url,
          path,
        ]);
      }
      try {
        await git(['-C', worktree, 'show-ref', '--verify', `refs/heads/${branch}`]);
        await git(['-C', worktree, 'checkout', branch]);
      } catch {
        await git(['-C', worktree, 'checkout', '-b', branch]);
      }
      await git(['-C', worktree, 'config', 'verity.repositoryId', repository.id]);
      if (!(await deps.store.getProjectRepository(project.id, repositoryId)))
        throw new Error('repository connection was revoked');
      const workspace = await deps.store.upsertSessionRepositoryWorkspace({
        sessionId,
        repositoryId,
        projectId: project.id,
        worktree,
        branch,
      });
      return { workspace };
    })();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
    }
  }
  async function currentBranch(
    sessionId: string,
    repositoryId: string,
  ): Promise<string | undefined> {
    const session = await deps.store.getSession(sessionId);
    const project = session?.projectId ? await deps.store.getProject(session.projectId) : undefined;
    if (!session || !project || !deps.git || !deps.cloneRoot) return undefined;
    const workspace =
      repositoryId === `default:${project.id}`
        ? session.worktree
        : (await deps.store.listSessionRepositoryWorkspaces(sessionId)).find(
            (entry) => entry.repositoryId === repositoryId,
          )?.worktree;
    if (!workspace) return undefined;
    try {
      return (
        (
          await deps.git(
            project,
            projectClonePath(deps.cloneRoot, project),
          )(['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
        ).trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  async function openForSandbox(sessionId: string, repositoryId: string) {
    const result = z
      .object({ workspace: z.object({ worktree: z.string() }).passthrough() })
      .passthrough()
      .parse(await open(sessionId, repositoryId));
    const session = await deps.store.getSession(sessionId);
    const project = session?.projectId ? await deps.store.getProject(session.projectId) : undefined;
    if (!project || !deps.cloneRoot) throw new Error('project sandbox unavailable');
    return {
      ...result,
      workspace: {
        ...result.workspace,
        worktree: containerPathFor(
          result.workspace.worktree,
          projectClonePath(deps.cloneRoot, project),
        ),
      },
    };
  }
  return { list, open, currentBranch, openForSandbox };
}

export function registerSessionRepositoriesRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof createSessionRepositories>,
): void {
  app.get('/sessions/:id/repositories', async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return await service.list(id);
    } catch {
      return reply.code(404).send({ error: 'project session not found' });
    }
  });
  app.post('/sessions/:id/repositories/:repositoryId/open', async (request, reply) => {
    const { id, repositoryId } = z
      .object({ id: z.string().min(1), repositoryId: z.string().min(1) })
      .parse(request.params);
    try {
      return await service.open(id, repositoryId);
    } catch (error) {
      return reply.code(409).send({
        error:
          error instanceof Error &&
          /planning|revoked|not connected|unavailable|required/u.test(error.message)
            ? error.message
            : 'repository checkout failed',
      });
    }
  });
}
