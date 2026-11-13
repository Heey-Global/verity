import { createHash } from 'node:crypto';
import { realpath, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { projectForRepository, type EventStore, type ProjectRecord } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FORGE_PROXY_CA_FILE } from './brokered-forge-proxy.js';
import type { GitOutput } from './branches.js';
import { containerPathFor } from './project-backend.js';
import { projectClonePath } from './provisioner.js';
import { SandboxUnavailableError } from './sandbox-git.js';

/** Why a module checkout could not be opened. A closed set, so the category can
 *  reach the sandbox and the log without carrying git output, URLs or paths. */
export type RepositoryCheckoutFailure =
  | 'project session required'
  | 'planning active'
  | 'repository not connected'
  | 'project sandbox unavailable'
  | 'code host connection unavailable'
  | 'forge proxy transport unavailable'
  | 'clone failed'
  | 'branch checkout failed'
  | 'repository connection revoked';

export class RepositoryCheckoutError extends Error {
  constructor(
    readonly reason: RepositoryCheckoutFailure,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'RepositoryCheckoutError';
    if (cause !== undefined) this.cause = cause;
  }
}

const STDERR_LOG_LIMIT = 1000;

/** Remove what git output can carry besides the failure itself: URL userinfo,
 *  broker capability placeholders, provider tokens and authorization headers. */
export function redactCheckoutOutput(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/giu, '$1[redacted]@')
    .replace(/verity-broker-[^\s'"]*/gu, 'verity-broker-[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]+/gu, '[redacted]')
    .replace(/(authorization:\s*)[^\r\n]*/giu, '$1[redacted]')
    .replace(/[^\P{Cc}\n\t]/gu, '');
}

/** The category of any checkout failure, including git steps that are not
 *  wrapped individually: a stopped sandbox is never reported as a git failure. */
export function checkoutFailureReason(
  error: unknown,
): RepositoryCheckoutFailure | 'checkout failed' {
  if (error instanceof RepositoryCheckoutError) return error.reason;
  if (error instanceof SandboxUnavailableError) return 'project sandbox unavailable';
  return 'checkout failed';
}

/** Log fields for a failed checkout. Never the error message: for a git step it
 *  is the full command line. The stderr tail is redacted and bounded. */
export function describeCheckoutFailure(error: unknown): Record<string, unknown> {
  const reason = checkoutFailureReason(error);
  const cause = error instanceof RepositoryCheckoutError ? error.cause : error;
  const detail: Record<string, unknown> = { reason };
  if (cause instanceof Error) detail.causeName = cause.name;
  if (typeof cause === 'object' && cause !== null) {
    const { code, signal, killed, stderr } = cause as {
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      stderr?: unknown;
    };
    if (typeof code === 'number') detail.exitCode = code;
    else if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(code)) detail.code = code;
    if (typeof signal === 'string') detail.signal = signal;
    if (killed === true) detail.killed = true;
    if (typeof stderr === 'string' && stderr.trim() !== '')
      detail.stderr = redactCheckoutOutput(stderr.trim()).slice(-STDERR_LOG_LIMIT);
  }
  return detail;
}

/** A git step failed: keep the sandbox's own absence distinguishable from a git
 *  failure, which a stopped container would otherwise be reported as. */
function gitStepFailed(reason: RepositoryCheckoutFailure, error: unknown): RepositoryCheckoutError {
  return error instanceof SandboxUnavailableError
    ? new RepositoryCheckoutError('project sandbox unavailable', error.message, error)
    : new RepositoryCheckoutError(reason, `repository ${reason}`, error);
}

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

/** Whether a checkout has a root AGENTS.md an agent can read. A symlink to a
 *  file inside the checkout counts (`AGENTS.md -> CLAUDE.md` is common); one
 *  that leaves it does not, so the server never reports on host paths outside. */
