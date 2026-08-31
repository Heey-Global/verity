import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createControlPlaneGenerationFence,
  GenerationFenceLostError,
  type ControlPlaneGenerationFence,
} from './control-plane-generation.js';
import {
  claimControlPlaneGeneration,
  classifyKeeperLoss,
  openControlPlaneProcessLock,
  watchControlPlaneGeneration,
} from './control-plane-hold.js';
import {
  PostgresAdvisoryLockHeldError,
  PostgresControlPlaneGenerationTakenError,
  PostgresControlPlaneUnreachableError,
  type PostgresAdvisoryLock,
} from '@verity/store';

/**
 * Captured at module load, before any spy can be installed. Reading it inside
 * the spy factory instead would capture whatever spy a previous test left
 * behind, and the call-through would recurse until the stack ran out.
 */
const realSetTimeout = globalThis.setTimeout;

/**
 * The mapping from "what the keeper established" to "what the operator is
 * told". It is the whole point of the change: the incident was diagnosed as a
 * takeover for hours because every keeper failure was reported as one.
 */
describe('classifying why the control plane was given up', () => {
  it.each([
    [
      'a successor holding the process lock',
      new PostgresAdvisoryLockHeldError(),
      'process-lock-taken',
    ],
    [
      'a database that never came back',
      new PostgresControlPlaneUnreachableError(120_000, new Error('ECONNREFUSED')),
      'unreachable',
    ],
    [
      'a generation proved to be elsewhere',
      new PostgresControlPlaneGenerationTakenError(new Error('socket died')),
      'generation-taken',
    ],
  ])('reports %s as its own kind', (_label, error, kind) => {
    expect(classifyKeeperLoss(error).kind).toBe(kind);
  });

  // The one that matters most. A wrong password establishes nothing about who
  // holds the generation, and calling it a takeover is what sent an operator
  // looking for a second Server that did not exist.
  it.each([
    ['a rejected credential', Object.assign(new Error('bad password'), { code: '28P01' })],
    ['a query error', Object.assign(new Error('relation does not exist'), { code: '42P01' })],
    ['a bug thrown out of the generation proof', new TypeError('x is not a function')],
    ['a fence error that never crossed the keeper', new GenerationFenceLostError()],
  ])('does not call %s a takeover', (_label, error) => {
    const loss = classifyKeeperLoss(error);
    expect(loss.kind).toBe('unexpected');
    // The cause is carried, because it is the thing to actually go and fix.
    expect(loss).toMatchObject({ error });
  });
});

