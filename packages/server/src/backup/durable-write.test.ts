import * as fs from 'node:fs/promises';
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
