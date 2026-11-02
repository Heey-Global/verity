import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeDurable } from './repository.js';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.each(['writeFile', 'sync'] as const)(
  'removes unpublished files after %s fails',
  async (operation) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'backup-durable-'));
    const originalOpen = (
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ).open;
    const spy = vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await originalOpen(...args);
      vi.spyOn(file, operation).mockRejectedValueOnce(new Error('disk failure'));
      return file;
    });
    try {
      await expect(writeDurable(join(root, 'event'), Buffer.from('event'), true)).rejects.toThrow(
        'disk failure',
      );
      expect(await fs.readdir(root)).toEqual([]);
      spy.mockReset();
      spy.mockImplementation(originalOpen);
      await writeDurable(join(root, 'event'), Buffer.from('retry'), true);
      expect(await fs.readFile(join(root, 'event'), 'utf8')).toBe('retry');
    } finally {
      spy.mockReset();
      spy.mockImplementation(originalOpen);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['self', String(process.pid)])(
  'syncs a pinned %s directory capability without following ordinary final symlinks',
  async (owner) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'backup-pinned-durable-'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const directory = await actual.open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    const spy = vi.mocked(fs.open).mockImplementation(async (...args) => {
      // Model Linux O_NOFOLLOW on runtimes whose filesystem emulation permits symlinks.
      if (
        typeof args[0] === 'string' &&
        typeof args[1] === 'number' &&
        args[1] & constants.O_NOFOLLOW &&
        (await actual.lstat(args[0])).isSymbolicLink()
      )
        throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return actual.open(...args);
    });
    try {
      await writeDurable(
        join(`/proc/${owner}/fd/${directory.fd}`, 'receipt'),
        Buffer.from('durable'),
        true,
      );
      expect(await fs.readFile(join(root, 'receipt'), 'utf8')).toBe('durable');
      await fs.symlink(root, join(root, 'alias'));
      await expect(
        writeDurable(join(root, 'alias', 'refused'), Buffer.from('bytes'), true),
      ).rejects.toThrow();
    } finally {
      spy.mockReset().mockImplementation(actual.open);
      await directory.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
