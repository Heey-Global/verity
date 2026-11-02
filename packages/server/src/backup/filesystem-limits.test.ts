import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({
  abort: undefined as AbortController | undefined,
  visited: 0,
  synthetic: false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    opendir: async (...args: Parameters<typeof original.opendir>) => {
      if (control.synthetic && (await original.realpath(String(args[0]))).endsWith('/node_modules'))
        return {
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < 1000001; i++) yield { name: `synthetic-${i}` };
          },
        };
      return original.opendir(...args);
    },
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      if (control.synthetic && /\/synthetic-[0-9]+$/.test(String(args[0]))) {
        control.visited++;
        return { isDirectory: () => false, isFile: () => true, size: 1n };
      }
      const result = await original.lstat(...args);
      if (String(args[0]).endsWith('/generated')) {
        control.visited++;
        control.abort?.abort(new Error('stop excluded scan'));
      }
      return result;
    },
  };
});
import { captureTree } from './filesystem.js';
let root: string | undefined;
afterEach(async () => {
  control.abort = undefined;
  control.visited = 0;
  control.synthetic = false;
  if (root) await rm(root, { recursive: true, force: true });
});
it('cancels during excluded subtree sizing before scanning all dependency files', async () => {
  root = await mkdtemp(join(tmpdir(), 'excluded-abort-'));
  await mkdir(join(root, 'node_modules', 'nested'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'generated'), '123');
  await writeFile(join(root, 'node_modules', 'nested', 'generated'), '456');
  const controller = new AbortController();
  control.abort = controller;
  const onExcluded = vi.fn();
  const collect = async () => {
    for await (const _entry of captureTree(root!, {
      prefix: 'workspaces/project',
      excludeRegenerable: true,
      signal: controller.signal,
      onExcluded,
    })) {
      void _entry;
    }
  };
  await expect(collect()).rejects.toThrow('stop excluded scan');
  expect(control.visited).toBe(1);
  expect(onExcluded).not.toHaveBeenCalled();
});

it('bounds excluded dependency enumeration across the full capture', async () => {
  root = await mkdtemp(join(tmpdir(), 'excluded-limit-'));
  await mkdir(join(root, 'node_modules'));
  control.synthetic = true;
  const onExcluded = vi.fn();
  const collect = async () => {
    for await (const _entry of captureTree(root!, {
      prefix: 'workspaces/project',
      excludeRegenerable: true,
      onExcluded,
    })) {
      void _entry;
    }
  };
  await expect(collect()).rejects.toThrow('Excluded backup path count exceeds limit');
  expect(control.visited).toBeLessThan(1000001);
  expect(onExcluded).not.toHaveBeenCalled();
});
