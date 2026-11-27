import type { ServerDeps } from './server-deps.js';
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
  const defaultBranches = new Map<string, { read: Promise<string>; expires: number }>();
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
            readProjectStatus(project, pull.branch, remember, pull.number).catch(() => null),
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
    status: async (project, branch, number) =>
      readProjectStatus(project, branch, await isDefaultRepository(project), number, true),
    defaultBranch: async (project) => {
      const key = JSON.stringify([
        project.id,
        project.kind,
        project.forgeConnectionId,
        project.owner,
        project.repo,
      ]);
      const cached = defaultBranches.get(key);
      const now = Date.now();
      if (cached && cached.expires > now) return cached.read;
      const read = (async () => {
        const provider = await projectForgeProvider(eventStore, githubForge, project);
        if (!provider) throw new Error('Repository base branch unavailable');
        return provider.repositoryOperations(project).defaultBranch();
      })();
      const entry = { read, expires: now + 60_000 };
      defaultBranches.set(key, entry);
      while (defaultBranches.size > 512)
        defaultBranches.delete(defaultBranches.keys().next().value!);
      void read.catch(() => {
        entry.expires = Math.min(entry.expires, Date.now() + 5_000);
      });
      return read;
    },
    hasOpenPullRequest: async (project, branch) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider) throw new Error('Pull request lookup unavailable');
      const pull = await provider.repositoryOperations(project).findPullRequest({ head: branch });
      return pull?.state === 'open';
    },
    invalidate: async (project) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (provider) invalidateStatus(await statusIdentity(project, provider));
    },
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

export function createEmbeddedRepositoryAnalysisBindings(ctx: {
  eventStore: EventStore;
  githubForge: ReturnType<typeof createEmbeddedGitHub>['githubForge'];
  githubQAAnalysis: ReturnType<typeof createEmbeddedGitHub>['githubQAAnalysis'];
  readProjectStatus: ReturnType<typeof createEmbeddedRepositoryPullRequests>['readProjectStatus'];
  projectPullRequests: ProjectPullRequestBackend;
}): Pick<
  ServerDeps,
  'repairPullRequest' | 'qaAnalysisRead' | 'projectPullRequests' | 'repairDiscovery'