async function repositoryInstructionsFile(worktree: string): Promise<boolean> {
  try {
    const root = await realpath(worktree);
    const target = await realpath(join(worktree, 'AGENTS.md'));
    return target.startsWith(root + sep) && (await stat(target)).isFile();
  } catch {
    return false;
  }
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
      if (!session?.projectId)
        throw new RepositoryCheckoutError('project session required', 'project session required');
      if (session.planning === 'active')
        throw new RepositoryCheckoutError(
          'planning active',
          'repository checkout is unavailable while planning',
        );
      const project = await deps.store.getProject(session.projectId);
      const repository = await deps.store.getProjectRepository(session.projectId, repositoryId);
      if (!project || !repository)
        throw new RepositoryCheckoutError(
          'repository not connected',
          'repository is not connected to this project',
        );
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
      if (!deps.cloneRoot || !deps.git)
        throw new RepositoryCheckoutError(
          'project sandbox unavailable',
          'project sandbox unavailable',
        );
      const root = projectClonePath(deps.cloneRoot, project);
      const git = deps.git(project, root);
      const slot = createHash('sha256').update(repositoryId).digest('hex').slice(0, 20);
      const worktree = join(sessionRepositoryRoot(root, sessionId), slot);
      let target: ProjectRecord;
      try {
        target = projectForRepository(project, repository);
      } catch (error) {
        throw new RepositoryCheckoutError(
          'repository not connected',
          'repository is not connected to this project',
          error,
        );
      }
      let origin = 'https://github.com';
      if (target.kind === 'forgejo') {
        const connection = target.forgeConnectionId
          ? await deps.store.forgeConnections.get(target.forgeConnectionId)
          : undefined;
        if (!connection)
          throw new RepositoryCheckoutError(
            'code host connection unavailable',
            'code host connection unavailable',
          );
        origin = connection.baseUrl.replace(/\/$/u, '');
      }
      // Copy the existing broker transport into the module checkout. Runtime
      // environment config is scoped to the default forge origin, so another host
      // needs its own settings before the initial fetch as well as later agent git.
      let proxyConfig: string;
      try {
        proxyConfig = await git([
          '-C',
          session.worktree,
          'config',
          '--get-regexp',
          '^http\\..*\\.proxy$',
        ]);
      } catch (error) {
        // `git config --get-regexp` exits 1 when nothing matches. Any other
        // failure is not a missing proxy and keeps its own classification.
        if ((error as { code?: unknown } | null)?.code !== 1) throw error;
        proxyConfig = '';
      }
      const proxy = proxyConfig
        .trim()
        .split('\n')
        .map((line) => line.slice(line.indexOf(' ') + 1))
        .find(Boolean);
      if (!proxy)
        throw new RepositoryCheckoutError(
          'forge proxy transport unavailable',
          'forge proxy transport unavailable',
        );
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
        ]).catch((error: unknown) => {
          throw gitStepFailed('clone failed', error);
        });
      }
      try {
        await git(['-C', worktree, 'show-ref', '--verify', `refs/heads/${branch}`]);
        await git(['-C', worktree, 'checkout', branch]);
      } catch {
        await git(['-C', worktree, 'checkout', '-b', branch]).catch((error: unknown) => {
          throw gitStepFailed('branch checkout failed', error);
        });
      }
      await git(['-C', worktree, 'config', 'verity.repositoryId', repository.id]).catch(
        (error: unknown) => {
          throw gitStepFailed('branch checkout failed', error);
        },
      );
      if (!(await deps.store.getProjectRepository(project.id, repositoryId)))
        throw new RepositoryCheckoutError(
          'repository connection revoked',
          'repository connection was revoked',
        );
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
    if (!project || !deps.cloneRoot)
      throw new RepositoryCheckoutError(
        'project sandbox unavailable',
        'project sandbox unavailable',
      );
    const root = projectClonePath(deps.cloneRoot, project);
    const worktree = containerPathFor(result.workspace.worktree, root);
    // The session backend loads only the AGENTS.md of the worktree it starts in.
    // A repository opened later brings its own, which the agent has to be told
    // about or it works there without that repository's rules.
    const instructions =
      result.workspace.worktree !== session?.worktree &&
      (await repositoryInstructionsFile(result.workspace.worktree))
        ? `${worktree}/AGENTS.md`
        : undefined;
    return {
      ...result,
      workspace: { ...result.workspace, worktree },
      ...(instructions !== undefined ? { instructions } : {}),
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
