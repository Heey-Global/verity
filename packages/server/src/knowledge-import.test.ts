import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  createProjectSourceFolder,
  importProjectSource,
  moveProjectSource,
} from './knowledge-import.js';

let dataRoot: string;
let worktree: string;
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'verity-source-data-'));
  worktree = mkdtempSync(join(tmpdir(), 'verity-source-worktree-'));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

it('copies only a regular file inside the session worktree into its project', async () => {
  mkdirSync(join(worktree, 'docs/meetings'), { recursive: true });
  writeFileSync(join(worktree, 'docs/meetings/planning.md'), '# Planning\n');
  const imported = await importProjectSource(dataRoot, 'project-a', worktree, {
    sourcePath: 'docs/meetings/planning.md',
    destination: 'meetings',
    path: 'planning.md',
  });
  expect(imported).toEqual({ path: 'sources/meetings/planning.md', size: 11 });
  expect(readFileSync(join(dataRoot, 'knowledge/project-a', imported.path), 'utf8')).toBe(
    '# Planning\n',
  );
  expect(existsSync(join(dataRoot, 'knowledge/project-b', imported.path))).toBe(false);
});

it('refuses worktree traversal and symlinked source files', async () => {
  writeFileSync(join(dataRoot, 'outside.md'), 'private');
  symlinkSync(join(dataRoot, 'outside.md'), join(worktree, 'linked.md'));
  for (const sourcePath of ['../outside.md', 'linked.md']) {
    await expect(
      importProjectSource(dataRoot, 'project-a', worktree, {
        sourcePath,
        destination: 'documents',
        path: 'outside.md',
      }),
    ).rejects.toThrow();
  }
  expect(existsSync(join(dataRoot, 'knowledge/project-a/sources/documents/outside.md'))).toBe(
    false,
  );
});

it('creates nested folders and moves a project source into one without overwriting', async () => {
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(join(worktree, 'docs/planning.md'), '# Planning\n');
  await importProjectSource(dataRoot, 'project-a', worktree, {
    sourcePath: 'docs/planning.md',
    destination: 'meetings',
    path: 'planning.md',
  });
  const folder = await createProjectSourceFolder(dataRoot, 'project-a', {
    destination: 'meetings',
    path: '2026/team',
  });
  expect(folder.path).toBe('sources/meetings/2026/team');
  const moved = await moveProjectSource(dataRoot, 'project-a', {
    sourcePath: 'meetings/planning.md',
    destination: 'meetings',
    path: '2026/team/planning.md',
  });
  expect(moved.path).toBe('sources/meetings/2026/team/planning.md');
  expect(existsSync(join(dataRoot, 'knowledge/project-a/sources/meetings/planning.md'))).toBe(
    false,
  );
  expect(readFileSync(join(dataRoot, 'knowledge/project-a', moved.path), 'utf8')).toBe(
    '# Planning\n',
  );
  expect(
    existsSync(join(dataRoot, 'knowledge/project-a/.text/sources/meetings/planning.md.md')),
  ).toBe(false);
  expect(
    existsSync(
      join(dataRoot, 'knowledge/project-a/.text/sources/meetings/2026/team/planning.md.md'),
    ),
  ).toBe(true);
  writeFileSync(join(dataRoot, 'knowledge/project-a/sources/meetings/other.md'), 'other');
  await expect(
    moveProjectSource(dataRoot, 'project-a', {
      sourcePath: 'meetings/other.md',
      destination: 'meetings',
      path: '2026/team/planning.md',
    }),
  ).rejects.toThrow();
  expect(existsSync(join(dataRoot, 'knowledge/project-a/sources/meetings/other.md'))).toBe(true);
});

it('imports into a nested path and rejects symlinked destination directories', async () => {
  writeFileSync(join(worktree, 'note.md'), 'note');
  const imported = await importProjectSource(dataRoot, 'project-a', worktree, {
    sourcePath: 'note.md',
    destination: 'documents',
    path: 'team/notes/note.md',
  });
  expect(imported.path).toBe('sources/documents/team/notes/note.md');
  symlinkSync(worktree, join(dataRoot, 'knowledge/project-a/sources/documents/linked'));
  await expect(
    importProjectSource(dataRoot, 'project-a', worktree, {
      sourcePath: 'note.md',
      destination: 'documents',
      path: 'linked/note.md',
    }),
  ).rejects.toThrow();
  expect(existsSync(join(worktree, 'note.md'))).toBe(true);
});

it('refuses invalid move paths and symlinked destination folders', async () => {
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(join(worktree, 'docs/note.md'), 'note');
  await importProjectSource(dataRoot, 'project-a', worktree, {
    sourcePath: 'docs/note.md',
    destination: 'documents',
    path: 'note.md',
  });
  const input = { sourcePath: 'documents/note.md', destination: 'documents' as const };
  for (const path of ['../escape.md', 'team/../escape.md', '.hidden/note.md']) {
    await expect(moveProjectSource(dataRoot, 'project-a', { ...input, path })).rejects.toThrow();
  }
  await expect(
    moveProjectSource(dataRoot, 'project-a', {
      ...input,
      sourcePath: 'insights/note.md',
      path: 'note.md',
    }),
  ).rejects.toThrow();
  symlinkSync(worktree, join(dataRoot, 'knowledge/project-a/sources/documents/linked'));
  await expect(
    moveProjectSource(dataRoot, 'project-a', { ...input, path: 'linked/note.md' }),
  ).rejects.toThrow();
  mkdirSync(join(dataRoot, 'knowledge/project-a/insights'), { recursive: true });
  writeFileSync(join(dataRoot, 'knowledge/project-a/insights/private.md'), 'private');
  symlinkSync(
    join(dataRoot, 'knowledge/project-a/insights'),
    join(dataRoot, 'knowledge/project-a/sources/documents/alias'),
  );
  await expect(
    moveProjectSource(dataRoot, 'project-a', {
      sourcePath: 'documents/alias/private.md',
      destination: 'documents',
      path: 'private.md',
    }),
  ).rejects.toThrow();
  expect(existsSync(join(dataRoot, 'knowledge/project-a/insights/private.md'))).toBe(true);
  expect(
    readFileSync(join(dataRoot, 'knowledge/project-a/sources/documents/note.md'), 'utf8'),
  ).toBe('note');
});
