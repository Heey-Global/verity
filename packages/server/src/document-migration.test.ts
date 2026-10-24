import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
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
