import type { SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../server-context.js';
import { installBranchEvents, OPEN_SESSION_BRANCH_CHECK_MS } from './branch-events.js';
import { DomainEventBus } from './domain-events.js';

const record = (sessionId: string, projectId: string | null = 'p1') =>
  ({ sessionId, projectId, worktree: `/wt/${sessionId}` }) as SessionRecord;

function setup(sessions: SessionRecord[] = [record('s1'), record('s2')]) {
  const domainEvents = new DomainEventBus();
  const closers: Array<() => void> = [];
  const warn = vi.fn();
  let tick: (() => void) | undefined;
  const refresh = vi.fn<(session: SessionRecord) => Promise<undefined>>(async () => undefined);
  const announce = vi.fn();
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const changed = installBranchEvents(
    { log: { warn } },
    {
      domainEvents,
      lifecycle: { onClose: (fn: () => void) => closers.push(fn) },
      deps: {
        eventStore: {
          getSession: async (id: string) => byId.get(id),
          getSessionByWorktree: async (worktree: string) =>
            sessions.find((s) => s.worktree === worktree),
        },
      },
    } as unknown as Pick<ServerContext, 'deps' | 'domainEvents' | 'lifecycle'>,
    refresh,
    announce,
    {
      setInterval: (run, ms) => {
        expect(ms).toBe(OPEN_SESSION_BRANCH_CHECK_MS);
        tick = run;
        return 'timer';
      },
      clearInterval: () => (tick = undefined),
    },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    domainEvents,
    refresh,
    announce,
    warn,
    changed: async (worktree: string) => {
      changed(worktree);
      await settle();
    },
    watch: (topic: string) => domainEvents.subscribe(topic, undefined, () => undefined),
    check: async () => {
      tick?.();
      await settle();
    },
    close: () => closers.forEach((fn) => fn()),
  };
}

describe('open session branch checks', () => {
  // Git run in the terminal raises nothing; only these reads see it. Reading
  // every retained worktree instead would cost a sandbox exec per session.
  it('reads the branch of sessions someone has open, and of no other', async () => {
    const b = setup();
    await b.check();
    expect(b.refresh).not.toHaveBeenCalled();
    const { unsubscribe } = b.watch('session:s1');
    b.watch('project:p1');
    await b.check();
    expect(b.refresh.mock.calls.map(([s]) => s.sessionId)).toEqual(['s1']);
    unsubscribe();
    await b.check();
    expect(b.refresh).toHaveBeenCalledTimes(1);
    b.close();
  });

  it('does not ask a slow sandbox again while its read runs', async () => {
    const b = setup();
    let finish: () => void = () => undefined;
    b.refresh.mockImplementationOnce(
      () => new Promise<undefined>((r) => (finish = () => r(undefined))),
    );
    b.watch('session:s1');
    await b.check();
    await b.check();
    expect(b.refresh).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await b.check();
    expect(b.refresh).toHaveBeenCalledTimes(2);
    b.close();
  });

  it('stops checking when the server closes', async () => {
    const b = setup();
    b.watch('session:s1');
    b.close();
    await b.check();
    expect(b.refresh).not.toHaveBeenCalled();
  });
});

describe('branch change announcements', () => {
  it('schedules the row of a session someone follows, through it or its project', async () => {
    const b = setup([record('s1'), record('s2', 'p2'), record('s3', null)]);
    await b.changed('/wt/s1');
    expect(b.announce).not.toHaveBeenCalled();

    b.watch('project:p1');
    await b.changed('/wt/s1');
    expect(b.announce).toHaveBeenLastCalledWith('s1');

    b.watch('session:s3');
    await b.changed('/wt/s3');
    expect(b.announce).toHaveBeenLastCalledWith('s3');

    await b.changed('/wt/s2');
    await b.changed('/wt/unknown');
    expect(b.announce).toHaveBeenCalledTimes(2);
    b.close();
  });
});
