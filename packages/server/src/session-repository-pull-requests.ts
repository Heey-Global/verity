import { projectForRepository, type ProjectRecord, type SessionRecord } from '@verity/store';
import type { GitBranchService } from './branches.js';
import type { PullRequestStatus } from './forge-provider.js';
import type { ServerDeps } from './server-deps.js';

type ResolvedPullRequest = {
  status: PullRequestStatus & {
    repository: {
      id: string;
      name: string;
      owner: string;
      repo: string;
      isDefault: boolean;
      codeHost?: { provider: 'github' | 'forgejo'; baseUrl: string };
    };
  };
  head: string | undefined;
  recorded: boolean;
  defaultBranch: string | null;
  worktree: string;
  project: ProjectRecord;
};

export function createSessionRepositoryPullRequests(
  { eventStore, projectPullRequests }: Pick<ServerDeps, 'eventStore' | 'projectPullRequests'>,
  branchesForSession: (session: SessionRecord) => Promise<GitBranchService | undefined>,
) {
  const previous = new Map<string, ResolvedPullRequest[]>();
  return async (
    session: SessionRecord,
    legacy?: PullRequestStatus | null,
    signal?: AbortSignal,
    repositoryId?: string,
    pullRequestNumber?: number,
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
          const key = JSON.stringify([session.sessionId, repository.id]);
          try {
            if (repository.kind !== 'github' && repository.kind !== 'forgejo') return [];
            const workspace = workspaces.find((row) => row.repositoryId === repository.id);
            const worktree = repository.isDefault ? session.worktree : workspace?.worktree;
            if (!worktree) return [];
            const target = projectForRepository(project, repository);
            const heads = new Set(
              (await branches?.sessionBranches(worktree, true).catch(() => [])) ?? [],
            );
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
            const readStatus = (head: string, number?: number) =>
              projectPullRequests.status(target, head, number);
            const statuses = new Map<number, { status: PullRequestStatus; head?: string }>();
            for (const [number, head] of recorded) {
              if (signal?.aborted) break;
              if (pullRequestNumber !== undefined && number !== pullRequestNumber) continue;
              const status = await readStatus(head, number);
              if (status?.number === number) statuses.set(number, { status, head });
            }
            if (
              base === null &&
              (pullRequestNumber === undefined || !recorded.has(pullRequestNumber))
            )
              throw new Error('Repository base branch unavailable');
            if (
              base !== null &&
              (pullRequestNumber === undefined || !recorded.has(pullRequestNumber))
            ) {
              for (const head of heads) {
                if (signal?.aborted) break;
                if (!head || head === base) continue;
                const status = await readStatus(head, pullRequestNumber);
                if (status && !statuses.has(status.number))
                  statuses.set(status.number, { status, head });
              }
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
            const rows = [...statuses.values()].map(({ status, head }) => ({
              status: { ...status, repository: identity },
              head,
              recorded: recorded.has(status.number),
              defaultBranch: base,
              worktree,
              project: target,
            }));
            if (repositoryId === undefined && !signal?.aborted) {
              previous.set(key, rows);
              if (previous.size > 512) previous.delete(previous.keys().next().value!);
            }
            return rows;
          } catch (err) {
            if (repositoryId !== undefined) throw err;
            return (previous.get(key) ?? []).map((row): ResolvedPullRequest => ({
              ...row,
              status: {
                ...row.status,
                pipeline: 'unknown',
                mergeable: null,
                observationFailed: true,
              },
            }));
          }
        }),
    );
    return results.flat();
  };
}
