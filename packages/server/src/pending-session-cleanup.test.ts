import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createSessionCleanupWorker,
  createSessionCleanupProcessor,
  deleteRunnerSessionHome,
  finishSessionCleanup,
  pendingSessionCleanups,
  queueSessionCleanup,
  SESSION_HOME_DELETE_TIMEOUT_MS,
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

it.each([false, true])(
  'merges final bindings even after an earlier cleanup completed (%s)',
  async (completed) => {
    const f = await cleanupFixture();
    try {
      f.state('ready');
      const processor = createSessionCleanupProcessor(f.options);
      if (completed) await processor.runSession(f.record.sessionId);
      else
        await queueSessionCleanup(f.root, {
          ...f.record,
          progress: { project: { homeDeleted: true, artifactsDeleted: true } },
        });
      const late = { backend: 'codex', backendSessionId: 'late-thread' };
      await processor.runSession(f.record.sessionId, { ...f.record, bindings: [late] });
      expect(f.purgeArtifacts).toHaveBeenLastCalledWith(
        'project',
        expect.objectContaining({ bindings: [late] }),
      );
      expect(await pendingSessionCleanups(f.root)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

// Repair of a project without a Sandbox container recreates it, starts the
// Runner and only then admits work once pending session homes are deleted.
// These cases pin that sequence and the deadline the deletion relies on.
it('keeps Repair admission blocked and truthful while an absent runner is restarted and its deletion times out', async () => {
  const f = await cleanupFixture();
  try {
    const processor = createSessionCleanupProcessor(f.options);
    // No Sandbox container: the runtime directory survives, so the runtime is
    // unavailable rather than absent. Nothing may be sent to its stale socket.
    f.state('unavailable');
    await processor.run();
    expect(f.deleteHome).not.toHaveBeenCalled();
    // Repair started the runner; the supervisor did not answer in time.
    const timeout = Object.assign(
      new Error('runner supervisor request timed out: delete-session-home'),
      { code: 'ETIMEDOUT' },
    );
    f.deleteHome.mockRejectedValueOnce(timeout);
    await expect(processor.run('project')).rejects.toBe(timeout);
    const [retained] = await pendingSessionCleanups(f.root);
    expect(retained?.progress?.project?.homeDeleted).not.toBe(true);
    // Artifacts are purged only after the broker fenced the home.
    expect(f.purgeArtifacts).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledExactlyOnceWith(
      'project',
      expect.anything(),
      'retry',
      timeout,
    );
    // The background scan honours backoff; the next Repair retries at once.
    f.state('ready');
    await processor.run();
    expect(f.deleteHome).toHaveBeenCalledTimes(1);
    await processor.run('project');
    expect(f.deleteHome).toHaveBeenCalledTimes(2);
    expect(await pendingSessionCleanups(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

/** A Runner supervisor on a real Unix socket that answers only when told to. */
async function heldSupervisor() {
  const directory = await mkdtemp(join(tmpdir(), 'vsc-'));
  const socketPath = join(directory, 'supervisor.sock');
  const requests: unknown[] = [];
  let peer: Socket | undefined;
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer((socket) => {
    peer = socket;
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      if (!buffered.includes('\n')) return;
      requests.push(JSON.parse(buffered.split('\n')[0]!));
      received();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    arrived,
    answer: (response: unknown) => peer!.end(`${JSON.stringify(response)}\n`),
    close: async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The supervisor's own budget for the broker deletion, read from its source. */
async function supervisorBrokerBudgetMs(): Promise<number> {
  const source = await readFile(
    new URL(
      '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const start = source.indexOf('async function brokerStorageRequest(');
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  // Numeric separators are allowed, so `30_000` must not read as `30`.
  const budgets = [...body.matchAll(/socket\.setTimeout\(\s*(\d[\d_]*)\s*,/gu)].map((match) =>
    Number(match[1]!.replaceAll('_', '')),
  );
  expect(budgets).toHaveLength(1);
  return budgets[0]!;
}

it('waits for a supervisor that is still deleting for its whole broker budget', async () => {
  const budget = await supervisorBrokerBudgetMs();
  const supervisor = await heldSupervisor();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const deletion = deleteRunnerSessionHome(supervisor.socketPath, 'session-a');
    const settled = vi.fn();
    deletion.then(settled, settled);
    await supervisor.arrived;
    expect(supervisor.requests).toEqual([
      expect.objectContaining({ kind: 'delete-session-home', sessionId: 'session-a' }),
    ]);
    await vi.advanceTimersByTimeAsync(budget + 1_000);
    expect(settled).not.toHaveBeenCalled();
    supervisor.answer({ ok: true });
    await expect(deletion).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
    await supervisor.close();
  }
});

it('still fails, without claiming deletion, when the supervisor refuses or never answers', async () => {
  const refusing = await heldSupervisor();
  try {
    const refused = deleteRunnerSessionHome(refusing.socketPath, 'session-b');
    await refusing.arrived;
    refusing.answer({ ok: false, error: 'session storage is still in use' });
    await expect(refused).rejects.toThrow('session storage is still in use');
  } finally {
    await refusing.close();
  }
  const silent = await heldSupervisor();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const stalled = deleteRunnerSessionHome(silent.socketPath, 'session-c');
    const outcome = stalled.catch((error: unknown) => error);
    await silent.arrived;
    await vi.advanceTimersByTimeAsync(SESSION_HOME_DELETE_TIMEOUT_MS);
    expect(await outcome).toMatchObject({
      code: 'ETIMEDOUT',
      message: 'runner supervisor request timed out: delete-session-home',
    });
  } finally {
    vi.useRealTimers();
    await silent.close();
  }
});

// The Server's deadline is only meaningful above the supervisor's own budget
// for the broker deletion; below it, a deletion the supervisor would complete
// is reported as a timeout and the failed Repair stops the container mid-way.
it('gives the supervisor more time than its own broker storage budget', async () => {
  // Turn cancellation precedes the broker step inside the same request. The
  // supervisor publishes no bound for it; 10 s is this guard's assumption.
  expect(SESSION_HOME_DELETE_TIMEOUT_MS).toBeGreaterThanOrEqual(
    (await supervisorBrokerBudgetMs()) + 10_000,
  );
});
