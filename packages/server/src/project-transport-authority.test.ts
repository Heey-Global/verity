import { afterEach, expect, it, vi } from 'vitest';
import {
  assertProjectTransportAuthority,
  projectTransportFetch,
  withProjectTransportAuthority,
} from './project-transport-authority.js';

afterEach(() => vi.useRealTimers());

it('rejects delayed provider requests after the exact generation is retired', async () => {
  const generation = new AbortController();
  const fetcher = vi.fn(async () => 'payload');
  await expect(
    withProjectTransportAuthority(
      {
        projectId: 'project-a',
        containerGeneration: 'old',
        signal: generation.signal,
        authorize: async () => {},
      },
      async () => {
        generation.abort();
        return projectTransportFetch(fetcher, 'https://example.test', {});
      },
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps concurrent project scopes isolated and propagates retirement to the provider signal', async () => {
  const a = new AbortController();
  const b = new AbortController();
  let first!: AbortSignal;
  let second!: AbortSignal;
  await Promise.all(
    [a, b].map((generation, index) =>
      withProjectTransportAuthority(
        {
          projectId: String(index),
          containerGeneration: 'generation',
          signal: generation.signal,
          authorize: async () => {},
        },
        async () => {
          await projectTransportFetch(
            async (_url: string, init?: { signal?: AbortSignal }) => {
              if (index === 0) first = init!.signal!;
              else second = init!.signal!;
            },
            'https://example.test',
            {},
          );
          if (index === 1) {
            a.abort();
            expect(first.aborted).toBe(true);
            expect(second.aborted).toBe(false);
          }
        },
      ).catch((error: unknown) => {
        if (index !== 0) throw error;
      }),
    ),
  );
});

it('rechecks sponsor/turn authority before every provider call and stops after revocation', async () => {
  let allowed = true;
  const fetcher = vi.fn(async () => 'payload');
  await expect(
    withProjectTransportAuthority(
      {
        projectId: 'a',
        containerGeneration: 'g',
        signal: new AbortController().signal,
        authorize: async () => {
          if (!allowed) throw new Error('revoked');
        },
      },
      async () => {
        await projectTransportFetch(fetcher, 'https://example.test/first', {});
        allowed = false;
        await projectTransportFetch(fetcher, 'https://example.test/second', {});
      },
    ),
  ).rejects.toThrow('revoked');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('aborts a live provider signal when a sponsor check hangs and cannot revive it', async () => {
  vi.useFakeTimers();
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = withProjectTransportAuthority(
    {
      projectId: 'a',
      containerGeneration: 'g',
      signal: new AbortController().signal,
      authorize: async () => {
        if (++calls >= 3) await pending;
      },
    },
    async () => {
      await projectTransportFetch(
        async (_url: string, init?: { signal?: AbortSignal }) => {
          await vi.advanceTimersByTimeAsync(1500);
          expect(init!.signal!.aborted).toBe(true);
          release();
          await Promise.resolve();
          expect(init!.signal!.aborted).toBe(true);
        },
        'https://example.test',
        {},
      );
    },
  );
  await expect(run).rejects.toThrow();
});

it('leaves unrelated control-plane operations outside project authority', async () => {
  await expect(assertProjectTransportAuthority()).resolves.toBeUndefined();
});

it.each(['retire', 'timeout'])(
  'settles a stalled initial check on %s without starting work',
  async (cause) => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const execute = vi.fn(async () => 'unexpected');
    const run = withProjectTransportAuthority(
      {
        projectId: 'a',
        containerGeneration: 'g',
        signal: generation.signal,
        authorize: () => new Promise<void>(() => {}),
      },
      execute,
    );
    const assertion = expect(run).rejects.toThrow();
    if (cause === 'retire') generation.abort();
    else await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(execute).not.toHaveBeenCalled();
  },
);
