import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// createPostgresDb is the production (real-Postgres) path — the store's own tests
// run on pglite via createTestDb, so this file mocks `pg` to exercise the pool
// wiring + the mandatory idle-client error handler without a live database.
const pools: FakePool[] = [];
const clients: FakeClient[] = [];
let nextLockAcquired = true;
let nextGenerationHeld = true;

class FakePool extends EventEmitter {
  constructor(public readonly config: unknown) {
    super();
    pools.push(this);
  }
  // Kysely's PostgresDialect only touches the pool lazily (on a query); these tests
  // never query. Provide end()/query() as inert stubs so a destroy()/GC is harmless.
  end(): Promise<void> {
    return Promise.resolve();
  }
  query(): Promise<{ rows: never[] }> {
    return Promise.resolve({ rows: [] });
  }
}

/**
 * Per-connection scripting for the keeper's reconnect path. Each entry is
 * consumed by one `new pg.Client(...)`:
 *
 *   - `'connect-fails'` — a database that is not answering yet.
 *   - `'auth-fails'`    — one that answered and said no.
 *   - `'lock-held'`     — a successor inside its claim, holding this key
 *                         EXCLUSIVELY: neither mode can be taken.
 *   - `'pool-shared'`   — the production reconnect race. Some other session
 *                         holds the key SHARED, so exclusive is refused and
 *                         shared is granted. In production that session is this
 *                         Server's OWN serving pool, whose `verify` hook takes
 *                         the same shared lock and which reconnects in the same
 *                         instant as the keeper.
 *   - `'ok'`            — an uncontended session.
 */
let connectionScript: Array<'ok' | 'connect-fails' | 'auth-fails' | 'lock-held' | 'pool-shared'> =
  [];

class FakeClient extends EventEmitter {
  readonly script = connectionScript.shift() ?? (nextLockAcquired ? 'ok' : 'lock-held');
  readonly connect = vi.fn(() =>
    this.script === 'connect-fails'
      ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      : this.script === 'auth-fails'
        ? // SQLSTATE 28P01: the server is up and reachable and rejected us.
          Promise.reject(
            Object.assign(new Error('password authentication failed for user "verity"'), {
              code: '28P01',
            }),
          )
        : Promise.resolve(),
  );
  readonly end = vi.fn(() => Promise.resolve());
  // `_shared` is matched FIRST: 'pg_try_advisory_lock_shared' also contains
  // 'pg_try_advisory_lock', and the whole point of these scripts is that the two
  // modes can answer differently.
  readonly query = vi.fn((text: string) =>
    Promise.resolve({
      rows: text.includes('pg_try_advisory_lock_shared')
        ? [{ acquired: this.script === 'ok' || this.script === 'pool-shared' }]
        : text.includes('pg_try_advisory_lock')
          ? [{ acquired: this.script === 'ok' }]
          : text.includes('select exists')
            ? [{ held: nextGenerationHeld }]
            : [],
    }),
  );
  constructor(public readonly config: unknown) {
    super();
    clients.push(this);
  }
}

vi.mock('pg', () => ({ default: { Pool: FakePool, Client: FakeClient } }));

const {
  createPostgresDb,
  holdPostgresControlPlaneLock,
  isPostgresConnectionClassError,
  PostgresAdvisoryLockHeldError,
  PostgresControlPlaneUnreachableError,
} = await import('./db.js');

/** No real elapsed time; the budget is spent by the loop, not by the clock. */
const instantly = { sleep: () => Promise.resolve(), reconnectIntervalMs: 1 };

/**
 * Captured at module load, before any spy can be installed. Reading it inside
 * the spy instead would capture whatever spy a previous test left behind, and
 * the call-through would recurse until the stack ran out.
 */
const realSetTimeout = globalThis.setTimeout;

