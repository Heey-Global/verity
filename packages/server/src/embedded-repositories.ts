import type { EventStore, ProjectRecord } from '@verity/store';
import type { createEmbeddedGitHub } from './embedded-github.js';
import { ForgejoTransport } from './forgejo-transport.js';
import type { ForgeDiscoveryPage, PullRequestStatus } from './forge-provider.js';
import { projectForgeProvider } from './project-forge-provider.js';
import { createProjectForgeStatusReader } from './project-forge-status.js';
import type { ProjectPullRequestBackend } from './project-pull-requests.js';

export function createEmbeddedRepositoryAccess(eventStore: EventStore) {
  const forgeRepositoryAccess = async (target: {
    owner: string;
    repo: string;
    forgeConnectionId?: string | null;
  }) => {
    if (!target.forgeConnectionId || target.forgeConnectionId === 'legacy-github') return undefined;
    const connection = await eventStore.forgeConnections.get(target.forgeConnectionId);
    if (!connection || connection.provider !== 'forgejo')
      throw new Error('Forgejo connection unavailable');
    const token = (await eventStore.forgeConnections.credentials(connection.id))?.personalToken;
    if (!token) throw new Error('Forgejo credentials unavailable');
    const transport = new ForgejoTransport(
      connection.baseUrl,
      () => Promise.resolve(token),
      connection.customCaPem,
    );
    return {
      url: `${transport.baseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}.git`,
      token,
      authorization: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
      customCaPem: connection.customCaPem ?? null,
    };
  };
  return forgeRepositoryAccess;
}

export function createEmbeddedRepositoryPullRequests(
  eventStore: EventStore,
  githubForge: ReturnType<typeof createEmbeddedGitHub>['githubForge'],
) {
  const { readProjectStatus, statusIdentity, invalidateStatus, invalidateProjectStatus } =
    createProjectForgeStatusReader((project) =>
      projectForgeProvider(eventStore, githubForge, project),
    );
  const isDefaultRepository = async (project: ProjectRecord) => {
    const stored = await eventStore.getProject(project.id);
    return (
      stored !== undefined &&
      stored.kind === project.kind &&
      stored.owner === project.owner &&
      stored.repo === project.repo
    );
  };
  const projectPullRequests: ProjectPullRequestBackend = {
    list: async (project) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider?.discover) throw new Error('Pull request listing unsupported');
      const pulls = new Map<number, ForgeDiscoveryPage['pulls'][number]>();
      // Three pages cover any open list a person scans on a phone; the host's
      // pages are newest first, so a cut drops the oldest pull requests.
      for (let page = 1; page <= 3; page += 1) {
        const result = await provider.discover(project, page);
        if (result.errors?.some((error) => error.step === 'pulls'))
          throw new Error('Pull requests unavailable');
        for (const pull of result.pulls) pulls.set(pull.number, pull);
        if (result.pulls.length < 30) break;
      }
      const remember = await isDefaultRepository(project);
      const deadline = Date.now() + 12_000;
      const rows = [...pulls.values()];
      const statuses = new Array<PullRequestStatus | null>(rows.length).fill(null);
      let next = 0;
      // Statuses are read a few at a time against one budget: a cold cache over
      // many pull requests leaves the slow ones without status instead of
      // turning the whole repository unavailable.
      const worker = async () => {
        while (next < rows.length && Date.now() < deadline) {
          const index = next++;
          const pull = rows[index]!;
          if (pull.fork) continue;
          let timer: NodeJS.Timeout | undefined;
          const status = await Promise.race([
            readProjectStatus(project, pull.branch, remember).catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
            }),
          ]).finally(() => clearTimeout(timer));
          statuses[index] =
            status && status.number === pull.number && status.phase === 'open' ? status : null;
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, rows.length) }, worker));
      return {
        webUrl: provider.cloneUrl(project).replace(/\.git$/u, ''),
        pulls: rows.map((pull, index) => ({ ...pull, status: statuses[index] ?? null })),
      };
    },
    status: async (project, branch) =>
      readProjectStatus(project, branch, await isDefaultRepository(project)),
    merge: async (project, number, expectedHeadSha) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider?.repositoryPrService) return false;
      try {
        return await provider.repositoryPrService(project).mergePr(number, expectedHeadSha);
      } finally {
        // A failed cache invalidation must not turn a completed merge into an error.
        await statusIdentity(project, provider)
          .then(invalidateStatus)
          .catch(() => undefined);
      }
    },
  };
  // Server dependencies that keep GitHub polling within the shared App quota.
  const forgeStatusDeps = {
    invalidateProjectPrStatus: invalidateProjectStatus,
    deferBackgroundForgeReads: async (projectId: string): Promise<boolean> => {
      try {
        const project = await eventStore.getProject(projectId);
        if (!project || project.kind === 'local' || project.kind === 'control_plane') return false;
        const provider = await projectForgeProvider(eventStore, githubForge, project);
        return provider?.deferBackgroundReads?.(project) ?? false;
      } catch {
        return false;
      }
    },
    githubDiagnostics: () => githubForge.rateDiagnostics?.(),
  };
  return { readProjectStatus, invalidateProjectStatus, projectPullRequests, forgeStatusDeps };
}