describe('opening the control-plane process lock', () => {
  const lock = { activateShared: async () => undefined, release: async () => undefined };

  /**
   * A fresh set of options per case, whose injected `sleep` REFUSES to be called
   * forever.
   *
   * An instant sleep is what makes these cases fast, and it is also what turns
   * "this loop never terminates" from a failed assertion into a hung worker: the
   * loop spins as fast as the microtask queue allows and the test process dies
   * of memory exhaustion before it reaches a single `expect`. Three separate
   * mutations of this function — waiting out a live incumbent unconditionally,
   * never expiring the connect budget, waiting out a misconfiguration — all
   * produced exactly that, so the suite reported a crash rather than naming the
   * assertion each one broke.
   *
   * The cap fixes that. Every legitimate case here sleeps a handful of times;
   * anything past the cap is a runaway, and throwing a plain (non
   * connection-class) error out of the wait makes the function give up at once,
   * so the case fails by name with this message.
   */
  function base(): {
    connectionString: string;
    onLost: () => void;
    waitForActivation: boolean;
    sleep: () => Promise<void>;
    connectIntervalMs: number;
  } {
    let waits = 0;
    return {
      connectionString: 'postgres://verity@postgres:5432/verity',
      onLost: () => undefined,
      waitForActivation: false,
      sleep: () => {
        waits += 1;
        return waits > 20
          ? Promise.reject(new Error('runaway retry loop: the wait was never going to end'))
          : Promise.resolve();
      },
      connectIntervalMs: 1,
    };
  }

  const refused = (): Error =>
    Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });

  /**
   * Record the ref-ness of every real timer production code schedules.
   *
   * `ms` identifies them: a distinctive interval separates the wait under test
   * from whatever the test runner happens to schedule alongside it. Ref-ness is
   * read on a microtask rather than inside the spy, because `.unref()` is called
   * on the value `setTimeout` RETURNS — inside the spy every timer still looks
   * referenced.
   */
  function recordTimerRefs(): Array<{ ms: number; referenced: boolean }> {
    const seen: Array<{ ms: number; referenced: boolean }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const timer = realSetTimeout(handler, ms, ...rest);
      queueMicrotask(() => seen.push({ ms: ms ?? 0, referenced: timer.hasRef() }));
      return timer;
    }) as typeof globalThis.setTimeout);
    return seen;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The incident's SECOND crash: the Server that restarted after the first one
  // raced its own not-yet-ready Postgres and exited 1 on this error.
  it('waits out a database that is not answering yet', async () => {
    const attempts: number[] = [];
    const hold = vi.fn(() => {
      attempts.push(attempts.length);
      return attempts.length < 4
        ? Promise.reject(refused())
        : Promise.resolve(lock as PostgresAdvisoryLock);
    });
    const onRetry = vi.fn();

    await expect(openControlPlaneProcessLock({ ...base(), hold, onRetry })).resolves.toBe(lock);
    expect(hold).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('gives up once the connect budget is spent', async () => {
    const hold = vi.fn(() => Promise.reject(refused()));
    await expect(
      openControlPlaneProcessLock({ ...base(), hold, connectBudgetMs: 0 }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(hold).toHaveBeenCalledTimes(1);
  });

  // Another Server owning the control plane is a correct reason to refuse to
  // start. Only a candidate waiting for its activation gate may wait it out.
  it('refuses immediately when a live incumbent holds the lock', async () => {
    const hold = vi.fn(() => Promise.reject(new PostgresAdvisoryLockHeldError()));
    await expect(openControlPlaneProcessLock({ ...base(), hold })).rejects.toBeInstanceOf(
      PostgresAdvisoryLockHeldError,
    );
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('waits an incumbent out while waiting for activation', async () => {
    let calls = 0;
    const hold = vi.fn(() => {
      calls += 1;
      return calls < 3
        ? Promise.reject(new PostgresAdvisoryLockHeldError())
        : Promise.resolve(lock as PostgresAdvisoryLock);
    });
    await expect(
      openControlPlaneProcessLock({ ...base(), hold, waitForActivation: true }),
    ).resolves.toBe(lock);
    expect(hold).toHaveBeenCalledTimes(3);
  });

  // The budget times SILENCE FROM THE DATABASE, not time spent waiting for a
  // predecessor to hand over. A candidate can sit on the activation gate for
  // minutes; charging that to the same budget would make the first blip after a
  // long hand-over fatal instead of survivable — and only on the slow
  // hand-overs, where the window matters most.
  it('does not spend the connect budget waiting out an incumbent', async () => {
    // The clock only moves when something waits, so elapsed time is exactly the
    // time this function chose to spend.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let calls = 0;
    const hold = vi.fn(() => {
      calls += 1;
      // A long hand-over, then one database blip, then success.
      if (calls <= 5) return Promise.reject(new PostgresAdvisoryLockHeldError());
      if (calls === 6) return Promise.reject(refused());
      return Promise.resolve(lock as PostgresAdvisoryLock);
    });
    let waits = 0;

    await expect(
      openControlPlaneProcessLock({
        ...base(),
        hold,
        waitForActivation: true,
        connectBudgetMs: 1_000,
        // Each wait burns more than the entire connect budget, so a deadline
        // armed at entry would be long gone by the time the incumbent releases.
        sleep: () => {
          now += 5_000;
          waits += 1;
          return waits > 20
            ? Promise.reject(new Error('runaway retry loop: the wait was never going to end'))
            : Promise.resolve();
        },
      }),
    ).resolves.toBe(lock);
    expect(hold).toHaveBeenCalledTimes(7);
  });

  // Waiting out a wrong password or a missing relation would turn a permanent
  // misconfiguration into a two-minute silent hang at every start.
  it('does not wait out an error that is not connection-class', async () => {
    const hold = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('bad password'), {
          code: '28P01',
        }),
      ),
    );
    await expect(openControlPlaneProcessLock({ ...base(), hold })).rejects.toThrow('bad password');
    expect(hold).toHaveBeenCalledTimes(1);
  });

  /**
   * The one property in this function that only the REAL timer has, and the one
   * every other test here is blind to.
   *
   * Every case above injects `sleep`, which is what makes them fast and
   * deterministic — and which also means the production default never runs. That
   * default matters: this wait happens at startup, before the HTTP listener
   * exists and while the failed client holds no socket, so nothing else is
   * keeping the event loop alive. An unref'ed timer there lets Node drain the
   * loop and exit 0 in the middle of the wait, and the Server dies on a database
   * that was merely restarting — the exact failure this function exists to
   * prevent, reintroduced silently, because an injected sleep cannot see it.
   *
   * So this case injects nothing. It runs the real `setTimeout`, awaits it for
   * real, and asserts the handle production created is still referenced. The
   * keeper's own wait is deliberately the opposite (`db.ts`, unref'ed, because a
   * running Server is already held open by its listener); its mirror of this
   * test is in `packages/store/src/db-postgres.test.ts`.
   */
  it('waits on a REFERENCED timer, so node cannot exit 0 mid-wait', async () => {
    const timers = recordTimerRefs();
    let calls = 0;
    const hold = vi.fn(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(refused()) : Promise.resolve(lock as PostgresAdvisoryLock);
    });

    await expect(
      openControlPlaneProcessLock({
        connectionString: base().connectionString,
        onLost: base().onLost,
        waitForActivation: false,
        hold,
        // NO `sleep` — the production default is the subject of this test.
        connectIntervalMs: 7,
      }),
    ).resolves.toBe(lock);

    await Promise.resolve();
    const waits = timers.filter((timer) => timer.ms === 7);
    expect(waits).toHaveLength(2);
    expect(waits.every((timer) => timer.referenced)).toBe(true);
  });

  it('waits out an incumbent on a referenced timer too', async () => {
    const timers = recordTimerRefs();
    let calls = 0;
    const hold = vi.fn(() => {
      calls += 1;
      return calls < 2
        ? Promise.reject(new PostgresAdvisoryLockHeldError())
        : Promise.resolve(lock as PostgresAdvisoryLock);
    });

    await expect(
      openControlPlaneProcessLock({
        connectionString: base().connectionString,
        onLost: base().onLost,
        waitForActivation: true,
        hold,
        activationIntervalMs: 9,
      }),
    ).resolves.toBe(lock);

    await Promise.resolve();
    const waits = timers.filter((timer) => timer.ms === 9);
    expect(waits).toHaveLength(1);
    expect(waits.every((timer) => timer.referenced)).toBe(true);
  });
});

