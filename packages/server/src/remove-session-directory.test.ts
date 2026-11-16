import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { removeSessionDirectory } from './remove-session-directory.js';

it('removes nested contents without following links outside the selected folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-remove-folder-'));
  try {
    await mkdir(join(root, 'selected/nested'), { recursive: true });
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'selected/nested/note.md'), 'remove');
    await writeFile(join(root, 'outside/keep.md'), 'keep');
    await symlink(join(root, 'outside'), join(root, 'selected/link'));
    await removeSessionDirectory(root, 'selected');
    await expect(readFile(join(root, 'selected/nested/note.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(root, 'outside/keep.md'), 'utf8')).toBe('keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a nested repository before deleting sibling files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-remove-folder-'));
  try {
    await mkdir(join(root, 'selected/repo/.git'), { recursive: true });
    await writeFile(join(root, 'selected/a.txt'), 'keep');
    await expect(removeSessionDirectory(root, 'selected')).rejects.toThrow('Git metadata');
    expect(await readFile(join(root, 'selected/a.txt'), 'utf8')).toBe('keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
