import { describe, expect, it, vi } from 'vitest';
import { RunnerCacheStorage, runnerCacheTargetFromEnv } from './runner-cache-storage.js';

function response(overrides = {}) {
  return {
    ok: true,
    report: {
      observedAt: new Date().toISOString(),
      sharedBytes: 30,
      legacyBytes: 10,
      removedBytes: 20,
      legacyCachesRemoved: 1,
      sharedCachePruned: false,
      usageComplete: true,
      blockers: [],
      ...overrides,
    },
  };
}

describe('runner cache storage', () => {
  it('collects sequentially with a shared default target and aggregates retained usage separately from removals', async () => {
    let active = 0;
    const request = vi.fn(async (id: string) => {
      active += 1;
      expect(active).toBe(1);
      await Promise.resolve();
      active -= 1;
      return response({ sharedCachePruned: id === 'two' });
    });
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [
        { projectId: 'one', sessionIds: ['idle', 'idle'] },
        { projectId: 'two', sessionIds: [] },
      ],
      request,
    });
    await storage.runOnce();
    expect(request.mock.calls).toEqual([
      ['one', ['idle'], 4 * 1024 ** 3],
      ['two', [], 4 * 1024 ** 3],
    ]);
    expect(storage.lastReport).toMatchObject({
      sharedBytes: 60,
      legacyBytes: 20,
      removedBytes: 40,
      legacyCachesRemoved: 2,
      sharedCachesPruned: 1,
      usageComplete: true,
    });
  });

  it('coalesces concurrent passes and allows a later pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async () => {
      await gate;
      return response();
    });
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request,
    });
    const first = storage.runOnce();
    expect(storage.runOnce()).toBe(first);
    release();
    await first;
    await storage.runOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses a configured target and retains unknown measurements without discarding independent removals', async () => {
    const request = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('private transport detail');
      return response({
        sharedBytes: null,
        usageComplete: false,
        blockers: ['Shared cache is busy'],
      });
    });
    const storage = new RunnerCacheStorage({
      maxBytes: 128,
      listRuntimes: async () => [
        { projectId: 'bad', sessionIds: [] },
        { projectId: 'good', sessionIds: ['idle'] },
      ],
      request,
    });
    await storage.runOnce();
    expect(request).toHaveBeenCalledWith('good', ['idle'], 128);
    expect(storage.lastReport).toMatchObject({
      sharedBytes: null,
      legacyBytes: null,
      removedBytes: 20,
      usageComplete: false,
    });
    expect(storage.lastReport?.blockers.join(' ')).toContain('Shared cache is busy');
    expect(storage.lastReport?.blockers.join(' ')).not.toContain('private transport detail');
  });

  it.each([
    { ok: false, error: 'unsupported request' },
    response({ removedBytes: -1 }),
    response({ sharedBytes: Infinity }),
  ])('rejects an unsupported or invalid broker response', async (result) => {
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request: async () => result,
    });
    await storage.runOnce();
    expect(storage.lastReport).toMatchObject({
      sharedBytes: null,
      legacyBytes: null,
      removedBytes: 0,
      usageComplete: false,
    });
  });

  it('bounds unknown inventories and does not send oversized requests', async () => {
    const request = vi.fn();
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [
        { projectId: 'one', sessionIds: Array.from({ length: 513 }, (_, index) => String(index)) },
      ],
      request,
    });
    await storage.runOnce();
    expect(request).not.toHaveBeenCalled();
    expect(storage.lastReport?.usageComplete).toBe(false);
    expect(storage.lastReport?.sharedBytes).toBeNull();
  });

  it('stops starting projects at the pass deadline while preserving measured removals', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(60_000);
    try {
      const request = vi.fn(async () => response());
      const storage = new RunnerCacheStorage({
        listRuntimes: async () => [
          { projectId: 'one', sessionIds: [] },
          { projectId: 'two', sessionIds: [] },
        ],
        request,
      });
      await storage.runOnce();
      expect(request).toHaveBeenCalledTimes(1);
      expect(storage.lastReport).toMatchObject({
        sharedBytes: null,
        legacyBytes: null,
        removedBytes: 20,
        usageComplete: false,
      });
      expect(storage.lastReport?.blockers.join(' ')).toContain('deadline');
    } finally {
      now.mockRestore();
    }
  });

  it('resumes with the next project after a deadline instead of starving it', async () => {
    let time = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    try {
      const request = vi.fn(async () => {
        time += 60_000;
        return response();
      });
      const storage = new RunnerCacheStorage({
        listRuntimes: async () => [
          { projectId: 'one', sessionIds: [] },
          { projectId: 'two', sessionIds: [] },
        ],
        request,
      });
      await storage.runOnce();
      await storage.runOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, 'one', [], 4 * 1024 ** 3);
      expect(request).toHaveBeenNthCalledWith(2, 'two', [], 4 * 1024 ** 3);
    } finally {
      clock.mockRestore();
    }
  });

  it('rotates a runtime inventory larger than the per-pass limit', async () => {
    const request = vi.fn(async () => response());
    const storage = new RunnerCacheStorage({
      listRuntimes: async () =>
        Array.from({ length: 1001 }, (_, index) => ({
          projectId: `p${String(index).padStart(4, '0')}`,
          sessionIds: [],
        })),
      request,
    });
    await storage.runOnce();
    expect(request).toHaveBeenCalledTimes(1000);
    expect(storage.lastReport?.usageComplete).toBe(false);
    await storage.runOnce();
    expect(request).toHaveBeenNthCalledWith(1001, 'p1000', [], 4 * 1024 ** 3);
  });

  it('resumes incomplete scans promptly without waiting for the daily scheduler', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...response({ usageComplete: false, legacyBytes: null }),
        maintenancePending: true,
      })
      .mockResolvedValue(response());
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request,
    });
    try {
      await storage.runOnce();
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(storage.lastReport?.usageComplete).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await storage.stop();
      vi.useRealTimers();
    }
  });

  it('drains an active continuation before shutdown and admits no further projects', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...response(), maintenancePending: true })
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(async () => {
        await active;
        return response();
      });
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [
        { projectId: 'one', sessionIds: [] },
        { projectId: 'two', sessionIds: [] },
      ],
      request,
    });
    try {
      await storage.runOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(request).toHaveBeenCalledTimes(3);
      let closed = false;
      const closing = storage.stop().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
      await storage.runOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      release();
      await storage.stop();
      vi.useRealTimers();
    }
  });

  it('cancels continuation scheduling when the Server closes', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({
      ...response({ usageComplete: false }),
      maintenancePending: true,
    }));
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request,
    });
    try {
      await storage.runOnce();
      await storage.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await storage.stop();
      vi.useRealTimers();
    }
  });

  it('reports failed enumeration as unknown rather than zero', async () => {
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => {
        throw new Error('unavailable');
      },
      request: vi.fn(),
    });
    await storage.runOnce();
    expect(storage.lastReport).toMatchObject({
      sharedBytes: null,
      legacyBytes: null,
      usageComplete: false,
    });
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid target %s', (maxBytes) => {
    expect(
      () => new RunnerCacheStorage({ maxBytes, listRuntimes: async () => [], request: vi.fn() }),
    ).toThrow('positive safe integer');
  });
});

