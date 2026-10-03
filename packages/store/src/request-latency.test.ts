import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
  type PostgresCursor,
} from 'kysely';
import {
  createRequestLatencyTrace,
  instrumentPostgresPool,
  measureLatencyPhase,
  recordRequestQuery,
  withRequestLatencyTrace,
} from './request-latency.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class QueryClient implements PostgresPoolClient {
  release = vi.fn();
  query<R>(sql: string, parameters: ReadonlyArray<unknown>): Promise<PostgresQueryResult<R>>;
  query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  query<R>(
    source: string | PostgresCursor<R>,
  ): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    if (typeof source !== 'string') return source;
    return Promise.resolve({ rows: [], command: 'SELECT', rowCount: 0 });
  }
}

function fixture() {
  const client = new QueryClient();
  const pool = {
    options: {},
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  return { pool: pool satisfies PostgresPool, client };
}

describe('request latency attribution', () => {
  it('keeps overlapping request contexts separate, including failures', async () => {
    const first = createRequestLatencyTrace();
    const second = createRequestLatencyTrace();
    const gate = deferred<void>();
    const failed = new Error('query failed');
    const pending = withRequestLatencyTrace(first, () =>
      measureLatencyPhase('project_list', async () => {
        await gate.promise;
        recordRequestQuery(25, false);
      }),
    );
    await withRequestLatencyTrace(second, async () => {
      await expect(
        measureLatencyPhase('session_list', async () => {
          recordRequestQuery(70, true);
          throw failed;
        }),
      ).rejects.toBe(failed);
    });
    gate.resolve();
    await pending;
    expect(first.queries).toMatchObject({ calls: 1, totalMs: 25, maxMs: 25, errors: 0 });
    expect(second.queries).toMatchObject({ calls: 1, totalMs: 70, maxMs: 70, errors: 1 });
    expect(Object.keys(first.phases)).toEqual(['project_list']);
    expect(Object.keys(second.phases)).toEqual(['session_list']);
    // Unrelated background work must not get attributed to the last HTTP request.
    recordRequestQuery(10_000, true);
    expect(second.queries.calls).toBe(1);
  });

  it('measures pool checkout separately from query execution through Kysely', async () => {
    const { pool, client } = fixture();
    const released = client.release;
    const gate = deferred<typeof client>();
    vi.mocked(pool.connect).mockReturnValue(gate.promise);
    const trace = createRequestLatencyTrace();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const db = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({
        pool: instrumentPostgresPool(pool, () => ({ waiting: 3, total: 10 })),
      }),
      log: (event) => recordRequestQuery(event.queryDurationMillis, event.level === 'error'),
    });
    try {
      const pending = withRequestLatencyTrace(trace, () =>
        db.executeQuery(CompiledQuery.raw('select $1', ['private-payload'])),
      );
      // Let Kysely finish lazy driver initialization and reach checkout.
      await vi.waitFor(() => expect(pool.connect).toHaveBeenCalled());
      clock.mockReturnValue(2_100);
      gate.resolve(client);
      await pending;
      expect(trace.poolAcquire).toMatchObject({
        calls: 1,
        totalMs: 2_000,
        maxMs: 2_000,
        errors: 0,
        waitingMax: 3,
        totalMax: 10,
      });
      expect(trace.queries.calls).toBe(1);
      expect(trace.queries.totalMs).toBeLessThan(trace.poolAcquire.totalMs);
      expect(released).toHaveBeenCalledOnce();
      expect(JSON.stringify(trace)).not.toContain('private-payload');
    } finally {
      clock.mockRestore();
      await db.destroy();
    }
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('times failed checkout without changing its error or running a query', async () => {
    const { pool } = fixture();
    const failure = new Error('connection failed');
    vi.mocked(pool.connect).mockRejectedValue(failure);
    const trace = createRequestLatencyTrace();
    const wrapped = instrumentPostgresPool(pool, () => ({ waiting: 0, total: 0 }));
    await withRequestLatencyTrace(trace, async () => {
      await expect(wrapped.connect()).rejects.toBe(failure);
    });
    expect(trace.poolAcquire).toMatchObject({ calls: 1, errors: 1 });
    expect(trace.queries.calls).toBe(0);
  });

  it('identifies application code for a background Kysely checkout without SQL', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    const queryGate = deferred<PostgresQueryResult<unknown>>();
    vi.spyOn(client, 'query').mockImplementation(() => queryGate.promise as never);
    const checkoutGate = deferred<QueryClient>();
    pool.connect.mockResolvedValueOnce(client).mockReturnValueOnce(checkoutGate.promise);
    const wrapped = instrumentPostgresPool(pool, () => ({ waiting: 1, total: 1 }));
    const db = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool: wrapped }),
    });
    try {
      const background = (async () =>
        await db.executeQuery(CompiledQuery.raw('select $1', ['private-background-secret'])))();
      // Driver initialization happens asynchronously before it requests a client.
      for (let turn = 0; turn < 20 && pool.connect.mock.calls.length === 0; turn++)
        await Promise.resolve();
      expect(pool.connect).toHaveBeenCalledOnce();
      const trace = createRequestLatencyTrace();
      const pending = withRequestLatencyTrace(trace, () => wrapped.connect());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(trace.poolAcquire.holders?.[0]?.owner).toContain('request-latency.test.ts:');
      expect(JSON.stringify(trace)).not.toContain('private-background-secret');
      queryGate.resolve({ rows: [], command: 'SELECT', rowCount: 0 });
      await background;
      checkoutGate.resolve(new QueryClient());
      (await pending).release();
    } finally {
      vi.useRealTimers();
      await db.destroy();
    }
  });

  it('captures live background and request holders, then removes them on release and reuse', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    const other = new QueryClient();
    const gate = deferred<QueryClient>();
    pool.connect
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce(other)
      .mockReturnValueOnce(gate.promise);
    const wrapped = instrumentPostgresPool(pool, () => ({ waiting: 1, total: 2 }));
    try {
      const background = await wrapped.connect();
      const owner = createRequestLatencyTrace();
      owner.owner = 'POST /sessions (req-1)';
      const held = await withRequestLatencyTrace(owner, () => wrapped.connect());
      const waiting = createRequestLatencyTrace();
      const pending = withRequestLatencyTrace(waiting, () => wrapped.connect());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waiting.poolAcquire.holders).toEqual([
        {
          owner: expect.stringMatching(/^background:request-latency.test.ts:\d+:\d+/),
          heldMs: expect.any(Number),
        },
        { owner: owner.owner, heldMs: expect.any(Number) },
      ]);
      const released = vi.fn();
      background.release();
      // Real pg refreshes release when lending the same client again.
      client.release = released;
      gate.resolve(client);
      const reused = await pending;
      held.release();
      const nextGate = deferred<QueryClient>();
      pool.connect.mockReturnValueOnce(nextGate.promise);
      const next = createRequestLatencyTrace();
      const nextPending = withRequestLatencyTrace(next, () => wrapped.connect());
      reused.release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(next.poolAcquire.holders).toEqual([]);
      expect(released).toHaveBeenCalledOnce();
      client.release = vi.fn();
      nextGate.resolve(client);
      (await nextPending).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the acquisition phase and PostgreSQL PID for a held connection', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    Object.assign(client, { processID: 4321 });
    const gate = deferred<QueryClient>();
    pool.connect.mockResolvedValueOnce(client).mockReturnValueOnce(gate.promise);
    const wrapped = instrumentPostgresPool(pool, () => ({ waiting: 1, total: 1 }));
    try {
      const holder = createRequestLatencyTrace();
      holder.owner = 'GET /projects (req-1)';
      const connection = await withRequestLatencyTrace(holder, () =>
        measureLatencyPhase('project_overview', () =>
          measureLatencyPhase('project_release_persist', () => wrapped.connect()),
        ),
      );
      const waiter = createRequestLatencyTrace();
      const pending = withRequestLatencyTrace(waiter, () => wrapped.connect());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waiter.poolAcquire.holders).toEqual([
        expect.objectContaining({
          owner: holder.owner,
          phase: 'project_release_persist',
          backendPid: 4321,
        }),
      ]);
      expect(waiter.poolAcquire.holderSampleWaitMs).toBeGreaterThanOrEqual(0);
      connection.release();
      gate.resolve(new QueryClient());
      (await pending).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a snapshot even when the underlying pool has many clients', async () => {
    vi.useFakeTimers();
    const { pool } = fixture();
    pool.connect.mockImplementation(async () => new QueryClient());
    const wrapped = instrumentPostgresPool(pool, () => ({ waiting: 1, total: 12 }));
    try {
      const connections = [];
      for (let index = 0; index < 12; index++) connections.push(await wrapped.connect());
      const gate = deferred<QueryClient>();
      pool.connect.mockReturnValueOnce(gate.promise);
      const trace = createRequestLatencyTrace();
      const pending = withRequestLatencyTrace(trace, () => wrapped.connect());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(trace.poolAcquire.holders).toHaveLength(10);
      for (const connection of connections) connection.release();
      gate.resolve(new QueryClient());
      (await pending).release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the sampler when checkout throws synchronously', async () => {
    vi.useFakeTimers();
    const { pool } = fixture();
    const error = new Error('private-error');
    pool.connect.mockImplementation(() => {
      throw error;
    });
    const wrapped = instrumentPostgresPool(pool, () => ({ waiting: 0, total: 0 }));
    const trace = createRequestLatencyTrace();
    try {
      await expect(withRequestLatencyTrace(trace, () => wrapped.connect())).rejects.toBe(error);
      expect(trace.poolAcquire.errors).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(trace)).not.toContain('private-error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves background checkout and release without a request trace', async () => {
    const { pool, client } = fixture();
    const counts = vi.fn(() => ({ waiting: 0, total: 0 }));
    const wrapped = instrumentPostgresPool(pool, counts);
    const originalRelease = client.release;
    expect(await wrapped.connect()).toBe(client);
    client.release();
    expect(originalRelease).toHaveBeenCalledOnce();
    expect(client.release).toBe(originalRelease);
    expect(counts).not.toHaveBeenCalled();
    expect(wrapped.options).toBe(pool.options);
    await wrapped.end();
    expect(pool.end).toHaveBeenCalledOnce();
    await expect(measureLatencyPhase('session_list', async () => 7)).resolves.toBe(7);
  });
});
