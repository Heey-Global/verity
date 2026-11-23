import { projectForRepository, type SessionRecord } from '@verity/store';
import type { GitBranchService } from './branches.js';
import type { PullRequestStatus } from './forge-provider.js';
import type { ServerDeps } from './server-deps.js';

export function createSessionRepositoryPullRequests(
  { eventStore, projectPullRequests }: Pick<ServerDeps, 'eventStore' | 'projectPullRequests'>,
  branchesForSession: (session: SessionRecord) => Promise<GitBranchService | undefined>,
) {
  return async (
    session: SessionRecord,
    legacy?: PullRequestStatus | null,
    signal?: AbortSignal,
    repositoryId?: string,
  ) => {
    if (!session.projectId || !projectPullRequests) return undefined;
    const project = await eventStore.getProject(session.projectId);
    if (!project || project.kind === 'control_plane') return undefined;
    const [repositories, workspaces, branches] = await Promise.all([
      eventStore.listProjectRepositories(project.id),
      eventStore.listSessionRepositoryWorkspaces(session.sessionId),
      branchesForSession(session),
    ]);
    const results = await Promise.all(
      repositories
        .filter((repo) => repositoryId === undefined || repo.id === repositoryId)
        .map(async (repository) => {
          if (repository.kind !== 'github' && repository.kind !== 'forgejo') return [];
          const workspace = workspaces.find((row) => row.repositoryId === repository.id);
          const worktree = repository.isDefault ? session.worktree : workspace?.worktree;
          if (!worktree) return [];
          const target = projectForRepository(project, repository);
          const heads = new Set((await branches?.sessionBranches(worktree).catch(() => [])) ?? []);
          const recorded = new Map<number, string>();
          for (const pr of workspace?.pullRequests ?? []) {
            if (
              typeof pr !== 'object' ||
              pr === null ||
              !('head' in pr) ||
              typeof pr.head !== 'string' ||
              !('number' in pr) ||
              typeof pr.number !== 'number'
            )
              continue;
            recorded.set(pr.number, pr.head);
          }
          const connection =
            repository.kind === 'forgejo' && repository.forgeConnectionId
              ? await eventStore.forgeConnections.get(repository.forgeConnectionId)
              : undefined;
          const identity = {
            id: repository.id,
            name: repository.name,
            owner: repository.owner,
            repo: repository.repo,
            isDefault: repository.isDefault,
            ...(repository.kind === 'github'
              ? { codeHost: { provider: 'github' as const, baseUrl: 'https://github.com' } }
              : connection
                ? { codeHost: { provider: 'forgejo' as const, baseUrl: connection.baseUrl } }
                : {}),
          };
          const base = projectPullRequests.defaultBranch
            ? await projectPullRequests.defaultBranch(target).catch(() => null)
            : (repository.defaultBranch ?? 'main');
          if (base === null) throw new Error('Repository base branch unavailable');
          const statuses = new Map<number, { status: PullRequestStatus; head?: string }>();
          for (const head of heads) {
            if (signal?.aborted) break;
            if (!head || head === base) continue;
            const status = await projectPullRequests.status(target, head).catch(() => null);
            if (status) statuses.set(status.number, { status, head });
          }
          for (const [number, head] of recorded) {
            if (signal?.aborted) break;
            if (statuses.has(number)) continue;
            const status = await projectPullRequests.status(target, head, number).catch(() => null);
            if (status?.number === number) statuses.set(number, { status, head });
          }
          if (repository.isDefault && legacy !== undefined) {
            if (legacy && !statuses.has(legacy.number))
              statuses.set(legacy.number, {
                status:
                  projectPullRequests.defaultBranch && legacy.phase === 'open'
                    ? { ...legacy, mergeable: null, pipeline: 'unknown' }
                    : legacy,
              });
            for (const [number, { status }] of statuses) {
              if (status.phase === 'open' || number === legacy?.number) continue;
              // Legacy visibility can hide the old terminal row when editing resumes.
              // Keep independently recorded PRs unless their own status was hidden.
              if (
                (await eventStore.getSessionPrVisibility(session.sessionId, worktree, status.url))
                  ?.hidden
              )
                statuses.delete(number);
            }
          }
          return [...statuses.values()].map(({ status, head }) => ({
            status: { ...status, repository: identity },
            head,
            recorded: recorded.has(status.number),
            worktree,
            project: target,
          }));
        }),
    );
    return results.flat();
  };
}
