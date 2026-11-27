import { describe, expect, it, vi } from 'vitest';
import type { AttentionSignal } from '../attention.js';
import type { ServerContext } from '../server-context.js';
import { installServerAttentionEvents, SERVER_ATTENTION_CHECK_MS } from './attention-events.js';
import { DomainEventBus, type DomainRecord } from './domain-events.js';

const sealed: AttentionSignal = { code: 'secret_sealed', message: 'The server is sealed.' };

function setup(initial: AttentionSignal[] = []) {
  const domainEvents = new DomainEventBus();
  const closers: Array<() => void> = [];
  let current = initial;
  const collect = vi.fn(async () => current);
  let tick: (() => void) | undefined;
  installServerAttentionEvents(
    { log: { warn: () => undefined } },
    {
      domainEvents,
      lifecycle: { onClose: (fn: () => void) => closers.push(fn) },
    } as unknown as Pick<ServerContext, 'domainEvents' | 'lifecycle'>,
    collect,
    {
      setInterval: (run, ms) => {
        expect(ms).toBe(SERVER_ATTENTION_CHECK_MS);
        tick = run;
        return 'timer';
      },
      clearInterval: () => (tick = undefined),
    },
  );
  const published: DomainRecord[] = [];
  return {
    published,
    collect,
    set: (next: AttentionSignal[]) => (current = next),
    watch: () => domainEvents.subscribe('server:attention', undefined, (r) => published.push(r)),
    check: async () => {
      tick?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    close: () => closers.forEach((fn) => fn()),
  };
}

describe('server.attention', () => {
  // Every device used to probe these on its own list read every two seconds;
  // the server must not take that cost on while nobody looks.
  it('checks nothing while nobody watches', async () => {
    const w = setup([sealed]);
    await w.check();
    await w.check();
    expect(w.collect).not.toHaveBeenCalled();
    expect(w.published).toEqual([]);
    w.close();
  });

  it('publishes the whole list when it changes, and not otherwise', async () => {
    const w = setup();
    const { unsubscribe } = w.watch();
    await w.check();
    expect(w.published.map((r) => r.event)).toEqual([
      { t: 'server.attention', rev: expect.any(Number), attention: [] },
    ]);
    await w.check();
    expect(w.published).toHaveLength(1);
    w.set([sealed]);
    await w.check();
    expect(w.published.map((r) => r.event)).toMatchObject([
      { attention: [] },
      { attention: [sealed] },
    ]);
    const [first, second] = w.published.map((r) => (r.event as { rev: number }).rev);
    expect(second!).toBeGreaterThan(first!);
    // Nobody watches: the last list is no longer anyone's, so the next watcher
    // hears the current one again even though it did not change.
    unsubscribe();
    await w.check();
    w.watch();
    await w.check();
    expect(w.published).toHaveLength(3);
    w.close();
  });

  it('stops checking once the server closes', async () => {
    const w = setup();
    w.watch();
    w.close();
    await w.check();
    expect(w.collect).not.toHaveBeenCalled();
  });
});
