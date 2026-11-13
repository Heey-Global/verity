import { expect, it, vi } from 'vitest';
import type { EventStore, ProjectRecord } from '@verity/store';
import { mkdtemp, mkdir, writeFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxUnavailableError } from './sandbox-git.js';
import {
  createSessionRepositories,
  describeCheckoutFailure,
  redactCheckoutOutput,
  sessionRepositoryRoot,
  removeSessionRepositoryWorkspaces,
} from './session-repositories.js';

function harness(planning = false, forge = false, cloneRoot = '/clones') {
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
  const git = vi.fn(async (args: readonly string[]): Promise<string> => {
    if (args.includes('rev-parse')) throw new Error('missing');
    return args.includes('--get-regexp') ? 'http.https://github.com.proxy http://broker:8080' : '';
  });
  const save = vi.fn(async (input: unknown) => input);
  const store = {
    getSession: vi.fn(async () => ({
      projectId: 'p',
      planning: planning ? 'active' : 'implemented',
      worktree: `${cloneRoot}/project/sessions/s`,
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
    service: createSessionRepositories({ store, cloneRoot, git: () => git }),
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
  expect(h.git.mock.calls.find(([args]) => args.includes('clone'))?.[0]).toContain(
    'http.https://github.com.version=HTTP/1.1',
  );
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
  expect(clone).toContain('http.https://forge.test:8443.version=HTTP/1.1');
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
it("points the agent at an opened repository's own AGENTS.md, and only when it exists", async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-instructions-'));
  try {
    const h = harness(false, false, root);
    // The session backend loads only its starting worktree's AGENTS.md; without
    // this pointer an agent would work in the module without the module's rules.
    const without = await h.service.openForSandbox('s', 'r');
    expect(without).not.toHaveProperty('instructions');
    const opened = (await h.service.open('s', 'r')) as { workspace: { worktree: string } };
    await mkdir(opened.workspace.worktree, { recursive: true });
    await writeFile(join(opened.workspace.worktree, 'AGENTS.md'), 'Run the API tests.');
    const withFile = await h.service.openForSandbox('s', 'r');
    expect(withFile.instructions).toBe(`${withFile.workspace.worktree}/AGENTS.md`);
    expect(withFile.instructions).toMatch(/^\/work\/\.verity-repositories\//u);
    // `AGENTS.md -> CLAUDE.md` inside the checkout is a file the agent can read;
    // a link out of the checkout is not reported, whatever it points at.
    await rm(join(opened.workspace.worktree, 'AGENTS.md'));
    await writeFile(join(opened.workspace.worktree, 'CLAUDE.md'), 'Shared rules.');
    await symlink('CLAUDE.md', join(opened.workspace.worktree, 'AGENTS.md'));
    expect((await h.service.openForSandbox('s', 'r')).instructions).toBe(withFile.instructions);
    await rm(join(opened.workspace.worktree, 'AGENTS.md'));
    await writeFile(join(root, 'outside.md'), 'Not this repository.');
    await symlink(join(root, 'outside.md'), join(opened.workspace.worktree, 'AGENTS.md'));
    expect(await h.service.openForSandbox('s', 'r')).not.toHaveProperty('instructions');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

it('never treats parent repository discovery as a reusable module checkout', async () => {
  const h = harness();
  const original = h.git.getMockImplementation()!;
  h.git.mockImplementation(async (args) => {
    if (args.includes('rev-parse')) return '/work';
    if (args.includes('clone')) throw new Error('partial checkout is not empty');
    return original(args);
  });
  await expect(h.service.open('s', 'r')).rejects.toMatchObject({
    reason: 'clone failed',
    cause: expect.objectContaining({ message: 'partial checkout is not empty' }),
  });
  expect(h.git.mock.calls.some(([args]) => args.includes('checkout'))).toBe(false);
  expect(h.save).not.toHaveBeenCalled();
});

it('categorizes checkout failures so a stopped sandbox is not reported as a failed clone', async () => {
  const h = harness();
  const original = h.git.getMockImplementation()!;
  h.git.mockImplementation(async (args) => {
    if (args.includes('clone')) throw new SandboxUnavailableError('sandbox');
    return original(args);
  });
  await expect(h.service.open('s', 'r')).rejects.toMatchObject({
    reason: 'project sandbox unavailable',
  });
  const noProxy = harness();
  noProxy.git.mockImplementation(async (args) => {
    if (args.includes('--get-regexp')) throw Object.assign(new Error('exit 1'), { code: 1 });
    return '';
  });
  await expect(noProxy.service.open('s', 'r')).rejects.toMatchObject({
    reason: 'forge proxy transport unavailable',
  });
  await expect(harness(true).service.open('s', 'r')).rejects.toMatchObject({
    reason: 'planning active',
  });
  await expect(h.service.open('s', 'foreign')).rejects.toMatchObject({
    reason: 'repository not connected',
  });
});

it('redacts credentials from logged git output and never logs the command line', () => {
  expect(
    redactCheckoutOutput(
      'fatal: https://user:ghp_abc123@github.com/x.git\nAuthorization: Basic Zm9v\nverity-broker-capvalue ghs_tok github_pat_11AB',
    ),
  ).toBe(
    'fatal: https://[redacted]@github.com/x.git\nAuthorization: [redacted]\nverity-broker-[redacted] [redacted] [redacted]',
  );
  const detail = describeCheckoutFailure(
    Object.assign(new Error('Command failed: git clone --config secret'), {
      code: 128,
      stderr: 'x'.repeat(5000),
    }),
  );
  expect(detail).toMatchObject({ reason: 'unexpected', exitCode: 128, causeName: 'Error' });
  expect(String(detail.stderr)).toHaveLength(1000);
  expect(JSON.stringify(detail)).not.toContain('Command failed');
});
