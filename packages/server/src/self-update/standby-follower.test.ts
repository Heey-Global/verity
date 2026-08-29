import { describe, expect, it, vi } from 'vitest';
import type { StandbyDirectiveClient } from './server-update-controller.js';
import type { StandbyDirective, StandbyDirectiveState } from './standby-directive.js';
import type { StandbyLifecycle, StandbyLifecycleState } from './standby-lifecycle.js';
import { createStandbyFollower, startStandbyFollower } from './standby-follower.js';

/** A lifecycle that records the transitions asked of it. */
function fakeLifecycle(
  initial: StandbyLifecycleState = 'serving',
  failures: { quiesce?: Error; resume?: Error } = {},
): StandbyLifecycle & { readonly calls: string[] } {
  let state = initial;
  const calls: string[] = [];
  return {
    calls,
    get state() {
      return state;
    },
    quiesce: async () => {
      calls.push('quiesce');
      if (failures.quiesce) throw failures.quiesce;
      state = 'quiesced';
      await Promise.resolve();
    },
    resume: async () => {
      calls.push('resume');
      if (failures.resume) throw failures.resume;
      state = 'serving';
      await Promise.resolve();
    },
    stop: async () => {
      calls.push('stop');
      state = 'stopped';
      await Promise.resolve();
    },
    keyMaterial: () => 'unlocked',
  };
}

function fakeClient(
  standby: StandbyDirectiveState | null,
): StandbyDirectiveClient & { readonly acknowledged: { operationId: string; state: string }[] } {
  const acknowledged: { operationId: string; state: StandbyDirective }[] = [];
  return {
    acknowledged,
    read: () => Promise.resolve(standby),
    acknowledge: (operationId, state) => {
      acknowledged.push({ operationId, state });
      return Promise.resolve(true);
    },
  };
}

const directive = (
  value: StandbyDirective,
  overrides: Partial<StandbyDirectiveState> = {},
): StandbyDirectiveState => ({
  directive: value,
  operationId: 'generation-2',
  acknowledged: null,
  ...overrides,
});

describe('createStandbyFollower', () => {
  it('gives up the control plane without dying when the directive asks', async () => {
    const lifecycle = fakeLifecycle('serving');
    const client = fakeClient(directive('quiesced'));

    expect(await createStandbyFollower({ client, lifecycle }).step()).toBe('quiesced');

    expect(lifecycle.calls).toEqual(['quiesce']);
    expect(lifecycle.state).toBe('quiesced');
    expect(client.acknowledged).toEqual([{ operationId: 'generation-2', state: 'quiesced' }]);
  });

  it('comes back as a new incarnation when the directive turns back to serving', async () => {
    const lifecycle = fakeLifecycle('quiesced');
    const client = fakeClient(directive('serving'));

    expect(await createStandbyFollower({ client, lifecycle }).step()).toBe('resumed');

    expect(lifecycle.calls).toEqual(['resume']);
    expect(client.acknowledged).toEqual([{ operationId: 'generation-2', state: 'serving' }]);
  });

  /** The cutover waits for a description of this process, not for a change —
   *  a Server that was already where the directive wants it still has to say so
   *  or the wait would run out for no reason. */
  it('acknowledges a directive it already satisfies', async () => {
    const lifecycle = fakeLifecycle('serving');
    const client = fakeClient(directive('serving'));

    expect(await createStandbyFollower({ client, lifecycle }).step()).toBe('unchanged');

    expect(lifecycle.calls).toEqual([]);
    expect(client.acknowledged).toEqual([{ operationId: 'generation-2', state: 'serving' }]);
  });

  it('does nothing at all while no operation is under way', async () => {
    const lifecycle = fakeLifecycle('serving');
    const client = fakeClient(null);

    expect(await createStandbyFollower({ client, lifecycle }).step()).toBe('idle');

    expect(lifecycle.calls).toEqual([]);
    expect(client.acknowledged).toEqual([]);
  });

  /**
   * The directive names the operation promoting a candidate. A Server that finds
   * its own id there is the candidate itself, reading a directive written about
   * the Server it replaced — following it would quiesce the new control plane
   * the instant it started serving.
   */
  it('ignores the directive that promoted this very Server', async () => {
    const lifecycle = fakeLifecycle('serving');
    const client = fakeClient(directive('quiesced'));

    const follower = createStandbyFollower({ client, lifecycle, operationId: 'generation-2' });

    expect(await follower.step()).toBe('idle');
    expect(lifecycle.calls).toEqual([]);
    expect(client.acknowledged).toEqual([]);
  });

  /** Unknown authority may not serve and may not be resumed, and a stopped
   *  process is already gone. Neither is something a directive can argue with. */
  it('leaves a failed or stopped lifecycle alone', async () => {
    for (const state of ['failed', 'stopped'] as const) {
      const lifecycle = fakeLifecycle(state);
      const client = fakeClient(directive('serving'));

      expect(await createStandbyFollower({ client, lifecycle }).step()).toBe('idle');
      expect(lifecycle.calls).toEqual([]);
      expect(client.acknowledged).toEqual([]);
    }
  });

  /**
   * A resume usually fails because the successor still holds the process lock,
   * which is a retry rather than a fault — and the answer has to be the truth
   * about this process, so the cutover's bounded wait can fall back instead of
   * waiting out a standby that is not coming.
   */
  it('reports the state it is actually in when a transition fails', async () => {
    const lifecycle = fakeLifecycle('quiesced', { resume: new Error('lock is held') });
    const client = fakeClient(directive('serving'));
    const onError = vi.fn();

    expect(await createStandbyFollower({ client, lifecycle, onError }).step()).toBe('failed');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.acknowledged).toEqual([{ operationId: 'generation-2', state: 'quiesced' }]);
  });

  /** A stop lands between the read and the transition: nothing may be started or
   *  reported on behalf of a process that is on its way out. */
  it('stops between steps without acting on what it last read', async () => {
    const lifecycle = fakeLifecycle('serving');
    const acknowledged: unknown[] = [];
    const stopping: { stop?: () => void } = {};
    const client: StandbyDirectiveClient = {
      read: () => {
        stopping.stop?.();
        return Promise.resolve(directive('quiesced'));
      },
      acknowledge: (operationId, state) => {
        acknowledged.push({ operationId, state });
        return Promise.resolve(true);
      },
    };
    const follower = createStandbyFollower({ client, lifecycle });
    stopping.stop = () => follower.stop();

    expect(await follower.step()).toBe('idle');
    expect(lifecycle.calls).toEqual([]);
    expect(acknowledged).toEqual([]);
  });
});

