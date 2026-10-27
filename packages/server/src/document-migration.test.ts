import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
  readlink,
  lstat,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { DOCUMENT_SESSION_DIRECTORY } from './document-workspace.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLocalDocuments } from './document-migration.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('retains ignored and orphan session files and resumes after a database interruption', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'document-migration-'));
  roots.push(dataRoot);
  const workspace = join(dataRoot, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(workspace, '.verity-sessions', 'orphan'), { recursive: true });
  await writeFile(join(workspace, '.git', 'history'), 'history');
  await writeFile(join(workspace, '.ignored'), 'untracked');
  await writeFile(join(workspace, '.verity-sessions', 'orphan', 'draft'), 'draft');
  const store = {
    listSessions: vi
      .fn()
      .mockResolvedValue([{ projectId: 'p', sessionId: 's', worktree: workspace }]),
    replaceLocalSessionWorkspace: vi
      .fn()
      .mockRejectedValueOnce(new Error('database interrupted'))
      .mockResolvedValue(undefined),
  };
  const input = { dataRoot, projectId: 'p', workspace, store };
  await expect(migrateLocalDocuments(input)).rejects.toThrow('database interrupted');
  await migrateLocalDocuments(input);
  const documents = join(dataRoot, 'knowledge', 'p', 'insights');
  const migrated = (await readdir(documents))[0]!;
  expect(await readFile(join(documents, migrated, 'Project', '.ignored'), 'utf8')).toBe(
    'untracked',
  );
  expect(await readFile(join(documents, migrated, 'Sessions', 'orphan', 'draft'), 'utf8')).toBe(
    'draft',
  );
  const manifest = JSON.parse(
    await readFile(join(dataRoot, 'document-migrations', 'p', 'manifest.json'), 'utf8'),
  ) as { stage: string; archive: string };
  expect(manifest.stage).toBe('complete');
  expect(await readFile(join(manifest.archive, '.git', 'history'), 'utf8')).toBe('history');
  await migrateLocalDocuments(input);
  expect(store.replaceLocalSessionWorkspace).toHaveBeenCalledTimes(2);
});

