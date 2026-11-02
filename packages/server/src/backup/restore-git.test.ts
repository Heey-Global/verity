import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureMetadataSchema, type CaptureMetadata } from './capture-metadata.js';
import { runBackupGit } from './git.js';
import { prepareRestoredGit } from './restore-git.js';
vi.mock('./git.js', async (original) => ({
  ...(await original<typeof import('./git.js')>()),
  runBackupGit: vi.fn(async () => true),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(runBackupGit).mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-restore-git-guard-'));
  roots.push(root);
  const repoKey = randomUUID();
  const git = join(root, 'git', repoKey, 'git');
  const users = join(root, 'git', repoKey, 'user-files');
  await mkdir(git, { recursive: true });
  await mkdir(users);
  await mkdir(join(root, 'workspaces/project'), { recursive: true });
  await mkdir(join(root, 'sessions/project'), { recursive: true });
  await writeFile(join(git, 'config'), '[core]\nrepositoryformatversion = 0\n');
  const metadata: CaptureMetadata = {
    startedAt: '2026-10-01T00:00:00Z',
    finishedAt: '2026-10-01T00:01:00Z',
    databaseAt: '2026-10-01T00:00:00Z',
    barrierMs: 1,
    sourceRoot: '/original',
    architecture: 'amd64',
    image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
    scope: ['database', 'workspaces', 'sessions', 'knowledge', 'identity'],
    activeTurns: [],
    projects: [
      {
        id: 'p',
        state: 'active',
        archived: false,
        paths: ['workspaces/project', 'sessions/project'],
        bytes: '0',
        warnings: [],
      },
    ],
    exclusions: [],
    warnings: [],
    identity: [
      'deployment-id',
      'pairing-identity.pem',
      'tls-key.pem',
      'tls-cert.pem',
      'tls-ca-cert.pem',
    ],
    caKey: { installationId: randomUUID(), keyGeneration: 1, path: 'identity/ca-key.age' },
    git: [
      {
        repoKey,
        projectId: 'p',
        path: 'workspaces/project/.git',
        status: 'validated',
        findings: [],
        pointers: [],
      },
    ],
  };
  return { root, git, users, metadata };
}
describe('restore Git trust boundary', () => {
  it('validates working pointers before Git and writes final-host paths before promotion', async () => {
    const { root, users, metadata } = await fixture();
    await writeFile(
      join(root, 'sessions/project/.git'),
      'gitdir: /original/workspaces/project/.git\n',
    );
    const original = '[include]\npath = /untrusted/config\n';
    await writeFile(join(users, 'config'), original);
    vi.mocked(runBackupGit).mockImplementation(async () => {
      expect(await readFile(join(root, 'workspaces/project/.git/config'), 'utf8')).not.toContain(
        'include',
      );
      expect(await readFile(join(root, 'sessions/project/.git'), 'utf8')).toContain(root);
      return true;
    });
    expect(await prepareRestoredGit(root, metadata, '/final/data')).toEqual([]);
    expect(runBackupGit).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, 'sessions/project/.git'), 'utf8')).toBe(
      'gitdir: /final/data/workspaces/project/.git\n',
    );
    expect(await readFile(join(root, 'workspaces/project/.git/config'), 'utf8')).toBe(original);
    vi.mocked(runBackupGit).mockImplementation(async () => true);
  });
  it.each(['outside', 'symlink', 'unlisted'])(
    'refuses %s pointers before any Git command',
    async (attack) => {
      const { root, git, metadata } = await fixture();
      if (attack === 'outside')
        await writeFile(join(root, 'sessions/project/.git'), 'gitdir: /outside/repository\n');
      if (attack === 'symlink')
        await symlink('/outside/repository', join(root, 'sessions/project/.git'));
      if (attack === 'unlisted') await writeFile(join(git, 'commondir'), '/outside/repository\n');
      await expect(prepareRestoredGit(root, metadata)).rejects.toThrow();
      expect(runBackupGit).not.toHaveBeenCalled();
    },
  );
  it('rejects ambiguous project ownership and Git paths outside project roots', async () => {
    const { metadata } = await fixture();
    metadata.projects.push({
      ...metadata.projects[0]!,
      id: 'other',
      paths: ['workspaces/project/nested'],
    });
    expect(captureMetadataSchema.safeParse(metadata).success).toBe(false);
    metadata.projects.pop();
    metadata.git[0]!.path = 'sessions/other/.git';
    expect(captureMetadataSchema.safeParse(metadata).success).toBe(false);
    metadata.git[0]!.path = 'workspaces/project/.git';
    metadata.sourceRoot = '/original/../elsewhere';
    expect(captureMetadataSchema.safeParse(metadata).success).toBe(false);
  });
});
