import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  symlink,
  readlink,
  chmod,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { captureMoveSnapshot, moveGit, transferMoveSnapshot } from './session-move-files.js';

const roots: string[] = [];
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'verity-move-'));
  roots.push(root);
  await moveGit(root, 'init', '-b', 'main');
  await moveGit(root, 'config', 'user.name', 'Move test');
  await moveGit(root, 'config', 'user.email', 'move@example.test');
  await moveGit(root, 'commit', '--allow-empty', '-m', 'initial');
  return root;
}
async function commit(root: string) {
  await moveGit(root, 'add', '.');
  await moveGit(root, 'commit', '-m', 'fixture');
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session worktree transfer', () => {
  it('keeps independent index and working bytes, untracked files, modes and ignored source assets', async () => {
    const source = await repo();
    const target = await repo();
    const name = 'a\tfile\n.txt';
    await writeFile(join(source, name), 'base');
    await commit(source);
    await writeFile(join(source, name), 'staged');
    await moveGit(source, 'add', '--', name);
    await writeFile(join(source, name), 'working');
    await chmod(join(source, name), 0o755);
    const binary = Buffer.from([0, 255, 1, 13]);
    await writeFile(join(source, 'new.bin'), binary);
    await writeFile(join(source, '.gitignore'), 'private\n');
    await writeFile(join(source, 'private'), 'retained');
    const snapshot = await captureMoveSnapshot(source);
    await transferMoveSnapshot(snapshot, target);
    expect(await moveGit(target, 'show', `:${name}`)).toEqual(Buffer.from('staged'));
    expect(await readFile(join(target, name), 'utf8')).toBe('working');
    expect((await lstat(join(target, name))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(target, 'new.bin'))).toEqual(binary);
    expect((await moveGit(target, 'ls-files', '--', 'new.bin')).length).toBe(0);
    expect(snapshot.skipped).toContain('private');
    expect(await readFile(join(source, 'private'), 'utf8')).toBe('retained');
    expect(await captureMoveSnapshot(source)).toEqual(snapshot);
  });

  it('copies staged symlink text without following the link', async () => {
    const source = await repo();
    const target = await repo();
    await symlink('../missing-outside', join(source, 'link'));
    await moveGit(source, 'add', 'link');
    await transferMoveSnapshot(await captureMoveSnapshot(source), target);
    expect(await readlink(join(target, 'link'))).toBe('../missing-outside');
    expect((await moveGit(target, 'show', ':link')).toString()).toBe('../missing-outside');
  });

  it('transfers staged renames and unstaged deletions without touching other target files', async () => {
    const source = await repo();
    const target = await repo();
    for (const root of [source, target]) {
      await writeFile(join(root, 'old'), 'rename');
      await writeFile(join(root, 'deleted'), 'delete');
      await commit(root);
    }
    await writeFile(join(target, 'unaffected'), 'target');
    await commit(target);
    await moveGit(source, 'mv', 'old', 'new');
    await rm(join(source, 'deleted'));
    await transferMoveSnapshot(await captureMoveSnapshot(source), target);
    expect(await readFile(join(target, 'new'), 'utf8')).toBe('rename');
    await expect(lstat(join(target, 'old'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(target, 'deleted'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await moveGit(target, 'show', ':deleted')).toString()).toBe('delete');
    expect(await readFile(join(target, 'unaffected'), 'utf8')).toBe('target');
  });

  it('rejects differing destination files before writing any changes', async () => {
    const source = await repo();
    const target = await repo();
    await writeFile(join(source, 'a'), 'new');
    await writeFile(join(source, 'z'), 'source');
    await writeFile(join(target, 'z'), 'target');
    await commit(target);
    await expect(
      transferMoveSnapshot(await captureMoveSnapshot(source), target),
    ).rejects.toMatchObject({ code: 'file_conflict' });
    await expect(lstat(join(target, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, 'z'), 'utf8')).toBe('target');
  });
});

it('does not untrack an identical target file when the source file is untracked', async () => {
  const source = await repo();
  const target = await repo();
  for (const root of [source, target]) await writeFile(join(root, 'same'), 'same');
  await commit(target);
  const result = await transferMoveSnapshot(await captureMoveSnapshot(source), target);
  expect(result.alreadyPresent).toContain('same');
  expect((await moveGit(target, 'status', '--porcelain')).length).toBe(0);
});
it('rejects intent-to-add without converting it into a staged empty file', async () => {
  const source = await repo();
  await writeFile(join(source, 'intent'), 'unstaged');
  await moveGit(source, 'add', '-N', 'intent');
  await expect(captureMoveSnapshot(source)).rejects.toMatchObject({ code: 'unsupported_index' });
});

it('preserves a staged deletion even when the original bytes remain in the worktree', async () => {
  const source = await repo();
  const target = await repo();
  for (const root of [source, target]) {
    await writeFile(join(root, 'kept'), 'original');
    await commit(root);
  }
  await moveGit(source, 'rm', '--cached', 'kept');
  await transferMoveSnapshot(await captureMoveSnapshot(source), target);
  expect((await moveGit(target, 'ls-files', '--', 'kept')).length).toBe(0);
  expect(await readFile(join(target, 'kept'), 'utf8')).toBe('original');
});

it('recognizes an unstaged change already committed in the target', async () => {
  const source = await repo();
  const target = await repo();
  await writeFile(join(source, 'changed'), 'before');
  await commit(source);
  await writeFile(join(source, 'changed'), 'after');
  await writeFile(join(target, 'changed'), 'after');
  await commit(target);
  const moved = await transferMoveSnapshot(await captureMoveSnapshot(source), target);
  expect(moved.alreadyPresent).toContain('changed');
  expect((await moveGit(target, 'status', '--porcelain')).length).toBe(0);
});

it('recognizes an unstaged deletion already absent in the target', async () => {
  const source = await repo();
  const target = await repo();
  await writeFile(join(source, 'deleted'), 'before');
  await commit(source);
  await rm(join(source, 'deleted'));
  const moved = await transferMoveSnapshot(await captureMoveSnapshot(source), target);
  expect(moved.alreadyPresent).toContain('deleted');
  expect((await moveGit(target, 'status', '--porcelain')).length).toBe(0);
});