it('archives symlinks and generated trees without copying them into Documents', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'document-migration-'));
  roots.push(dataRoot);
  const workspace = join(dataRoot, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(workspace, 'web', 'node_modules', '.bin'), { recursive: true });
  await mkdir(join(workspace, 'web', 'node_modules', 'x'));
  await writeFile(join(workspace, 'web', 'node_modules', 'x', 'cli.js'), 'cli');
  await symlink('../x/cli.js', join(workspace, 'web', 'node_modules', '.bin', 'x'));
  await symlink('missing', join(workspace, 'dangling'));
  await symlink('web', join(workspace, 'linked-web'));
  execFileSync('mkfifo', [join(workspace, 'pipe')]);
  await mkdir(join(workspace, '.verity-sessions', 'orphan', 'node_modules'), { recursive: true });
  await symlink('missing', join(workspace, '.verity-sessions', 'orphan', 'dangling'));
  for (const name of ['dist', '.expo', '.cache', 'coverage']) {
    await mkdir(join(workspace, 'web', name));
    await writeFile(join(workspace, 'web', name, 'output'), 'generated');
  }
  // A regular file sharing an excluded directory name is still user content.
  await writeFile(join(workspace, 'dist'), 'draft');
  const store = {
    listSessions: vi.fn().mockResolvedValue([]),
    replaceLocalSessionWorkspace: vi.fn(),
  };
  await migrateLocalDocuments({ dataRoot, projectId: 'p', workspace, store });
  const manifest = JSON.parse(
    await readFile(join(dataRoot, 'document-migrations', 'p', 'manifest.json'), 'utf8'),
  ) as { archive: string; destination: string };
  const documents = join(dataRoot, 'knowledge', 'p', 'insights', manifest.destination);
  expect(await readdir(join(documents, 'Project', 'web'))).toEqual([]);
  expect(await readFile(join(documents, 'Project', 'dist'), 'utf8')).toBe('draft');
  for (const path of [
    'dangling',
    'linked-web',
    'web/node_modules/.bin/x',
    '.verity-sessions/orphan/dangling',
  ]) {
    expect((await lstat(join(manifest.archive, path))).isSymbolicLink()).toBe(true);
  }
  expect(await readlink(join(manifest.archive, 'dangling'))).toBe('missing');
  expect(await readlink(join(manifest.archive, 'web/node_modules/.bin/x'))).toBe('../x/cli.js');
  await expect(lstat(join(documents, 'Project', 'dangling'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(lstat(join(documents, 'Project', 'linked-web'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readdir(join(documents, 'Sessions', 'orphan'))).toEqual([]);
  expect((await lstat(join(manifest.archive, 'pipe'))).isFIFO()).toBe(true);
  await expect(lstat(join(documents, 'Project', 'pipe'))).rejects.toMatchObject({ code: 'ENOENT' });
  const note = await readFile(join(documents, 'migration.md'), 'utf8');
  expect(note).toContain('pipe');
  for (const path of [
    'web/node_modules',
    'dangling',
    'linked-web',
    'web/dist',
    'web/.expo',
    'web/.cache',
    'web/coverage',
    '.verity-sessions/orphan/node_modules',
    '.verity-sessions/orphan/dangling',
    manifest.archive,
  ]) {
    expect(note).toContain(path);
  }
});

it('keeps originals on copy conflicts and reports skipped paths after recovery', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'document-migration-'));
  roots.push(dataRoot);
  const workspace = join(dataRoot, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await writeFile(join(workspace, 'draft'), 'original');
  await symlink('missing', join(workspace, 'dangling'));
  const store = {
    listSessions: vi
      .fn()
      .mockResolvedValue([{ projectId: 'p', sessionId: 's', worktree: workspace }]),
    replaceLocalSessionWorkspace: vi
      .fn()
      .mockRejectedValueOnce(new Error('interrupted'))
      .mockResolvedValue(undefined),
  };
  const input = { dataRoot, projectId: 'p', workspace, store };
  // Create a resumable manifest without completing the first copy.
  const stateDir = join(dataRoot, 'document-migrations', 'p');
  await mkdir(stateDir, { recursive: true });
  const archive = join(dataRoot, 'document-archives', 'p', 'test');
  await writeFile(
    join(stateDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      archive,
      destination: 'Migrated test',
      stage: 'copying',
      sessions: [
        { id: 's', source: workspace, view: join(workspace, DOCUMENT_SESSION_DIRECTORY, 's') },
      ],
    }),
  );
  const destination = join(dataRoot, 'knowledge', 'p', 'insights', 'Migrated test');
  await mkdir(join(destination, 'Project'), { recursive: true });
  await writeFile(join(destination, 'Project', 'draft'), 'conflict');
  await expect(migrateLocalDocuments(input)).rejects.toThrow('conflicts');
  expect(await readFile(join(workspace, 'draft'), 'utf8')).toBe('original');
  expect(await readlink(join(workspace, 'dangling'))).toBe('missing');
  await expect(lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(destination, 'Project', 'draft'), 'utf8')).toBe('conflict');
  await rm(join(destination, 'Project', 'draft'));
  await expect(migrateLocalDocuments(input)).rejects.toThrow('interrupted');
  // Simulate a crash after rename but before the archived phase was persisted.
  const manifestPath = join(stateDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { stage: string };
  manifest.stage = 'copying';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(destination, 'migration.md'));
  await migrateLocalDocuments(input);
  expect(await readFile(join(destination, 'migration.md'), 'utf8')).toContain('dangling');
  expect(await readlink(join(archive, 'dangling'))).toBe('missing');
});

it('caps the skipped-path report and summarizes omitted entries', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'document-migration-'));
  roots.push(dataRoot);
  const workspace = join(dataRoot, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
  for (let index = 0; index < 205; index++) {
    await symlink('missing', join(workspace, `link-${index}`));
  }
  const store = {
    listSessions: vi.fn().mockResolvedValue([]),
    replaceLocalSessionWorkspace: vi.fn(),
  };
  await migrateLocalDocuments({ dataRoot, projectId: 'p', workspace, store });
  const manifest = JSON.parse(
    await readFile(join(dataRoot, 'document-migrations', 'p', 'manifest.json'), 'utf8'),
  ) as { destination: string; skipped: { count: number; paths: string[] } };
  expect(manifest.skipped.count).toBe(205);
  expect(manifest.skipped.paths).toHaveLength(200);
  const note = await readFile(
    join(dataRoot, 'knowledge', 'p', 'insights', manifest.destination, 'migration.md'),
    'utf8',
  );
  expect(note).toContain('5 additional entries omitted.');
});
