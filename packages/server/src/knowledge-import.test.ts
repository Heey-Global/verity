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

import { importProjectSource } from './knowledge-import.js';

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
