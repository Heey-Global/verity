import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { runBackupGit } from './git.js';
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
it('kills an active Git verification on cancellation before releasing the caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'probe-git-abort-'));
  try {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn<(signal: string) => boolean>(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      }),
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    fake.spawn.mockImplementationOnce(() => {
      started();
      return child;
    });
    const controller = new AbortController();
    const result = runBackupGit(root, root, 'fsck', undefined, [], controller.signal);
    await ready;
    controller.abort();
    expect(await result).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