describe('claiming the control-plane generation', () => {
  let ctx: TestDb;
  let fence: ControlPlaneGenerationFence;
  beforeAll(async () => {
    ctx = await createIsolatedTestDb();
    fence = createControlPlaneGenerationFence(ctx.db);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.db.deleteFrom('control_plane_generation').execute();
  });

  const claim = (holderId: string, operationId: string) =>
    claimControlPlaneGeneration({ fence, holderId, operationId, exclusiveProcessLock: true });

  it('creates the first generation when none exists', async () => {
    await expect(claim('verity', 'bootstrap')).resolves.toEqual({
      generation: 1,
      holderId: 'verity',
      operationId: 'bootstrap',
    });
  });

  it('forward-fences a row left active once exclusive process ownership is proven', async () => {
    const first = await claim('verity', 'bootstrap');
    const recovered = await claim('verity', 'recovery');
    expect(recovered).toEqual({
      generation: first.generation + 1,
      holderId: 'verity',
      operationId: 'recovery',
    });
  });

  it('takes a newer generation once the previous holder released it', async () => {
    const old = await claim('verity-managed-server', 'bootstrap');
    const hold = watchControlPlaneGeneration({ fence, held: old, onLost: () => undefined });
    await expect(hold.release()).resolves.toBe(true);

    const next = await claim('verity-managed-server-g2', 'update-2');
    expect(next).toEqual({
      generation: old.generation + 1,
      holderId: 'verity-managed-server-g2',
      operationId: 'update-2',
    });
    // The superseded holder can no longer assert its own generation.
    await expect(fence.assertActive(old)).rejects.toBeInstanceOf(GenerationFenceLostError);
  });

  it('reports a release that no longer owns anything without failing shutdown', async () => {
    const old = await claim('verity', 'bootstrap');
    const hold = watchControlPlaneGeneration({ fence, held: old, onLost: () => undefined });
    await ctx.db.deleteFrom('control_plane_generation').execute();
    await expect(hold.release()).resolves.toBe(false);
  });
});