describe('runner cache environment target', () => {
  it.each([undefined, '', '   '])('leaves the default target for %s', (value) => {
    expect(runnerCacheTargetFromEnv(value)).toBeUndefined();
  });
  it('accepts a positive integer byte target with surrounding whitespace', () => {
    expect(runnerCacheTargetFromEnv(' 4294967296 ')).toBe(4 * 1024 ** 3);
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '1.5', '1e3', '9007199254740992'])(
    'rejects invalid target %s',
    (value) => {
      expect(() => runnerCacheTargetFromEnv(value)).toThrow('positive safe integer');
    },
  );
});

describe('bounded runner cache failure diagnostics', () => {
  it.each([
    ['EACCES', 'supervisor-access-denied'],
    ['EPERM', 'supervisor-access-denied'],
    ['ENOENT', 'supervisor-unavailable'],
    ['ECONNREFUSED', 'supervisor-unavailable'],
    ['ETIMEDOUT', 'supervisor-timeout'],
    ['UNKNOWN', 'unclassified-failure'],
  ])('classifies transport %s without leaking its message', async (code, expected) => {
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request: async () => {
        throw Object.assign(new Error('/private/token'), { code });
      },
    });
    await storage.runOnce();
    expect(storage.lastReport?.blockers.join(' ')).toContain(`[${expected}]`);
    expect(JSON.stringify(storage.lastReport)).not.toContain('/private/token');
    expect(storage.lastReport).toMatchObject({
      usageComplete: false,
      removedBytes: 0,
      sharedBytes: null,
    });
  });
  it.each([
    {
      code: 'turn-ownership-unknown',
      counts: { missingState: 1, invalidState: 2, unsettledWithoutSession: 3 },
    },
    { code: 'unsupported' },
    { code: 'broker-unavailable' },
  ])('preserves allowlisted structured diagnostics %j across mixed projects', async (failure) => {
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [
        { projectId: 'one', sessionIds: [] },
        { projectId: 'two', sessionIds: [] },
      ],
      request: async (id) => {
        if (id === 'one')
          throw Object.assign(new Error('secret'), {
            runnerCacheFailure: { ...failure, private: 'secret' },
          });
        return response();
      },
    });
    await storage.runOnce();
    expect(storage.lastReport?.blockers.join(' ')).toContain(`[${failure.code}]`);
    if (failure.counts)
      expect(storage.lastReport?.blockers.join(' ')).toContain(
        'missingState=1, invalidState=2, unsettledWithoutSession=3',
      );
    expect(JSON.stringify(storage.lastReport)).not.toContain('secret');
    expect(storage.lastReport).toMatchObject({ removedBytes: 20, usageComplete: false });
  });
  it.each([
    { code: 'private secret' },
    {
      code: 'turn-ownership-unknown',
      counts: { missingState: 1e9, invalidState: 0, unsettledWithoutSession: 0 },
    },
    {
      code: 'turn-ownership-unknown',
      counts: { missingState: -1, invalidState: 0, unsettledWithoutSession: 0 },
    },
  ])('rejects unsafe diagnostic metadata %j', async (failure) => {
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request: async () => {
        throw Object.assign(new Error('secret'), { runnerCacheFailure: failure });
      },
    });
    await storage.runOnce();
    expect(storage.lastReport?.blockers[0]).toContain('[unclassified-failure]');
    expect(JSON.stringify(storage.lastReport)).not.toContain('secret');
  });
  it('withholds arbitrary broker report blockers', async () => {
    const storage = new RunnerCacheStorage({
      listRuntimes: async () => [{ projectId: 'one', sessionIds: [] }],
      request: async () => response({ blockers: ['EPERM /private/token'], usageComplete: false }),
    });
    await storage.runOnce();
    expect(storage.lastReport?.blockers[0]).toContain('[unclassified-cache-blocker]');
    expect(JSON.stringify(storage.lastReport)).not.toContain('/private/token');
  });
});
