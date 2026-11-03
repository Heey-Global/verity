import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createSessionCleanupWorker,
  finishSessionCleanup,
  pendingSessionCleanups,
  queueSessionCleanup,
} from './pending-session-cleanup.js';

it('retains ownership after the session row is gone and removes only a completed cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-pending-cleanup-'));
  try {
    const first = {
      sessionId: 'first',
      sandboxCwd: '/work/first',
      runnerProjectIds: ['project'],
      bindings: [{ backend: 'codex', backendSessionId: 'thread' }],
    };
    const second = { ...first, sessionId: 'second' };
    await queueSessionCleanup(root, first);
    await queueSessionCleanup(root, second);
    await queueSessionCleanup(root, first);
    expect(await pendingSessionCleanups(root)).toEqual(expect.arrayContaining([first, second]));
    await finishSessionCleanup(root, first.sessionId);
    expect(await pendingSessionCleanups(root)).toEqual([second]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retries retained cleanup after a timeout without overlapping scans, and stops on shutdown', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const timeout = new Promise<void>((_, reject) => {
    release = () => reject(new Error('supervisor request timed out'));
  });
  const scan = vi
    .fn()
    .mockImplementationOnce(() => timeout)
    .mockResolvedValue(undefined);
  const onError = vi.fn();
  const worker = createSessionCleanupWorker(scan, onError);
  try {
    worker.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(1);
    release();
    await worker.settled();
    expect(onError).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await worker.settled();
    expect(scan).toHaveBeenCalledTimes(3);
    worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(3);
  } finally {
    worker.stop();
    vi.useRealTimers();
  }
});