describe('watching a held control-plane generation', () => {
  const held = { generation: 4, holderId: 'verity', operationId: 'update-4' } as const;

  /** Only `assertActive` and `quiesce` are reachable from a watcher. */
  function stubFence(assertActive: () => Promise<void>): ControlPlaneGenerationFence {
    return {
      assertActive,
      quiesce: () => Promise.resolve(true),
    } as unknown as ControlPlaneGenerationFence;
  }

  it('stops the Server when the generation is provably held elsewhere', async () => {
    const onLost = vi.fn();
    const hold = watchControlPlaneGeneration({
      fence: stubFence(() => Promise.reject(new GenerationFenceLostError())),
      held,
      heartbeatMs: 1,
      onLost,
    });
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1));
    // One verdict, one reaction: the watcher stops after reporting, so a
    // shutdown already under way is not re-entered on every later beat.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onLost).toHaveBeenCalledTimes(1);
    hold.stop();
  });

  it('does not surrender the fence when the database is merely unreachable', async () => {
    // A heartbeat that could not reach PostgreSQL proves nothing about who holds
    // the generation. Treating it as a loss would turn a blip into an outage.
    const onLost = vi.fn();
    const onError = vi.fn();
    const hold = watchControlPlaneGeneration({
      fence: stubFence(() => Promise.reject(new Error('ECONNREFUSED'))),
      held,
      heartbeatMs: 1,
      onLost,
      onError,
    });
    await vi.waitFor(() => expect(onError.mock.calls.length).toBeGreaterThan(1));
    expect(onLost).not.toHaveBeenCalled();
    hold.stop();
  });

  it('does not quiesce a generation it already lost', async () => {
    // Quiescing here would be a write against a row a successor now owns.
    const quiesce = vi.fn(() => Promise.resolve(true));
    const fence = {
      assertActive: () => Promise.reject(new GenerationFenceLostError()),
      quiesce,
    } as unknown as ControlPlaneGenerationFence;
    const onLost = vi.fn();
    const hold = watchControlPlaneGeneration({ fence, held, heartbeatMs: 1, onLost });
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1));
    await expect(hold.release()).resolves.toBe(false);
    expect(quiesce).not.toHaveBeenCalled();
  });

  it('waits for an in-flight heartbeat before releasing without reporting loss', async () => {
    let finishAssertion!: () => void;
    const assertion = new Promise<void>((resolve) => {
      finishAssertion = resolve;
    });
    const quiesce = vi.fn(() => Promise.resolve(true));
    const onLost = vi.fn();
    const fence = {
      assertActive: () => assertion,
      quiesce,
    } as unknown as ControlPlaneGenerationFence;
    const hold = watchControlPlaneGeneration({ fence, held, heartbeatMs: 1, onLost });

    const released = hold.release();
    expect(quiesce).not.toHaveBeenCalled();
    finishAssertion();
    await expect(released).resolves.toBe(true);
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });
});