> {
  const { eventStore, githubForge, githubQAAnalysis, readProjectStatus, projectPullRequests } = ctx;
  return {
    repairPullRequest: async (project, number) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      return (await provider?.repositoryOperations(project).findPullRequest({ number })) ?? null;
    },
    qaAnalysisRead: async (project, request, authorize) => {
      if (project.kind === 'forgejo') {
        await authorize();
        const provider = await projectForgeProvider(eventStore, githubForge, project);
        if (request.action === 'pulls' && provider?.discover) {
          const page = await provider.discover(project, request.page);
          await authorize();
          return {
            data: page.pulls,
            nextPage: page.nextPage,
            checkedAt: new Date().toISOString(),
            untrusted: true,
          };
        }
        if (request.action === 'pull_status' && provider) {
          const pull = await provider
            .repositoryOperations(project)
            .findPullRequest({ number: request.number });
          await authorize();
          const status = pull ? await readProjectStatus(project, pull.head) : null;
          await authorize();
          return {
            data: status?.number === request.number ? status : null,
            checkedAt: new Date().toISOString(),
            untrusted: true,
          };
        }
        return {
          available: false,
          reason:
            'This Forgejo integration supports PR reads, not historical Actions/release analysis',
        };
      }
      if (project.kind !== 'github')
        return { available: false, reason: 'This project has no supported repository provider' };
      return githubQAAnalysis(project, request, authorize);
    },
    projectPullRequests,
    repairDiscovery: async (project, pageNumber) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (!provider?.discover) throw new Error('Repository monitoring unsupported');
      const firstPage = await provider.discover(project, 1);
      const olderPage = pageNumber > 1 ? await provider.discover(project, pageNumber) : undefined;
      const page = olderPage
        ? {
            ...olderPage,
            pulls: [
              ...new Map(
                [...firstPage.pulls, ...olderPage.pulls].map((p) => [p.number, p]),
              ).values(),
            ],
            runs: [
              ...new Map([...firstPage.runs, ...olderPage.runs].map((r) => [r.id, r])).values(),
            ],
          }
        : firstPage;
      const statuses = [];
      for (const pull of page.pulls) {
        if (pull.fork) continue;
        const status = await readProjectStatus(project, pull.branch, true, pull.number);
        if (status && status.number === pull.number && status.headSha === pull.sha)
          statuses.push({ branch: pull.branch, status });
        else await eventStore.repairs.invalidateObservation(project.id, `pr:${pull.number}`);
      }
      for (const incident of await eventStore.repairs.incidents(project.id)) {
        if (
          !incident.resource.startsWith('pr:') ||
          ['resolved', 'superseded'].includes(incident.state)
        )
          continue;
        const evidence = JSON.parse(incident.evidence) as { branch?: string };
        if (
          !evidence.branch ||
          statuses.some((row) => `pr:${row.status.number}` === incident.resource)
        )
          continue;
        const tracked = await provider.repositoryOperations(project).findPullRequest({
          number: Number(incident.resource.slice(3)),
        });
        if (tracked && tracked.state !== 'open') {
          await eventStore.repairs.retireResource(project.id, incident.resource);
          continue;
        }
        const status = await readProjectStatus(
          project,
          evidence.branch,
          true,
          Number(incident.resource.slice(3)),
        );
        const discovered = page.pulls.find((p) => `pr:${p.number}` === incident.resource);
        if (
          status &&
          `pr:${status.number}` === incident.resource &&
          (!discovered || (!discovered.fork && status.headSha === discovered.sha))
        )
          statuses.push({ branch: evidence.branch, status });
      }
      return { page, statuses };
    },
  };
}

export function createEmbeddedProjectRepositoryBindings(ctx: {
  eventStore: EventStore;
  githubForge: ReturnType<typeof createEmbeddedGitHub>['githubForge'];
  forgeRepositoryAccess: ReturnType<typeof createEmbeddedRepositoryAccess>;
}): Pick<ServerDeps, 'projectRepository' | 'ghTokenMint'> {
  const { eventStore, githubForge, forgeRepositoryAccess } = ctx;
  return {
    // `verity-repo`: the project's code host executes pull request and issue actions.
    projectRepository: async (project: ProjectRecord) => {
      const provider = await projectForgeProvider(eventStore, githubForge, project);
      if (provider === undefined) return undefined;
      return {
        hostName: provider.id === 'forgejo' ? 'Forgejo' : 'GitHub',
        operations: provider.repositoryOperations(project),
        listIssues: () => provider.listIssues(project),
      };
    },
    ghTokenMint: async (project: {
      owner: string;
      repo: string;
      forgeConnectionId?: string | null;
    }) => (await forgeRepositoryAccess(project))?.token ?? githubForge.mintProjectToken(project),
  };
}

export function createEmbeddedRepositoryReadBindings(ctx: {
  eventStore: EventStore;
  githubForge: ReturnType<typeof createEmbeddedGitHub>['githubForge'];
}): Pick<ServerDeps, 'listProjectGitHubIssues' | 'latestRelease' | 'refreshLatestRelease'> {
  const { eventStore, githubForge } = ctx;
  return {
    listProjectGitHubIssues: async (project: ProjectRecord) =>
      (await projectForgeProvider(eventStore, githubForge, project))?.listIssues(project) ?? {
        connected: false,
        viewerLogin: null,
        issues: [],
      },
    latestRelease: (owner: string, repo: string) => githubForge.latestRelease({ owner, repo }),
    refreshLatestRelease: (owner: string, repo: string) =>
      githubForge.refreshLatestRelease({ owner, repo }),
  };
}
