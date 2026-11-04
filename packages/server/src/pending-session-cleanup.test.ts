import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createSessionCleanupWorker,
  createSessionCleanupProcessor,
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

async function cleanupFixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-cleanup-progress-'));
  const record = {
    sessionId: 'deleted',
    sandboxCwd: '/work/deleted',
    runnerProjectIds: ['project'],
    bindings: [],
  };
  await queueSessionCleanup(root, record);
  let state: 'absent' | 'ready' | 'sleeping' | 'unavailable' = 'sleeping';
  let time = 0;
  const deleteHome = vi.fn(async () => {});
  const purgeArtifacts = vi.fn(async (): Promise<'clean' | 'retry' | 'unsafe'> => 'clean');
  const report = vi.fn();
  const options = {
    root,
    sessionExists: async () => false,
    runtimeState: async () => state,
    deleteHome,
    purgeArtifacts,
    report,
    now: () => time,
  };
  return {
    root,
    record,
    options,
    deleteHome,
    purgeArtifacts,
    report,
    state: (value: typeof state) => {
      state = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

it('parks sleeping cleanup without requests or file deletion and finishes on natural wake', async () => {
  const f = await cleanupFixture();
  try {
    const processor = createSessionCleanupProcessor(f.options);
    await processor.run();
    await processor.run();
    expect(f.purgeArtifacts).not.toHaveBeenCalled();
    expect(f.deleteHome).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
    expect(await pendingSessionCleanups(f.root)).toHaveLength(1);
    // Wake readiness arrives before the project row changes from waking to active.
    await processor.run('project');
    expect(f.deleteHome).toHaveBeenCalledOnce();
    expect(await pendingSessionCleanups(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('persists exponential retry deadlines and completed steps across server restarts', async () => {
  const f = await cleanupFixture();
  try {
    f.state('ready');
    f.purgeArtifacts.mockResolvedValue('retry');
    await createSessionCleanupProcessor(f.options).run();
    f.advance(29_999);
    await createSessionCleanupProcessor(f.options).run();
    expect(f.purgeArtifacts).toHaveBeenCalledOnce();
    f.advance(1);
    await createSessionCleanupProcessor(f.options).run();
    expect(f.purgeArtifacts).toHaveBeenCalledTimes(2);
    const saved = (await pendingSessionCleanups(f.root))[0]!;
    expect(saved.progress?.project).toMatchObject({
      failures: 2,
      retryAt: 90_000,
      homeDeleted: true,
    });
    expect(f.deleteHome).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledOnce();
    f.advance(60_000);
    f.purgeArtifacts.mockResolvedValue('clean');
    await createSessionCleanupProcessor(f.options).run();
    expect(await pendingSessionCleanups(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('retains unsafe artifact ownership without repeated warnings or blocking home deletion on wake', async () => {
  const f = await cleanupFixture();
  try {
    f.state('ready');
    f.purgeArtifacts.mockResolvedValue('unsafe');
    const processor = createSessionCleanupProcessor(f.options);
    await processor.run();
    await processor.run();
    await processor.run('project');
    expect(f.purgeArtifacts).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledOnce();
    expect(f.deleteHome).toHaveBeenCalledOnce();
    expect((await pendingSessionCleanups(f.root))[0]?.progress?.project).toMatchObject({
      parked: 'unsafe-artifact-path',
      homeDeleted: true,
    });
  } finally {
    await f.close();
  }
});

it('never treats an unavailable retained runtime as absent, but completes verified missing runtimes', async () => {
  const f = await cleanupFixture();
  try {
    f.state('unavailable');
    const processor = createSessionCleanupProcessor(f.options);
    await processor.run();
    expect(f.deleteHome).not.toHaveBeenCalled();
    expect(await pendingSessionCleanups(f.root)).toHaveLength(1);
    f.state('absent');
    await processor.run();
    expect(await pendingSessionCleanups(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('blocks admission on failed home cleanup and retries it immediately despite background backoff', async () => {
  const f = await cleanupFixture();
  try {
    f.state('ready');
    f.deleteHome.mockRejectedValue(new Error('supervisor unavailable'));
    const processor = createSessionCleanupProcessor(f.options);
    await processor.run();
    await expect(processor.run('project')).rejects.toThrow('supervisor unavailable');
    expect(f.deleteHome).toHaveBeenCalledTimes(2);
    f.deleteHome.mockRejectedValue(undefined);
    await expect(processor.run('project')).rejects.toThrow('Pending session home cleanup failed');
    f.deleteHome.mockResolvedValue(undefined);
    await processor.run('project');
    expect(await pendingSessionCleanups(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

it('does not purge a live session after a database deletion failed', async () => {
  const f = await cleanupFixture();
  try {
    await createSessionCleanupProcessor({ ...f.options, sessionExists: async () => true }).run(
      'project',
    );
    expect(f.purgeArtifacts).not.toHaveBeenCalled();
    expect(f.deleteHome).not.toHaveBeenCalled();
    expect(await pendingSessionCleanups(f.root)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('persists separate runtime progress so targeted wake cannot discard another runtime', async () => {
  const f = await cleanupFixture();
  try {
    await queueSessionCleanup(f.root, { ...f.record, runnerProjectIds: ['project', 'historical'] });
    const processor = createSessionCleanupProcessor(f.options);
    await processor.run('project');
    const saved = (await pendingSessionCleanups(f.root))[0]!;
    expect(saved.progress?.project).toMatchObject({ homeDeleted: true, artifactsDeleted: true });
    expect(saved.progress?.historical).toBeUndefined();
    await processor.run('historical');
    expect(await pendingSessionCleanups(f.root)).toEqual([]);
  } finally {
    await f.close();
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

it('lets another session finish while an artifact purge remains stalled', async () => {
  const f = await cleanupFixture();
  f.state('ready');
  await queueSessionCleanup(f.root, { ...f.record, sessionId: 'other' });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const processor = createSessionCleanupProcessor({
    ...f.options,
    purgeArtifacts: async (_projectId, record) => {
      if (record.sessionId === f.record.sessionId) {
        entered();
        await gate;
      }
      return 'clean';
    },
  });
  const blocked = processor.runSession(f.record.sessionId);
  try {
    await ready;
    const other = processor.runSession('other');
    await vi.waitFor(async () =>
      expect((await pendingSessionCleanups(f.root)).some((r) => r.sessionId === 'other')).toBe(
        false,
      ),
    );
    await other;
  } finally {
    release();
    await blocked;
    await f.close();
  }
});
