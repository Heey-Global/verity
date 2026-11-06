import { expect, it, vi } from 'vitest';
import type { EventStore, ProjectRecord } from '@verity/store';
import { createSessionRepositories } from './session-repositories.js';

function harness(planning = false) {
  const project = {
    id: 'p',
    kind: 'github',
    owner: 'app',
    repo: 'main',
    cloneDir: 'project',
    containerName: 'sandbox',
  } as ProjectRecord;
  const repository = {
    id: 'r',
    projectId: 'p',
    name: 'API',
    kind: 'github',
    owner: 'other',
    repo: 'api',
    forgeConnectionId: 'legacy-github',
    defaultBranch: 'main',
    isDefault: false,
    removedAt: null,
  };
  let revoked = false;
  const git = vi.fn(async (args: readonly string[]) => {
    if (args.includes('rev-parse')) throw new Error('missing');
    return '';
  });
  const save = vi.fn(async (input: unknown) => input);
  const store = {
    getSession: vi.fn(async () => ({
      projectId: 'p',
      planning: planning ? 'active' : 'implemented',
      worktree: '/clones/project/sessions/s',
    })),
    getProject: vi.fn(async () => project),
    getProjectRepository: vi.fn(async (_project: string, id: string) =>
      id === 'r' && !revoked ? repository : undefined,
    ),
    listSessionRepositoryWorkspaces: vi.fn(async () => []),
    upsertSessionRepositoryWorkspace: save,
  } as unknown as EventStore;
  return {
    service: createSessionRepositories({ store, cloneRoot: '/clones', git: () => git }),
    git,
    save,
    revoke: () => {
      revoked = true;
    },
  };
}
it('creates isolated module workspaces without resetting existing branch history', async () => {
  const h = harness();
  const result = (await h.service.open('s', 'r')) as { workspace: { worktree: string } };
  expect(result.workspace.worktree).toMatch(/^\/clones\/project\/\.verity-repositories\//);
  expect(h.git.mock.calls.some(([args]) => args.includes('clone'))).toBe(true);
  expect(h.git.mock.calls.some(([args]) => args.includes('-B'))).toBe(false);
  expect(h.save).toHaveBeenCalledTimes(1);
});
it('refuses unassigned repositories and read-only planning sessions before git runs', async () => {
  const h = harness();
  await expect(h.service.open('s', 'foreign')).rejects.toThrow('not connected');
  expect(h.git).not.toHaveBeenCalled();
  const readOnly = harness(true);
  await expect(readOnly.service.open('s', 'r')).rejects.toThrow('planning');
  expect(readOnly.git).not.toHaveBeenCalled();
});
