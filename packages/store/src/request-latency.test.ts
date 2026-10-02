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
      expect(client.release).toHaveBeenCalledOnce();
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

  it('preserves background checkout and release without a request trace', async () => {
    const { pool, client } = fixture();
    const counts = vi.fn(() => ({ waiting: 0, total: 0 }));
    const wrapped = instrumentPostgresPool(pool, counts);
    expect(await wrapped.connect()).toBe(client);
    expect(counts).not.toHaveBeenCalled();
    expect(wrapped.options).toBe(pool.options);
    await wrapped.end();
    expect(pool.end).toHaveBeenCalledOnce();
    await expect(measureLatencyPhase('session_list', async () => 7)).resolves.toBe(7);
  });
});
