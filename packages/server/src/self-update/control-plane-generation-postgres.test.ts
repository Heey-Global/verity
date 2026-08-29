import {
  createPostgresDb,
  holdPostgresControlPlaneLock,
  migrateToLatest,
  PostgresAdvisoryLockHeldError,
  PostgresControlPlaneGenerationTakenError,
  PostgresControlPlaneUnreachableError,
  type Database,
  type PostgresAdvisoryLock,
} from '@verity/store';
import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createControlPlaneGenerationFence,
  GenerationFenceLostError,
} from './control-plane-generation.js';
import { claimControlPlaneGeneration } from './control-plane-hold.js';

const connectionString = process.env.VERITY_TEST_POSTGRES_URL;
const describePostgres = connectionString === undefined ? describe.skip : describe;

const quiesceApplication = `verity-generation-quiesce-${randomUUID()}`;

function withApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}

async function waitForQuiesceRowLock(db: Kysely<Database>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: number }>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and application_name = ${quiesceApplication}
        and wait_event_type = 'Lock'
    `.execute(db);
    if ((result.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for PostgreSQL generation row-lock waiter');
}

describePostgres('control-plane generation fence (PostgreSQL)', () => {
  let dbA: Kysely<Database>;
  let dbB: Kysely<Database>;
  let observerDb: Kysely<Database>;

  beforeAll(async () => {
    dbA = createPostgresDb(connectionString!);
    dbB = createPostgresDb(withApplicationName(connectionString!, quiesceApplication));
    observerDb = createPostgresDb(connectionString!);
    await migrateToLatest(observerDb);
  });

  beforeEach(async () => {
    await observerDb.deleteFrom('control_plane_generation').execute();
  });

  afterAll(async () => {
    await Promise.all([dbA.destroy(), dbB.destroy(), observerDb.destroy()]);
  });

  it('holds quiesce behind an admitted mutation on an independent connection', async () => {
    const fenceA = createControlPlaneGenerationFence(dbA);
    const fenceB = createControlPlaneGenerationFence(dbB);
    expect(await fenceA.initialize('server-a', 'bootstrap')).toBe(true);
    const active = await fenceA.read();
    expect(active).not.toBeNull();
    const expected = {
      generation: active!.generation,
      holderId: 'server-a',
      operationId: 'bootstrap',
    };

    let admitMutation!: () => void;
    let releaseMutation!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admitMutation = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = fenceA.runActive(expected, async () => {
      admitMutation();
      await release;
    });
    await admitted;

    let quiesced = false;
    const quiesce = fenceB.quiesce(active!).then((result) => {
      quiesced = true;
      return result;
    });
    try {
      await waitForQuiesceRowLock(observerDb);
      expect(quiesced).toBe(false);
    } finally {
      releaseMutation();
      await mutation;
      await expect(quiesce).resolves.toBe(true);
    }
  });

  it('admits no successor until PostgreSQL releases the incumbent session lock', async () => {
    const incumbent = await holdPostgresControlPlaneLock(connectionString!, () => undefined);
    await incumbent.activateShared();
    await expect(
      holdPostgresControlPlaneLock(connectionString!, () => undefined),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);

    await incumbent.release();
    const successor = await holdPostgresControlPlaneLock(connectionString!, () => undefined);
    await successor.release();
  });

  it('keeps activation blocked while any reused serving-pool connection exists', async () => {
    const fence = createControlPlaneGenerationFence(observerDb);
    expect(await fence.initialize('server-a', 'bootstrap')).toBe(true);
    const expected = { generation: 1, holderId: 'server-a', operationId: 'bootstrap' };
    const keeper = await holdPostgresControlPlaneLock(connectionString!, () => undefined);
    await keeper.activateShared();
    const servingDb = createPostgresDb(connectionString!, expected);
    await sql`select 1`.execute(servingDb); // creates and verifies one physical pool connection

    await keeper.release();
    await expect(
      holdPostgresControlPlaneLock(connectionString!, () => undefined),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);

    await servingDb.destroy();
    const successor = await holdPostgresControlPlaneLock(connectionString!, () => undefined);
    await successor.release();
  });
});

/**
 * The keeper's survival of a database outage, against a real PostgreSQL.
 *
 * `pg_terminate_backend` on the keeper's own session is the same event a
 * database restart delivers to it — the socket dies with `57P01`/`ECONNRESET`
 * and every lock that session held is released by PostgreSQL. It is used here
 * rather than restarting the server because these suites share one database with
 * the rest of the PostgreSQL-gated CI job; the full container restart is
 * exercised separately against a throwaway deployment.
 */
describePostgres('control-plane keeper across a database outage (PostgreSQL)', () => {
  let observerDb: Kysely<Database>;

  beforeAll(async () => {
    observerDb = createPostgresDb(connectionString!);
    await migrateToLatest(observerDb);
  });

  afterAll(async () => {
    await observerDb.destroy();
  });

  // A test that fails partway can leave a lock holder behind, and every later
  // test in this file would then fail on `PostgresAdvisoryLockHeldError` for a
  // reason that has nothing to do with what it asserts. Start each one from a
  // database with no sessions but this observer's.
  beforeEach(async () => {
    await terminateOtherSessions();
  });

  /** Kill every session except this observer's — what a restart does, at once. */
  async function terminateOtherSessions(): Promise<void> {
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and application_name <> ${quiesceApplication}
    `.execute(observerDb);
  }

  /** Kill exactly one named session, leaving every other lock holder alive. */
  async function terminateApplication(applicationName: string): Promise<void> {
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and application_name = ${applicationName}
    `.execute(observerDb);
  }

  async function settle(ms = 1_500): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * A TCP forwarder in front of PostgreSQL whose outage the test can open and
   * close on demand.
   *
   * `pg_terminate_backend` cannot express the sequence that matters most here:
   * the database goes away, a successor Server claims the generation while the
   * incumbent still cannot reach it, and only then does the incumbent get back
   * in. Terminating a backend returns the keeper to a database that is up, so it
   * reconnects within microseconds and no successor can ever be ahead of it.
   * Blocking the socket instead reproduces the real window — and does it with a
   * deadline the test controls rather than a sleep race.
   */
  async function startOutageProxy(target: string): Promise<{
    url: string;
    block: () => void;
    unblock: () => void;
    close: () => Promise<void>;
  }> {
    const upstream = new URL(target);
    const upstreamPort = Number(upstream.port === '' ? '5432' : upstream.port);
    const live = new Set<net.Socket>();
    let blocked = false;
    const server = net.createServer((incoming) => {
      if (blocked) return incoming.destroy();
      const outgoing = net.connect(upstreamPort, upstream.hostname);
      for (const socket of [incoming, outgoing]) {
        live.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => {
          live.delete(socket);
          (socket === incoming ? outgoing : incoming).destroy();
        });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(target);
    url.hostname = '127.0.0.1';
    url.port = String((server.address() as net.AddressInfo).port);
    const cut = (): void => {
      for (const socket of live) socket.destroy();
      live.clear();
    };
    return {
      url: url.toString(),
      block: () => {
        blocked = true;
        cut();
      },
      unblock: () => {
        blocked = false;
      },
      close: async () => {
        cut();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /**
   * Keep trying to take the process lock until PostgreSQL has actually noticed
   * the incumbent's socket die and released its shared hold. That is a few
   * milliseconds after the socket is cut, not zero, and waiting for it is what
   * makes "a successor got in first" a fixture rather than a coin flip.
   */
  async function takeOverAsSuccessor(): Promise<PostgresAdvisoryLock> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        return await holdPostgresControlPlaneLock(connectionString!, () => undefined);
      } catch (error) {
        if (!(error instanceof PostgresAdvisoryLockHeldError) || Date.now() >= deadline)
          throw error;
        await settle(25);
      }
    }
  }

  /**
   * A live control plane: a real generation row, a keeper armed with the real
   * fence, and the fenced serving pool `embedded.ts` builds from the same claim.
   *
   * The pool is the point. Its `verify` hook takes `pg_advisory_lock_shared` on
   * the SAME key the keeper uses and holds it for the physical connection's
   * whole life, so any reproof that asks for the key EXCLUSIVELY is contending
   * with this Server's own traffic.
   */
  async function startControlPlane(options: {
    keeperApplication: string;
    /** Defaults to PostgreSQL directly; a proxy URL routes through an outage. */
    keeperUrl?: string;
    reconnectIntervalMs?: number;
    reconnectBudgetMs?: number;
  }): Promise<{
    losses: Error[];
    keeper: PostgresAdvisoryLock;
    servingDb: Kysely<Database>;
    held: { generation: number; holderId: string; operationId: string };
    stop: () => Promise<void>;
  }> {
    await observerDb.deleteFrom('control_plane_generation').execute();
    const fence = createControlPlaneGenerationFence(observerDb);
    const holderId = `keeper-${randomUUID()}`;
    const operationId = `op-${randomUUID()}`;
    expect(await fence.initialize(holderId, operationId)).toBe(true);
    const held = { generation: 1, holderId, operationId };

    const losses: Error[] = [];
    const keeper = await holdPostgresControlPlaneLock(
      withApplicationName(options.keeperUrl ?? connectionString!, options.keeperApplication),
      (error) => losses.push(error),
      {
        reconnectIntervalMs: options.reconnectIntervalMs ?? 50,
        ...(options.reconnectBudgetMs === undefined
          ? {}
          : { reconnectBudgetMs: options.reconnectBudgetMs }),
      },
    );
    // Exactly what main.ts arms: only the fence's own verdict answers `false`.
    await keeper.activateShared(() =>
      fence.assertActive(held).then(
        () => true,
        (error: unknown) => {
          if (error instanceof GenerationFenceLostError) return false;
          throw error;
        },
      ),
    );
    const servingDb = createPostgresDb(connectionString!, held);
    // Force the pool to open a physical connection, so `verify` has actually run
    // and the shared lock is really held before anything else happens.
    await sql`select 1`.execute(servingDb);
    return {
      losses,
      keeper,
      servingDb,
      held,
      stop: async () => {
        await servingDb.destroy().catch(() => undefined);
        await keeper.release().catch(() => undefined);
      },
    };
  }

  /**
   * THE BLOCKER, in its most deterministic form: the keeper's session dies while
   * the serving pool's shared hold survives untouched, so at reproof time the
   * key is provably held shared by this Server's own pool.
   *
   * A reproof built on `pg_try_advisory_lock` reports
   * `PostgresAdvisoryLockHeldError` here and the Server exits 1 — killed by its
   * own `/sessions` polling, reporting a successor that never existed.
   */
  it('survives a reproof while its own serving pool holds the key shared', async () => {
    const keeperApplication = `verity-keeper-${randomUUID()}`;
    const cp = await startControlPlane({ keeperApplication });

    // The pool's shared hold is real and blocks an outsider's activation.
    await expect(
      holdPostgresControlPlaneLock(connectionString!, () => undefined),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);

    await terminateApplication(keeperApplication);
    await settle();

    expect(cp.losses).toEqual([]);
    // Serving traffic still works, and the fence is genuinely re-established.
    await expect(sql`select 1`.execute(cp.servingDb)).resolves.toBeDefined();
    await expect(
      holdPostgresControlPlaneLock(connectionString!, () => undefined),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);
    await cp.stop();
  }, 30_000);

  /**
   * The same event, but under the load production is actually in: every session
   * dies at once — what a restart does — while the serving pool is being driven
   * continuously across the whole reconnection window. This is the condition an
   * idle-Server recovery proof cannot see, because the pool only takes its
   * shared lock when it opens a physical connection.
   */
  it('survives a full outage while serving-pool traffic reconnects concurrently', async () => {
    const keeperApplication = `verity-keeper-${randomUUID()}`;
    // A second between attempts, exactly as production: long enough that the
    // demand-driven pool below reliably reconnects first.
    const cp = await startControlPlane({ keeperApplication, reconnectIntervalMs: 1_000 });

    let served = 0;
    const failures: unknown[] = [];
    let driving = true;
    const driver = (async () => {
      while (driving) {
        // Every checkout that has to open a physical connection runs `verify`
        // and takes the shared lock — the race, driven on purpose.
        await sql`select 1`.execute(cp.servingDb).then(
          () => {
            served += 1;
          },
          (error: unknown) => failures.push(error),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    await terminateOtherSessions();
    await settle(4_000);
    driving = false;
    await driver;

    // No verdict was reached, because none was available: nobody took anything.
    expect(cp.losses).toEqual([]);
    // The pool really did reconnect during the window, so the race really ran.
    expect(served).toBeGreaterThan(20);
    // And the keeper's hold is real again.
    await expect(
      holdPostgresControlPlaneLock(connectionString!, () => undefined),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);
    await cp.stop();
  }, 60_000);

  it('survives its session being killed and holds the lock again afterwards', async () => {
    const losses: Error[] = [];
    const keeper = await holdPostgresControlPlaneLock(
      connectionString!,
      (error) => losses.push(error),
      { reconnectIntervalMs: 50 },
    );
    await keeper.activateShared(() => Promise.resolve(true));

    await terminateOtherSessions();
    await settle();

    // No verdict was reached, because none was available: nobody took anything.
    expect(losses).toEqual([]);
    // And the hold is real again — a successor still cannot get in.
    await expect(
      holdPostgresControlPlaneLock(connectionString!, () => undefined),
    ).rejects.toBeInstanceOf(PostgresAdvisoryLockHeldError);
    await keeper.release();
  });

  /**
   * The property the re-arm must not blunt, proved against real advisory locks.
   *
   * The successor here is INSIDE its claim — `holdPostgresControlPlaneLock`
   * before `activateShared`, which is where a real one runs its migration and
   * its generation compare-and-swap — so it holds the key EXCLUSIVELY. Nothing
   * else in the system ever does, which is what makes the refusal a verdict
   * rather than the ordinary sight of a shared holder.
   *
   * Note what this test looked like before: its successor called
   * `activateShared()` first, so it held the key SHARED — the same state this
   * Server's own serving pool is in on every physical connection. The assertion
   * passed, but it was proving "the keeper dies when anyone holds shared", which
   * is the defect, not the property.
   */
  it('still yields to a genuine takeover that happens during the outage', async () => {
    const proxy = await startOutageProxy(connectionString!);
    const keeperApplication = `verity-keeper-${randomUUID()}`;
    const cp = await startControlPlane({
      keeperApplication,
      keeperUrl: proxy.url,
      reconnectIntervalMs: 100,
    });
    await cp.servingDb.destroy();

    // The database goes away for this Server, and a successor gets in first.
    proxy.block();
    const successor = await takeOverAsSuccessor();

    // The incumbent gets its socket back while the successor is still claiming.
    proxy.unblock();
    await settle(2_000);

    expect(cp.losses).toHaveLength(1);
    expect(cp.losses[0]).toBeInstanceOf(PostgresAdvisoryLockHeldError);
    await successor.release();
    await cp.keeper.release().catch(() => undefined);
    await proxy.close();
  }, 30_000);

  /**
   * Its mirror, and the other half of the takeover property. A successor that
   * has FINISHED claiming holds the key shared, so the incumbent's reproof gets
   * its shared hold back without contest — and the verdict has to come from the
   * generation row the successor advanced. Resting reproof on the lock alone
   * cannot tell this state from an ordinary serving connection; the row can.
   */
  it('yields to a successor that finished claiming and now holds only shared', async () => {
    const proxy = await startOutageProxy(connectionString!);
    const keeperApplication = `verity-keeper-${randomUUID()}`;
    const cp = await startControlPlane({
      keeperApplication,
      keeperUrl: proxy.url,
      reconnectIntervalMs: 100,
    });
    await cp.servingDb.destroy();

    proxy.block();
    const successor = await takeOverAsSuccessor();
    // The successor's whole claim, completed while the incumbent is still shut
    // out: quiesce the row it found active, acquire the next generation, then
    // downgrade to the shared hold every live Server sits in.
    const fence = createControlPlaneGenerationFence(observerDb);
    const claimed = await claimControlPlaneGeneration({
      fence,
      holderId: `successor-${randomUUID()}`,
      operationId: `op-${randomUUID()}`,
      exclusiveProcessLock: true,
    });
    expect(claimed.generation).toBeGreaterThan(cp.held.generation);
    await successor.activateShared();

    // Now let the incumbent back in. The lock tells it nothing — a shared holder
    // is what its own pool looks like — so the generation row is the verdict.
    proxy.unblock();
    await settle(2_000);

    expect(cp.losses).toHaveLength(1);
    expect(cp.losses[0]).toBeInstanceOf(PostgresControlPlaneGenerationTakenError);
    // It names the successor, and does not blame the database.
    expect(String(cp.losses[0])).toContain('held by another Server');
    await successor.release();
    await cp.keeper.release().catch(() => undefined);
    await proxy.close();
  }, 30_000);

  it('reports the database as unreachable, not a takeover, when it never comes back', async () => {
    const losses: Error[] = [];
    const keeper = await holdPostgresControlPlaneLock(
      'postgres://verity@127.0.0.1:1/verity', // nothing listens here, ever
      (error) => losses.push(error),
      { reconnectBudgetMs: 300, reconnectIntervalMs: 50 },
    ).catch(() => undefined);
    // The initial connect fails outright, which is startup's problem to retry;
    // this asserts the shape of the error rather than a keeper that exists.
    expect(keeper).toBeUndefined();

    // Now the same budget, from a keeper that DID start and then lost its socket.
    const live: Error[] = [];
    const held = await holdPostgresControlPlaneLock(
      connectionString!,
      (error) => live.push(error),
      {
        reconnectBudgetMs: 300,
        reconnectIntervalMs: 50,
      },
    );
    await held.activateShared(() =>
      Promise.reject(new Error('Connection terminated unexpectedly')),
    );
    await terminateOtherSessions();
    await settle(2_000);

    expect(live).toHaveLength(1);
    expect(live[0]).toBeInstanceOf(PostgresControlPlaneUnreachableError);
    expect(String(live[0])).not.toContain('another Server');
    await held.release().catch(() => undefined);
  }, 30_000);
});
