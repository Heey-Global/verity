import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';
import { emitSessionEvent } from './session-event-writer.js';
import { registerGitSignRoute } from './git-sign-route.js';
import { registerGitHubTokenRoute } from './github-token-route.js';
import { registerPackageArtifactRoutes } from './package-artifact-routes.js';
import { registerPackageInstallRoute } from './package-install-route.js';
import { registerProjectRepoRoute } from './project-repo-route.js';
import {
  createSessionRepositories,
  registerSessionRepositoriesRoutes,
} from './session-repositories.js';

export function installRepositoryTools(app: FastifyInstance, ctx: ServerContext): void {
  const { deps, conductor } = ctx;
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
      getSession: (id) => deps.eventStore.getSession(id),
    });
  }
}