/** Let the keeper's reconnect, which starts from an event handler, settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('createPostgresDb', () => {
  afterEach(() => {
    pools.length = 0;
    clients.length = 0;
    nextLockAcquired = true;
    nextGenerationHeld = true;
    vi.restoreAllMocks();
  });

  it('builds a Kysely bound to a pg pool for the given connection string', async () => {
    const db = createPostgresDb('postgresql://user@localhost:5432/verity');
    expect(pools).toHaveLength(1);
    expect(pools[0]!.config).toEqual({
      connectionString: 'postgresql://user@localhost:5432/verity',
    });
    await db.destroy();
  });

  it('registers a pool error handler that logs and recovers — never rethrows', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createPostgresDb('postgresql://localhost/x');

    // An idle pooled client's backend dying surfaces as a pool 'error'. Node crashes
    // the process on an 'error' event with NO listener, so the handler is mandatory —
    // it must swallow + log, not throw (the pool hands out a fresh client next time).
    expect(() =>
      pools[0]!.emit('error', new Error('idle-in-transaction terminated')),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('idle postgres client error (pool recovered)'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('idle-in-transaction terminated'),
    );

    await db.destroy();
  });

  it('guards every connection it opens, not only the ones idle in the pool', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createPostgresDb('postgresql://localhost/x');

    // The handler above is `pg`'s IDLE-client channel, and `pg` detaches the
    // listener behind it for as long as a client is checked out — every
    // transaction, and every gap between two statements of the `verify` hook
    // below. So `createPostgresDb` attaches its own listener on 'connect', which
    // `pg` emits before the checkout detaches anything and never removes. Its
    // absence is not a degraded log: an 'error' with no listener at all is an
    // uncaught exception, and the Server dies of the PostgreSQL restart it is
    // built to survive. Asserted through the real pool contract — the pool
    // announces a new connection, and the client must come away guarded.
    const client = new EventEmitter();
    pools[0]!.emit('connect', client);
    expect(client.listenerCount('error')).toBe(1);

    expect(() => client.emit('error', new Error('terminating connection'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('postgres client error while checked out'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('terminating connection'));

    await db.destroy();
  });

  it('leaves an idle connection to the pool handler rather than logging it twice', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createPostgresDb('postgresql://localhost/x');

    // `pg` re-attaches its own idle listener when a client goes back into the
    // pool, and that listener reports through `pool.on('error')`. Both listeners
    // are then present, so the guard must stay quiet: otherwise every idle
    // disconnect is logged twice, once under a line claiming the connection was
    // checked out when it was not.
    const client = new EventEmitter();
    pools[0]!.emit('connect', client);
    client.on('error', () => {}); // stands in for pg's idle listener

    expect(() => client.emit('error', new Error('idle backend terminated'))).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();

    await db.destroy();
  });

  it('admits pooled connections only behind the shared lock and expected generation', async () => {
    const db = createPostgresDb('postgresql://localhost/x', {
      generation: 7,
      holderId: 'server-7',
      operationId: 'update-7',
    });
    const verify = (
      pools[0]!.config as { verify: (client: FakeClient, done: (error?: Error) => void) => void }
    ).verify;
    const client = new FakeClient({});
    await new Promise<void>((resolve, reject) =>
      verify(client, (error) => (error ? reject(error) : resolve())),
    );
    expect(client.query.mock.calls[0]?.[0]).toContain('pg_advisory_lock_shared');
    expect(client.query.mock.calls[1]?.[0]).toContain('select exists');
    expect(client.query).toHaveBeenCalledTimes(2);
    await db.destroy();
  });
});

describe('holdPostgresControlPlaneLock', () => {
  afterEach(() => {
    clients.length = 0;
    connectionScript = [];
    nextLockAcquired = true;
    vi.restoreAllMocks();
  });

  it('holds one dedicated session until an idempotent release', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock('postgresql://localhost/verity', onLost);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.connect).toHaveBeenCalledOnce();
    expect(clients[0]!.query.mock.calls[0]?.[0]).toContain('pg_try_advisory_lock');

    await lock.activateShared();
    await lock.release();
    await lock.release();
    expect(clients[0]!.query.mock.calls[1]?.[0]).toContain('pg_advisory_lock_shared');
    expect(clients[0]!.query.mock.calls[2]?.[0]).toContain('pg_advisory_unlock');
    expect(clients[0]!.query.mock.calls[3]?.[0]).toContain('pg_advisory_unlock_shared');
    expect(clients[0]!.query).toHaveBeenCalledTimes(4);
    expect(clients[0]!.end).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('refuses a second live holder and closes its rejected session', async () => {
    nextLockAcquired = false;
    await expect(
      holdPostgresControlPlaneLock('postgresql://localhost/verity', vi.fn()),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);
    expect(clients[0]!.end).toHaveBeenCalledOnce();
  });

  it('ignores errors after release', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.release();
    // The handler stays attached and goes inert, rather than being detached.
    // Release itself runs an unlock query and then end(), which is precisely
    // when a dying socket is most likely to emit — and a bare EventEmitter
    // 'error' with no listener is an uncaught exception, not a no-op.
    expect(clients[0]!.listenerCount('error')).toBe(1);
    expect(() =>
      clients[0]!.emit('error', new Error('connection lost after release')),
    ).not.toThrow();
    await settle();
    expect(onLost).not.toHaveBeenCalled();
  });

  // The incident this whole file's keeper changes exist for: a Postgres restart
  // under a live Server used to reach `onLost` straight from this event, and the
  // Server exited 1 and came back sealed. Nobody had taken anything.
  it('reconnects and re-proves after a transport error instead of reporting a loss', async () => {
    const onLost = vi.fn();
    // Records how much had already been asked of the reconnected session when
    // the proof ran, which is how the ORDER is pinned: the lock is the gate, and
    // the generation row only means anything while the gate is held.
    const queriesBeforeProof: number[] = [];
    const proof = vi.fn(() => {
      queriesBeforeProof.push(clients.at(-1)!.query.mock.calls.length);
      return Promise.resolve(true);
    });
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(proof);

    // Two failed reconnects (Postgres still replaying WAL), then a healthy one.
    connectionScript = ['connect-fails', 'connect-fails', 'ok'];
    clients[0]!.emit('error', new Error('terminating connection due to administrator command'));
    await settle();

    expect(onLost).not.toHaveBeenCalled();
    expect(proof).toHaveBeenCalledTimes(1);
    const recovered = clients.at(-1)!;
    // Exactly the mode that was lost, and nothing stronger: one
    // `pg_try_advisory_lock_shared`, then the generation row. Re-taking
    // exclusive here — even transiently, to downgrade again — is what loses to
    // this Server's own serving pool.
    expect(recovered.query.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('pg_try_advisory_lock_shared'),
    ]);
    // The lock was already re-taken when the proof ran, never the other way.
    expect(queriesBeforeProof).toEqual([1]);

    // Release now goes through the RECONNECTED session, not the dead one.
    await lock.release();
    expect(recovered.query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock_shared');
    expect(onLost).not.toHaveBeenCalled();
  });

  // The blocker this reproof path was rewritten for. Both the keeper and the
  // serving pool reconnect the instant Postgres comes back, and the pool
  // ordinarily wins: it opens connections on demand under `/sessions` polling,
  // while the keeper backs off a second between attempts. Re-taking EXCLUSIVE
  // here loses to the Server's own traffic and reports a successor that does not
  // exist — the Server killing itself with its own polling.
  it('survives its own serving pool holding the key shared during reproof', async () => {
    const onLost = vi.fn();
    const proof = vi.fn(() => Promise.resolve(true));
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(proof);

    connectionScript = ['pool-shared'];
    clients[0]!.emit('error', new Error('terminating connection due to administrator command'));
    await settle();

    expect(onLost).not.toHaveBeenCalled();
    // It really re-established the fence — it did not merely decline to die.
    const recovered = clients.at(-1)!;
    expect(recovered.query.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('pg_try_advisory_lock_shared'),
    ]);
    expect(proof).toHaveBeenCalledTimes(1);
    await lock.release();
    expect(recovered.query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock_shared');
  });

  // The other direction of the same race, and the property the re-arm must not
  // blunt: a successor INSIDE its claim holds this key exclusively, so shared is
  // refused too. Only `takeExclusive` ever takes it that way, so — unlike a
  // shared holder — that observation names a competing Server.
  it('still reports a loss when a successor holds the process lock exclusively', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(() => Promise.resolve(true));

    connectionScript = ['lock-held'];
    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0]?.[0]).toBeInstanceOf(PostgresAdvisoryLockHeldError);
  });

  // Before activation there is no generation and no fenced serving pool — the
  // migration pool `main.ts` builds first takes no advisory lock at all — so the
  // claim-window keeper is still entitled to ask for exclusive, and must, since
  // exclusive is the mode it lost.
  it('re-takes exclusive, not shared, when the socket dies before activation', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );

    connectionScript = ['ok'];
    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    const recovered = clients.at(-1)!;
    expect(recovered.query.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('pg_try_advisory_lock'),
    ]);
    expect(recovered.query.mock.calls[0]?.[0]).not.toContain('_shared');
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });

  it('reports a loss when the generation proof answers false', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(() => Promise.resolve(false));

    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(String(onLost.mock.calls[0]?.[0])).toContain(
      'the control-plane generation is held by another Server',
    );
  });

  // A proof that could not reach the database proves nothing — the same rule
  // `watchControlPlaneGeneration` already applies to its heartbeat.
  it('keeps retrying when the generation proof cannot reach the database', async () => {
    const onLost = vi.fn();
    let attempts = 0;
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(() => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('Connection terminated unexpectedly'))
        : Promise.resolve(true);
    });

    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    expect(attempts).toBe(3);
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });

  /**
   * The mirror of `control-plane-hold.test.ts`'s referenced-timer case, and the
   * other half of a deliberate asymmetry that no other test here can see: every
   * case in this file injects `sleep`, so the production default never runs.
   *
   * The keeper's wait is unref'ed ON PURPOSE. It runs inside a Server that is
   * already serving, so its HTTP listener is what keeps the event loop alive;
   * an extra referenced timer would only be able to delay a shutdown. The
   * startup wait in `openControlPlaneProcessLock` is the opposite case and must
   * stay referenced. Pinning both directions is what stops one being "fixed"
   * into the other.
   */
  it('waits between reconnect attempts on an UNREF-ed timer', async () => {
    const seen: Array<{ ms: number; referenced: boolean }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const timer = realSetTimeout(handler, ms, ...rest);
      // `.unref()` runs on the value `setTimeout` RETURNS, so ref-ness has to be
      // read after this call, not inside it.
      queueMicrotask(() => seen.push({ ms: ms ?? 0, referenced: timer.hasRef() }));
      return timer;
    }) as typeof globalThis.setTimeout);

    const onLost = vi.fn();
    // NO `sleep` — the production default is the subject of this test.
    const lock = await holdPostgresControlPlaneLock('postgresql://localhost/verity', onLost, {
      reconnectIntervalMs: 11,
    });
    await lock.activateShared(() => Promise.resolve(true));

    connectionScript = ['connect-fails', 'ok'];
    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    await settle();

    const waits = seen.filter((timer) => timer.ms === 11);
    expect(waits).toHaveLength(1);
    expect(waits.every((timer) => timer.referenced)).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });

  it('reports the database as unreachable once the reconnect budget expires', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock('postgresql://localhost/verity', onLost, {
      ...instantly,
      reconnectBudgetMs: 0, // the first failure is already past the deadline
    });
    await lock.activateShared(() => Promise.resolve(true));

    connectionScript = ['connect-fails'];
    clients[0]!.emit('error', new Error('terminating connection due to administrator command'));
    await settle();

    expect(onLost).toHaveBeenCalledTimes(1);
    const reported = onLost.mock.calls[0]?.[0] as Error;
    expect(reported).toBeInstanceOf(PostgresControlPlaneUnreachableError);
    // It must not claim a takeover it did not observe.
    expect(reported.message).not.toContain('another Server');
    expect(reported.message).toContain('stayed unreachable');
  });

  it('reports a non-connection failure at once instead of waiting out the budget', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock('postgresql://localhost/verity', onLost, {
      ...instantly,
      // Generous on purpose: a budget this long would mask the bug, because a
      // retried-forever error would simply not have been reported yet.
      reconnectBudgetMs: 600_000,
    });
    await lock.activateShared(() => Promise.resolve(true));

    // A rejected credential is a real answer, not a database that is still
    // starting, so it must end the keeper immediately and by its own name.
    connectionScript = ['auth-fails'];
    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    expect(onLost).toHaveBeenCalledTimes(1);
    const reported = onLost.mock.calls[0]?.[0] as Error;
    expect(reported).not.toBeInstanceOf(PostgresControlPlaneUnreachableError);
    expect(reported.message).toContain('password authentication failed');
    expect(reported.message).not.toContain('another Server');
  });

  it('keeps waiting out a proof that throws a connection-class error', async () => {
    const onLost = vi.fn();
    const proof = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(Object.assign(new Error('proof ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValue(true);
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(proof);

    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    // The proof failing to reach the database proves nothing about who holds
    // the generation, so it is retried rather than believed.
    expect(proof).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });

  it('ignores a late error from a client that recovery already replaced', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(() => Promise.resolve(true));

    const superseded = clients[0]!;
    superseded.emit('error', new Error('connection terminated unexpectedly'));
    await settle();
    const recovered = clients[clients.length - 1]!;
    const afterRecovery = clients.length;
    expect(recovered).not.toBe(superseded);

    // The dead socket emits once more, after recovery has already finished. It
    // must still HAVE a listener — node turns an 'error' with none into an
    // uncaught exception — and that listener must do nothing, because acting on
    // it would tear down the healthy connection recovery just installed.
    expect(() => superseded.emit('error', new Error('ECONNRESET after end'))).not.toThrow();
    await settle();

    expect(clients.length).toBe(afterRecovery);
    expect(recovered.end).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });

  it('re-proves only once for a burst of transport errors from one outage', async () => {
    const onLost = vi.fn();
    const proof = vi.fn(() => Promise.resolve(true));
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared(proof);
    const before = clients.length;

    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    clients[0]!.emit('error', new Error('connection terminated unexpectedly'));
    await settle();

    expect(clients.length).toBe(before + 1);
    expect(proof).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });
  // node-postgres defaults to NO connection timeout, so a blackholed database
  // leaves `connect()` pending forever — a wait that sits outside the reconnect
  // budget entirely, where it would keep the keeper from ever reporting a loss
  // or honouring its deadline. Every keeper session must carry the bound: the
  // first one, and each reconnect candidate after it.
  it('bounds the connect attempt on every keeper session', async () => {
    const onLost = vi.fn();
    const lock = await holdPostgresControlPlaneLock(
      'postgresql://localhost/verity',
      onLost,
      instantly,
    );
    await lock.activateShared();

    clients[0]!.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await settle();

    // A reconnect actually happened, otherwise this asserts nothing about the
    // recovery path.
    expect(clients.length).toBeGreaterThan(1);
    for (const client of clients) {
      const { connectionTimeoutMillis } = client.config as { connectionTimeoutMillis?: number };
      expect(typeof connectionTimeoutMillis).toBe('number');
      expect(connectionTimeoutMillis).toBeGreaterThan(0);
      expect(Number.isFinite(connectionTimeoutMillis)).toBe(true);
    }
    expect(onLost).not.toHaveBeenCalled();
    await lock.release();
  });
});

