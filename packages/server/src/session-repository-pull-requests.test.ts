import type { EventStore, ProjectRecord, SessionRecord } from '@verity/store';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { GitBranchService } from './branches.js';
import type { PullRequestStatus } from './forge-provider.js';
import type { ProjectPullRequestBackend } from './project-pull-requests.js';
import { registerSessionMergeRoutes } from './session-merge-routes.js';
import { createSessionRepositoryPullRequests } from './session-repository-pull-requests.js';

it('resolves historical and module PRs, and merges an equal-number PR only in the selected repository', async () => {
  const sha = 'a'.repeat(40);
  const session = { sessionId: 's', projectId: 'p', worktree: '/site' } as SessionRecord;
  const project = { id: 'p', kind: 'github', owner: 'team', repo: 'site' } as ProjectRecord;
  const site = {
    id: 'default:p',
    projectId: 'p',
    kind: 'github',
    name: 'site',
    owner: 'team',
    repo: 'site',
    isDefault: true,
    removedAt: null,
  };
  const api = { ...site, id: 'api', name: 'api', repo: 'api', isDefault: false };
  const store = {
    getSession: async () => session,
    getProject: async () => project,
    listProjectRepositories: async () => [site, api],
    listSessionRepositoryWorkspaces: async () => [
      { repositoryId: 'api', worktree: '/api', branch: 'feat/deleted' },
      {
        repositoryId: 'default:p',
        worktree: '/site',
        branch: 'feat/site',
        pullRequests: [{ number: 8, head: 'feat/site' }],
      },
    ],
    upsertSessionRepositoryWorkspace: vi.fn().mockResolvedValue(undefined),
    recordRepositoryPullRequest: vi.fn().mockResolvedValue(undefined),
    appendPendingNote: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventStore;
  const reset = vi.fn().mockResolvedValue({ base: 'main' });
  let legacyOnly = false;
  const branches = {
    sessionBranches: async (path: string) =>
      legacyOnly && path === '/site' ? [] : [path === '/api' ? 'feat/api' : 'feat/site'],
    current: async (path: string) => (path === '/api' ? 'feat/api' : 'feat/site'),
    headRevision: async () => sha,
    isDirty: async () => false,
    resetToMergedBase: reset,
  } as unknown as GitBranchService;
  const mergePR = vi.fn().mockResolvedValue(true);
  const hasOpenPullRequest = vi.fn().mockResolvedValue(false);
  const backend: ProjectPullRequestBackend = {
    list: vi.fn(),
    merge: mergePR,
    hasOpenPullRequest,
    status: async (
      target,
      branch,
      number = branch === 'feat/deleted' ? 99 : 7,
    ): Promise<PullRequestStatus> => ({
      number,
      url: `https://github.com/team/${target.repo}/pull/${number}`,
      title: 'Update',
      phase: 'open',
      pipeline: 'success',
      mergeable: true,
      baseRef: 'main',
      headSha: sha,
      checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
    }),
  };
  const branchesForSession = async () => branches;
  const resolvePullRequests = createSessionRepositoryPullRequests(
    { eventStore: store, projectPullRequests: backend },
    branchesForSession,
  );
  const rows = await resolvePullRequests(session);
  expect(rows?.map(({ status }) => [status.repository.id, status.number])).toEqual([
    ['default:p', 8],
    ['default:p', 7],
    ['api', 7],
  ]);

  const app = Fastify();
  const invalidate = vi.fn();
  const beforePrCleanup = vi.fn();
  const afterPrCleanup = vi.fn().mockResolvedValue(undefined);
  const legacyMerge = vi.fn();
  registerSessionMergeRoutes(app, {
    eventStore: store,
    mergePr: legacyMerge,
    projectPullRequests: backend,
    resolvePullRequests,
    invalidateBranchResource: invalidate,
    beforePrCleanup,
    afterPrCleanup,
    provisioner: undefined,
    branchPrStatus: undefined,
    branchPrStatusForBranches: undefined,
    sandboxGit: undefined,
    conductor: {
      dispatchTurn: vi.fn(),
      runWhenIdle: async (_id, action) => action(),
      emitMerged: vi.fn().mockResolvedValue(undefined),
      tryRunExclusive: vi.fn(),
      runExclusive: async (_id, action) => action(),
    },
    branchesForSession,
    localMergeTarget: async () => undefined,
    sessionPrStatus: async () =>
      legacyOnly ? await backend.status(project, 'feat/site', 7) : null,
    compactPr: () => null,
    applyPrSummaryAction: vi.fn(),
    invalidatePrSummaryAction: vi.fn(),
  });
  try {
    const merge = (repositoryId?: string) =>
      app.inject({
        method: 'POST',
        url: '/sessions/s/pull-request/merge',
        payload: { number: 7, repositoryId, expectedHeadSha: sha },
      });
    expect((await merge('unassigned')).statusCode).toBe(404);
    expect(mergePR).not.toHaveBeenCalled();
    expect((await merge('api')).json()).toEqual({ merged: true });
    expect(mergePR).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ repo: 'api' }),
      7,
      sha,
    );
    expect(legacyMerge).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledExactlyOnceWith('/api', {
      base: 'main',
      expectedHead: { branch: 'feat/api', sha },
    });
    expect(invalidate).toHaveBeenCalledWith('s');
    reset.mockClear();
    hasOpenPullRequest.mockResolvedValueOnce(true);
    expect((await merge('api')).json()).toEqual({ merged: true });
    expect(reset).not.toHaveBeenCalled();
    hasOpenPullRequest.mockRejectedValueOnce(new Error('Forge unavailable'));
    expect((await merge('api')).json()).toEqual({ merged: true });
    expect(reset).not.toHaveBeenCalled();
    expect(beforePrCleanup).not.toHaveBeenCalled();
    expect((await merge()).json()).toEqual({ merged: true });
    expect(reset).toHaveBeenCalledWith('/site', {
      base: 'main',
      expectedHead: { branch: 'feat/site', sha },
    });
    legacyOnly = true;
    expect((await merge('default:p')).json()).toEqual({ merged: true });
    expect(beforePrCleanup).toHaveBeenCalledWith(session);
    expect(afterPrCleanup).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ number: 7, phase: 'merged' }),
    );
    backend.defaultBranch = async () => 'main';
    mergePR.mockClear();
    const unverifiable = await merge('default:p');
    expect(unverifiable.statusCode).toBe(503);
    expect(unverifiable.json()).toMatchObject({ code: 'merge_status_unavailable' });
    expect(mergePR).not.toHaveBeenCalled();
    backend.defaultBranch = async () => {
      throw new Error('Metadata unavailable');
    };
    const recorded = await resolvePullRequests(session, undefined, undefined, 'default:p', 8);
    expect(recorded?.map(({ status }) => status.number)).toEqual([8]);
  } finally {
    await app.close();
  }
});
