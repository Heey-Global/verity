import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import { emitSessionEvent } from './session-event-writer.js';
import { registerGitSignRoute } from './git-sign-route.js';
import { registerGitHubTokenRoute } from './github-token-route.js';
import { registerPackageArtifactRoutes } from './package-artifact-routes.js';
import { registerPackageInstallRoute } from './package-install-route.js';
import { registerDependencyCapacityRoute } from './dependency-capacity-route.js';
import type { createServerSessionOverview } from './server-session-overview.js';
import { registerProjectRepoRoute } from './project-repo-route.js';
import {
  createSessionRepositories,
  registerSessionRepositoriesRoutes,
} from './session-repositories.js';

export function installRepositoryTools(
  app: FastifyInstance,
  ctx: ServerContext,
  branchesForSession: ReturnType<typeof createServerSessionOverview>['branchesForSession'],
): void {
  const { deps, conductor } = ctx;
  registerDependencyCapacityRoute(app, {
    store: deps.eventStore,
    ...(deps.dependencyCapacity ? { capacity: deps.dependencyCapacity } : {}),
    ...(deps.ghTokenCapabilities ? { capabilities: deps.ghTokenCapabilities } : {}),
  });
  registerGitSignRoute(app, {
    eventStore: deps.eventStore,
    ...(deps.signingCapabilities !== undefined
      ? { signingCapabilities: deps.signingCapabilities }
      : {}),
    ...(deps.turnCredentials !== undefined ? { turnCredentials: deps.turnCredentials } : {}),
    ...(deps.sshSign !== undefined ? { sshSign: deps.sshSign } : {}),
  });
  registerGitHubTokenRoute(app);
  if (deps.ghTokenCapabilities !== undefined) {
    registerPackageArtifactRoutes(app, { capabilities: deps.ghTokenCapabilities });
  }
  registerPackageInstallRoute(app, {
    store: deps.eventStore,
    conductor,
    appendNotice: async (sessionId, text) => {
      await emitSessionEvent(deps.eventStore, deps.bus, sessionId, {
        t: 'notice',
        text,
        role: 'agent',
      });
    },
    ...(deps.ghTokenCapabilities !== undefined ? { capabilities: deps.ghTokenCapabilities } : {}),
  });
  const sessionRepositories = createSessionRepositories({
    sessionStorage: deps.sessionStorage,
    store: deps.eventStore,
    cloneRoot: deps.projectCloneRoot,
    git: deps.sandboxGit,
  });
  registerSessionRepositoriesRoutes(app, sessionRepositories);
  if (deps.ghTokenCapabilities !== undefined && deps.projectRepository !== undefined) {
    registerProjectRepoRoute(app, {
      capabilities: deps.ghTokenCapabilities,
      getProject: (projectId) => deps.eventStore.getProject(projectId),
      repositoryFor: deps.projectRepository,
      store: deps.eventStore,
      openRepository: sessionRepositories.openForSandbox,
      currentRepositoryBranch: sessionRepositories.currentBranch,
      repositorySessionBranches: async (id, repositoryId) => {
        const session = await deps.eventStore.getSession(id);
        if (!session?.projectId) return [];
        const worktree =
          repositoryId === `default:${session.projectId}`
            ? session.worktree
            : (await deps.eventStore.listSessionRepositoryWorkspaces(id)).find(
                (workspace) => workspace.repositoryId === repositoryId,
              )?.worktree;
        if (!worktree) return [];
        const branches = await branchesForSession(session);
        return (await branches?.sessionBranches(worktree, true).catch(() => [])) ?? [];
      },
      pullRequestChanged: async (id, project) => {
        await deps.projectPullRequests?.invalidate?.(project).catch((err: unknown) => {
          app.log.warn({ err, sessionId: id }, 'Pull request status invalidation failed');
        });
        ctx.resources.invalidate(`/sessions/${encodeURIComponent(id)}/branches`);
      },
      getSession: (id) => deps.eventStore.getSession(id),
    });
  }
}
