import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ save: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      await actual.rename(source, destination);
      if (race.save) {
        race.save = false;
        await actual.writeFile(source, 'agent save');
      }
    },
  };
});
import { openKnowledgeFileSlot } from './session-files.js';
import { fileVersion, writeSessionText } from './session-file-write.js';
let dir: string;
afterEach(async () => {
  race.save = false;
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'verity-edit-test-'));
  await writeFile(join(dir, 'a.txt'), 'original');
  return openKnowledgeFileSlot({ root: 'worktree', dir }, 'a.txt');
}

it('preserves mode and removes staging files after saving', async () => {
  const slot = await setup();
  try {
    await chmod(join(dir, 'a.txt'), 0o600);
    await writeSessionText(slot, 'new text', fileVersion(Buffer.from('original')));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new text');
    expect((await stat(join(dir, 'a.txt'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['a.txt']);
  } finally {
    await slot.close();
  }
});

it('does not replace an agent save arriving after source capture', async () => {
  const slot = await setup();
  try {
    race.save = true;
    await expect(
      writeSessionText(slot, 'my edits', fileVersion(Buffer.from('original'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('agent save');
    const staging = (await readdir(dir)).find((name) => name.startsWith('.verity-edit-'))!;
    expect(await readFile(join(dir, staging, 'original'), 'utf8')).toBe('original');
  } finally {
    await slot.close();
  }
});

it('rejects leaf symlinks without changing their target', async () => {
  const slot = await setup();
  try {
    await writeFile(join(dir, 'outside.txt'), 'untouched');
    await rm(join(dir, 'a.txt'));
    await symlink(join(dir, 'outside.txt'), join(dir, 'a.txt'));
    await expect(
      writeSessionText(slot, 'my edits', fileVersion(Buffer.from('untouched'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'outside.txt'), 'utf8')).toBe('untouched');
  } finally {
    await slot.close();
  }
});

it('refuses a stale version and restores the source without temporary leftovers', async () => {
  const slot = await setup();
  try {
    await expect(
      writeSessionText(slot, 'my edits', fileVersion(Buffer.from('stale'))),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['a.txt']);
  } finally {
    await slot.close();
  }
});

it('does not overwrite an existing file when creating', async () => {
  const slot = await setup();
  try {
    await expect(writeSessionText(slot, 'new file', null)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
  } finally {
    await slot.close();
  }
});