describe('isPostgresConnectionClassError', () => {
  // Every code below was OBSERVED driving a real postgres:18-alpine through
  // `docker restart`, `docker rm -f` + recreate, and SIGKILL + start.
  it.each([
    ['ECONNREFUSED', { code: 'ECONNREFUSED' }],
    ['ECONNRESET', { code: 'ECONNRESET' }],
    ['starting up (57P03)', { code: '57P03' }],
    ['admin shutdown (57P01)', { code: '57P01' }],
    ['a codeless terminated socket', new Error('Connection terminated unexpectedly')],
    // What `connectionTimeoutMillis` throws: no code, no SQLSTATE. Silence from
    // the database, so it belongs with the waits, not with the verdicts.
    ['a connect attempt that timed out', new Error('timeout expired')],
  ])('treats %s as not-reachable-yet', (_label, error) => {
    expect(isPostgresConnectionClassError(error)).toBe(true);
  });

  it.each([
    ['a bad password', { code: '28P01' }],
    ['a missing relation', { code: '42P01' }],
    ['a plain error', new Error('control-plane generation fence is not held')],
    ['a non-object', 'ECONNREFUSED'],
  ])('does not excuse %s', (_label, error) => {
    expect(isPostgresConnectionClassError(error)).toBe(false);
  });
});