describe('startStandbyFollower', () => {
  /**
   * A quiesced Server has closed every listener it had, so this timer is the only
   * thing left holding the event loop open. If it were unreferenced the standby
   * would exit the moment it stopped serving, and there would be nothing alive
   * for a rollback to return to.
   */
  it('keeps the process alive while quiesced and lets go once it serves again', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = fakeLifecycle('serving');
      let state: StandbyDirective = 'quiesced';
      const client: StandbyDirectiveClient = {
        read: () => Promise.resolve(directive(state)),
        acknowledge: () => Promise.resolve(true),
      };
      const refs: boolean[] = [];
      const ref = vi.spyOn(globalThis, 'setTimeout');

      const loop = startStandbyFollower({ client, lifecycle, activeIntervalMs: 10 });
      // Let the first step run to completion, then observe how the timer it
      // scheduled was referenced.
      await vi.advanceTimersByTimeAsync(0);
      const scheduled = () => ref.mock.results.at(-1)?.value as NodeJS.Timeout;
      refs.push(scheduled().hasRef());
      expect(lifecycle.state).toBe('quiesced');

      state = 'serving';
      await vi.advanceTimersByTimeAsync(10);
      refs.push(scheduled().hasRef());
      expect(lifecycle.state).toBe('serving');

      expect(refs).toEqual([true, false]);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /** Transport failures are the ordinary case for a boundary that may restart
   *  under the Server; the loop reports them and keeps polling. */
  it('survives a read that throws and keeps looking', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = fakeLifecycle('serving');
      const read = vi
        .fn<() => Promise<StandbyDirectiveState | null>>()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue(directive('quiesced'));
      const onError = vi.fn();
      const loop = startStandbyFollower({
        client: { read, acknowledge: () => Promise.resolve(true) },
        lifecycle,
        idleIntervalMs: 5,
        activeIntervalMs: 5,
        onError,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5);
      expect(lifecycle.state).toBe('quiesced');
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules nothing more once stopped', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = fakeLifecycle('serving');
      const read = vi.fn<() => Promise<StandbyDirectiveState | null>>().mockResolvedValue(null);
      const loop = startStandbyFollower({
        client: { read, acknowledge: () => Promise.resolve(true) },
        lifecycle,
        idleIntervalMs: 5,
      });

      await vi.advanceTimersByTimeAsync(0);
      loop.stop();
      const seen = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(read).toHaveBeenCalledTimes(seen);
    } finally {
      vi.useRealTimers();
    }
  });
});
