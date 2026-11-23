import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { createEmbeddedRepositoryAccess } from './embedded-repositories.js';
import type { ServerDeps } from './server-deps.js';
import { selectBranchStatus } from './forge-status-cache.js';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { EventStore } from '@verity/store';
import type { EmbeddedServerConfig } from './embedded-types.js';
import type { createEmbeddedGitHub } from './embedded-github.js';
import type { createEmbeddedRepositoryPullRequests } from './embedded-repositories.js';
import {
  createProjectWorktreeFactory,
  resolveRepoWorktreeFetchAuthHeader,
} from './embedded-support.js';
import { projectClonePath } from './provisioner.js';
import { projectForgeProvider } from './project-forge-provider.js';
import { createGitWorktreeProvisioner } from './worktree.js';

type GitHub = ReturnType<typeof createEmbeddedGitHub>;

export function createEmbeddedWorktreeForge(
  config: Pick<EmbeddedServerConfig, 'hostCloneRoot'>,
  eventStore: EventStore,
  githubForge: GitHub['githubForge'],
) {
  const forgeForWorktree = async (worktree: string) => {
    if (config.hostCloneRoot) {
      for (const project of await eventStore.listProjects({ includeHidden: true })) {
        const suffix = relative(projectClonePath(config.hostCloneRoot, project), worktree);
        if (
          suffix === '' ||
          (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep))
        ) {
          return projectForgeProvider(eventStore, githubForge, project);
        }
      }
    }
    return githubForge;
  };
  return forgeForWorktree;
}

export function createEmbeddedWorktreeStatus(
  eventStore: EventStore,
  readProjectStatus: ReturnType<typeof createEmbeddedRepositoryPullRequests>['readProjectStatus'],
  forgeForWorktree: ReturnType<typeof createEmbeddedWorktreeForge>,
) {
  const readWorktreeStatus = async (branch: string, worktree: string) => {
    const session = (await eventStore.listSessions()).find((row) => row.worktree === worktree);
    const project = session?.projectId ? await eventStore.getProject(session.projectId) : undefined;
    return project
      ? readProjectStatus(project, branch)
      : ((await forgeForWorktree(worktree))?.prServiceFor(worktree).prStatusForBranch(branch) ??
          null);
  };
  return readWorktreeStatus;
}

export function createEmbeddedWorktrees(
  config: Pick<EmbeddedServerConfig, 'repoDir' | 'workspacesDir'>,
  githubForge: GitHub['githubForge'],
  cachedProjectTokenMint: GitHub['cachedProjectTokenMint'],
) {
  // Real git worktrees only when a project repo is configured; else the server's
  // scratch-dir default (spawned agents start on an empty dir, no repo).
  // Verity Control/default Verity sessions branch from `/work`, so their refresh fetch
  // must authenticate through the DB-backed GitHub App too. DB-only onboarding
  // deployments intentionally do not carry a broad `.gh-token`; without this header
  // `git fetch origin main` fails before the Verity Control session can be created.
  const worktrees = config.repoDir
    ? createGitWorktreeProvisioner({
        repoDir: config.repoDir,
        worktreeRoot: config.workspacesDir ?? join(tmpdir(), 'verity-sessions'),
        baseBranch: 'main',
        // Fetch `main` from origin before branching so each spawn starts from
        // the latest integration tip, not the clone's last-synced `main`.
        refreshBase: true,
        fetchAuthHeader: () =>
          resolveRepoWorktreeFetchAuthHeader(
            githubForge.identityFor(config.repoDir as string),
            cachedProjectTokenMint,
          ),
      })
    : undefined;

  return worktrees;
}

export function createEmbeddedWorktreeBindings(ctx: {
  forgeForWorktree: ReturnType<typeof createEmbeddedWorktreeForge>;
  readWorktreeStatus: ReturnType<typeof createEmbeddedWorktreeStatus>;
}): Pick<
  ServerDeps,
  'branchPr' | 'branchPrStatus' | 'branchPrStatusForBranches' | 'mergePr' | 'repoIdentity'
> {
  const { forgeForWorktree, readWorktreeStatus } = ctx;
  return {
    branchPr: async (b: string, wt: string) =>
      (await forgeForWorktree(wt))?.prServiceFor(wt).prForBranch(b) ?? null,
    branchPrStatus: readWorktreeStatus,
    branchPrStatusForBranches: async (bs: readonly string[], wt: string) => {
      const values = [];
      for (const branch of bs) values.push(await readWorktreeStatus(branch, wt));
      return selectBranchStatus(values, (await forgeForWorktree(wt))?.id ?? 'github');
    },
    mergePr: async (n: number, wt: string, expectedHeadSha?: string) =>
      (await forgeForWorktree(wt))?.prServiceFor(wt).mergePr(n, expectedHeadSha) ?? false,
    repoIdentity: async (wt: string) => (await forgeForWorktree(wt))?.identityFor(wt)() ?? null,
  };
}

export function createEmbeddedProjectWorktrees(
  projectTokenMint: Parameters<typeof createProjectWorktreeFactory>[0],
  forgeRepositoryAccess: ReturnType<typeof createEmbeddedRepositoryAccess>,
  secretRoot: string,
): ReturnType<typeof createProjectWorktreeFactory> {
  // Session worktrees use their project's provider: GitHub App tokens or the
  // current Forgejo connection token and CA. Neither credential is persisted
  // in the clone or worktree.
  return createProjectWorktreeFactory(projectTokenMint, async (project) => {
    const access = await forgeRepositoryAccess(project);
    if (!access) throw new Error('Forgejo connection unavailable');
    let caPath: string | undefined;
    if (access.customCaPem) {
      const directory = join(secretRoot, 'git');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      caPath = join(directory, `forge_ca.${project.forgeConnectionId ?? project.id}`);
      const temporary = `${caPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, access.customCaPem, { mode: 0o600 });
        await rename(temporary, caPath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return {
      url: access.url,
      authorization: access.authorization,
      ...(caPath ? { caPath } : {}),
    };
  });
}
