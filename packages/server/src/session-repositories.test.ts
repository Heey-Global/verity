import { expect, it, vi } from 'vitest';
import type { EventStore, ProjectRecord } from '@verity/store';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionRepositories,
  sessionRepositoryRoot,
  removeSessionRepositoryWorkspaces,
} from './session-repositories.js';

function harness(planning = false, forge = false) {
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
    kind: forge ? 'forgejo' : 'github',
    owner: 'other',
    repo: 'api',
    forgeConnectionId: forge ? 'forge' : 'legacy-github',
    defaultBranch: 'main',
    isDefault: false,
    removedAt: null,
  };
  let revoked = false;
  const git = vi.fn(async (args: readonly string[]) => {
    if (args.includes('rev-parse')) throw new Error('missing');
    return args.includes('--get-regexp') ? 'http.https://github.com.proxy http://broker:8080' : '';
  });
  const save = vi.fn(async (input: unknown) => input);
  const store = {
    getSession: vi.fn(async () => ({
      projectId: 'p',
      planning: planning ? 'active' : 'implemented',
      worktree: '/clones/project/sessions/s',
    })),
    getProject: vi.fn(async () => project),
    forgeConnections: { get: vi.fn(async () => ({ baseUrl: 'https://forge.test:8443' })) },
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

it('persists broker proxy, CA and a host-specific capability helper before cross-host clone fetches', async () => {
  const h = harness(false, true);
  await h.service.open('s', 'r');
  const clone = h.git.mock.calls.find(([args]) => args.includes('clone'))?.[0];
  expect(clone).toContain('http.https://forge.test:8443.proxy=http://broker:8080');
  expect(clone).toContain('http.https://forge.test:8443.sslCAInfo=/run/verity/forge-proxy/ca.crt');
  expect(clone).toContain(
    "credential.https://forge.test:8443.helper=!VERITY_FORGE_AUTHORITY='forge.test:8443' /opt/agent-seed/bin/verity-gh-cred",
  );
  expect(clone).toContain('https://forge.test:8443/other/api.git');
});

it('returns a container-accessible module path to sandbox callers', async () => {
  const h = harness();
  const opened = await h.service.openForSandbox('s', 'r');
  expect(opened.workspace.worktree).toMatch(/^\/work\/\.verity-repositories\//);
  expect(opened.workspace.worktree).not.toContain('/clones/');
});
it('cleans deterministic module paths after workspace database rows have disappeared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-cleanup-'));
  try {
    const module = join(sessionRepositoryRoot(root, 'deleted'), 'repo');
    const retained = sessionRepositoryRoot(root, 'other');
    await mkdir(module, { recursive: true });
    await mkdir(retained, { recursive: true });
    await writeFile(join(module, 'tracked.txt'), 'repository data');
    await removeSessionRepositoryWorkspaces(root, 'deleted');
    await expect(access(module)).rejects.toThrow();
    await expect(access(retained)).resolves.toBeUndefined();
    await removeSessionRepositoryWorkspaces(root, 'deleted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
