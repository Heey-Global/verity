import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ save: false, directory: false, staging: false, outside: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      if (race.directory && !source.endsWith('/file')) {
        await actual.rm(source);
        await actual.mkdir(source);
        await actual.writeFile(join(source, 'child.txt'), 'directory contents');
      }
      if (race.staging) {
        race.staging = false;
        const staging = await actual.realpath(destination.slice(0, destination.lastIndexOf('/')));
        await actual.rename(staging, `${staging}-moved`);
        await actual.symlink(race.outside, staging);
      }
      await actual.rename(source, destination);
      if (race.save) await actual.writeFile(source, 'new save');
    },
  };
});
import { renameWorktreeFile } from './rename-worktree-file.js';

let directory: string;
afterEach(async () => {
  race.save = false;
  race.directory = false;
  race.staging = false;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  directory = await mkdtemp(join(tmpdir(), 'verity-rename-race-'));
  const source = join(directory, 'old.txt');
  const destination = join(directory, 'new.txt');
  await writeFile(source, 'original');
  return { source, destination };
}

it('preserves an atomic save arriving during a rename', async () => {
  const { source, destination } = await setup();
  // The path can hold a different inode after capture; unlinking it loses that save.
  race.save = true;
  await renameWorktreeFile(source, destination);
  expect(await readFile(source, 'utf8')).toBe('new save');
  expect(await readFile(destination, 'utf8')).toBe('original');
  expect(await readdir(directory)).toEqual(['new.txt', 'old.txt']);
});

it('restores the original when the destination already exists', async () => {
  const { source, destination } = await setup();
  await writeFile(destination, 'occupied');
  await expect(renameWorktreeFile(source, destination)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(source, 'utf8')).toBe('original');
  expect(await readFile(destination, 'utf8')).toBe('occupied');
});

it('keeps a recovery file if a concurrent save prevents rollback', async () => {
  const { source, destination } = await setup();
  await writeFile(destination, 'occupied');
  race.save = true;
  await expect(renameWorktreeFile(source, destination)).rejects.toThrow('preserved at');
  expect(await readFile(source, 'utf8')).toBe('new save');
  expect(await readFile(destination, 'utf8')).toBe('occupied');
  const staging = (await readdir(directory)).find((name) => name.startsWith('.verity-rename-'))!;
  expect(await readFile(join(directory, staging, 'file'), 'utf8')).toBe('original');
});

it('restores a directory substituted just before capture', async () => {
  const { source, destination } = await setup();
  race.directory = true;
  await expect(renameWorktreeFile(source, destination)).rejects.toThrow('Only files');
  expect(await readFile(join(source, 'child.txt'), 'utf8')).toBe('directory contents');
  expect(await readdir(directory)).toEqual(['old.txt']);
});

it('does not follow a substituted staging symlink', async () => {
  const { source, destination } = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'verity-rename-outside-'));
  try {
    await writeFile(join(outside, 'file'), 'external');
    race.staging = true;
    race.outside = outside;
    await renameWorktreeFile(source, destination);
    expect(await readFile(join(outside, 'file'), 'utf8')).toBe('external');
    expect(await readFile(destination, 'utf8')).toBe('original');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
