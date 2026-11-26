import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertQuerySandboxAllowed } from './query-sandbox-policy.js';
import { branchSvc, bus, conductor, ctx, worktreeRoot } from './server-fixture.test-helper.js';
import { buildServer } from './server.js';
import { IDLE_KNOWN_LIST_BRANCH_TTL_MS } from './server-support.js';

type Branches = NonNullable<Parameters<typeof buildServer>[0]['branches']>;
type Listed = { sessionId: string; branch?: string };

const servers: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function serve(current: (worktree: string) => Promise<string>) {
  const server = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    spawnWorktreeRoot: worktreeRoot,
    branches: {
      ...branchSvc,
      current,
      switchable: vi.fn(async () => []),
      previewable: vi.fn(async () => []),
    } as unknown as Branches,
  });
  servers.push(server);
  return server;
}

async function session(id: string): Promise<string> {
  const worktree = join(worktreeRoot, id);
  mkdirSync(worktree, { recursive: true });
  await ctx.store.createSession({ sessionId: id, worktree, model: 'm' });
  return worktree;
}

describe('session branch reads', () => {
  // The list refreshes every retained worktree; the branch menu of the session on
  // screen used to queue behind all of them and took up to a minute to answer.
  it('answers the open session without waiting for the list’s background reads', async () => {
    const open = await session('open');
    for (const id of ['a', 'b', 'c']) await session(id);
    const current = vi.fn((worktree: string) =>
      worktree === open ? Promise.resolve('feat/open') : new Promise<string>(() => undefined),
    );
    const server = serve(current);
    await server.inject({ method: 'GET', url: '/sessions' });
    // Both background slots are held by reads that never settle.
    await vi.waitFor(() => expect(current.mock.calls.length).toBeGreaterThanOrEqual(2));

    const res = await server.inject({ method: 'GET', url: '/sessions/open/branches' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ current: 'feat/open' });
  });

  // A sleeping sandbox answers git only through a throwaway container; the list
  // started one per retained worktree and minute.
  it('never lets the list wake a sleeping sandbox, but lets an opened session do so', async () => {
    await session('asleep');
    const current = vi.fn(async () => {
      assertQuerySandboxAllowed();
      return 'feat/asleep';
    });
    const server = serve(current);
    const branchOf = async () =>
      (await server.inject({ method: 'GET', url: '/sessions' }))
        .json<Listed[]>()
        .find((s) => s.sessionId === 'asleep')?.branch;

    await branchOf();
    await vi.waitFor(() => expect(current).toHaveBeenCalledOnce());
    await expect(current.mock.results[0]!.value).rejects.toThrow('asleep');
    expect(await branchOf()).toBeUndefined();

    const res = await server.inject({ method: 'GET', url: '/sessions/asleep/branches' });
    expect(res.json()).toMatchObject({ current: 'feat/asleep' });
    expect(await branchOf()).toBe('feat/asleep');
  });

  // Nothing invalidates a branch switched from a terminal while no turn runs.
  it('re-reads a known idle branch only on its long backstop', async () => {
    await session('idle');
    const current = vi.fn(async () => 'feat/idle');
    const server = serve(current);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const poll = async () => {
        await server.inject({ method: 'GET', url: '/sessions' });
        await new Promise((resolve) => setImmediate(resolve));
      };
      await poll();
      expect(current).toHaveBeenCalledOnce();
      now = IDLE_KNOWN_LIST_BRANCH_TTL_MS - 1;
      await poll();
      expect(current).toHaveBeenCalledOnce();
      now = IDLE_KNOWN_LIST_BRANCH_TTL_MS + 1;
      await poll();
      expect(current).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps active list branches on the short TTL while a known idle one waits', async () => {
    const current = vi.fn(async () => 'feat/one');
    const server = serve(current);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const id of ['idle', 'active']) {
        await session(id);
        await ctx.store.appendEvent(id, {
          t: 'status',
          state: id === 'active' ? 'running' : 'completed',
        });
      }
      const poll = async () => {
        await server.inject({ method: 'GET', url: '/sessions' });
        await new Promise((resolve) => setImmediate(resolve));
      };
      await poll();
      expect(current).toHaveBeenCalledTimes(2);
      current.mockClear();
      now = 10_001;
      await poll();
      expect(current.mock.calls).toEqual([[join(worktreeRoot, 'active')]]);
      current.mockClear();
      now = 120_001;
      await poll();
      expect(current.mock.calls).toEqual([[join(worktreeRoot, 'active')]]);
    } finally {
      clock.mockRestore();
    }
  });
});
