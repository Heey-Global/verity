import { describe, expect, it, vi } from 'vitest';
import {
  createStandbyLifecycle,
  type ServingStack,
  type StandbyLifecycle,
} from './standby-lifecycle.js';

/** A serving incarnation that records what was asked of it. */
function fakeStack(key?: string): ServingStack & { closed: number; closeModes: string[] } {
  return {
    closed: 0,
    closeModes: [],
    async close(mode) {
      this.closed += 1;
      this.closeModes.push(mode);
    },
    exportKeyMaterial: () => key,
  };
}

/** A lifecycle whose every resume produces a fresh recorded incarnation. */
function harness(first: ServingStack, keys: (string | undefined)[] = []) {
  const started: { adoptedSecretKeyMaterial?: string }[] = [];
  const stacks: (ServingStack & { closed: number })[] = [];
  const start = vi.fn(async (input: { adoptedSecretKeyMaterial?: string }) => {
    started.push(input);
    const stack = fakeStack(keys[stacks.length]);
    stacks.push(stack);
    return await Promise.resolve(stack);
  });
  const lifecycle: StandbyLifecycle = createStandbyLifecycle(first, { start });
  return { lifecycle, start, started, stacks };
}

describe('createStandbyLifecycle', () => {
  it('starts out serving the stack it was handed', () => {
    const { lifecycle } = harness(fakeStack('key'));
    expect(lifecycle.state).toBe('serving');
    expect(lifecycle.keyMaterial()).toBe('key');
  });

  /** The whole point of the standby: the process outlives its serving stack and
   *  keeps the unlocked key, so a rollback returns to something that can work. */
  it('closes the serving stack but keeps the key when quiescing', async () => {
    const stack = fakeStack('unlocked');
    const { lifecycle } = harness(stack);

    await lifecycle.quiesce();

    expect(stack.closed).toBe(1);
    expect(stack.closeModes).toEqual(['handoff']);
    expect(lifecycle.state).toBe('quiesced');
    expect(lifecycle.keyMaterial()).toBe('unlocked');
  });

  /** A cutover step may run twice after an Updater restart. */
  it('quiesces once however often it is asked', async () => {
    const stack = fakeStack();
    const { lifecycle } = harness(stack);

    await lifecycle.quiesce();
    await lifecycle.quiesce();

    expect(stack.closed).toBe(1);
    expect(stack.closeModes).toEqual(['handoff']);
    expect(lifecycle.state).toBe('quiesced');
  });

  /** Resuming is a new incarnation, and the key travels into it the same way a
   *  handed-off key reaches a promoted Server. */
  it('resumes by starting a new stack that adopts the retained key', async () => {
    const { lifecycle, started, stacks } = harness(fakeStack('unlocked'), ['unlocked']);

    await lifecycle.quiesce();
    await lifecycle.resume();

    expect(started).toEqual([{ adoptedSecretKeyMaterial: 'unlocked' }]);
    expect(lifecycle.state).toBe('serving');
    expect(lifecycle.keyMaterial()).toBe('unlocked');
    expect(stacks[0]?.closed).toBe(0);
  });

  /** A Server that was sealed when it quiesced has nothing to adopt, and must
   *  not be handed an explicit `undefined` the option type does not allow. */
  it('resumes a sealed Server without an adopted key', async () => {
    const { lifecycle, started } = harness(fakeStack());

    await lifecycle.quiesce();
    await lifecycle.resume();

    expect(started).toEqual([{}]);
  });

  it('does not start a second stack when it is already serving', async () => {
    const { lifecycle, start } = harness(fakeStack());

    await lifecycle.resume();

    expect(start).not.toHaveBeenCalled();
    expect(lifecycle.state).toBe('serving');
  });

  /** The usual reason a resume fails is the successor still holding the lock.
   *  That is a retry, not a broken Server: nothing was claimed. */
  it('stays quiesced and retryable when a resume fails', async () => {
    const start = vi
      .fn<(input: { adoptedSecretKeyMaterial?: string }) => Promise<ServingStack>>()
      .mockRejectedValueOnce(new Error('control-plane process lock is held'))
      .mockResolvedValueOnce(fakeStack('unlocked'));
    const lifecycle = createStandbyLifecycle(fakeStack('unlocked'), { start });

    await lifecycle.quiesce();
    await expect(lifecycle.resume()).rejects.toThrow('lock is held');
    expect(lifecycle.state).toBe('quiesced');
    expect(lifecycle.keyMaterial()).toBe('unlocked');

    await lifecycle.resume();
    expect(lifecycle.state).toBe('serving');
  });

  /** A teardown that did not finish leaves this process's authority unknown,
   *  which may not be resumed — only exited, so PostgreSQL clears the locks. */
  it('refuses to resume after a teardown failed', async () => {
    const stack: ServingStack = {
      close: () => Promise.reject(new Error('pool did not close')),
      exportKeyMaterial: () => 'unlocked',
    };
    const { lifecycle, start } = harness(stack);

    await expect(lifecycle.quiesce()).rejects.toThrow('pool did not close');
    expect(lifecycle.state).toBe('failed');

    await expect(lifecycle.resume()).rejects.toThrow('a failed Server cannot resume serving');
    expect(start).not.toHaveBeenCalled();
  });

  it('closes the current stack and forgets the key when stopped', async () => {
    const stack = fakeStack('unlocked');
    const { lifecycle } = harness(stack);

    await lifecycle.stop();

    expect(stack.closed).toBe(1);
    expect(stack.closeModes).toEqual(['shutdown']);
    expect(lifecycle.state).toBe('stopped');
    expect(lifecycle.keyMaterial()).toBeUndefined();
    await expect(lifecycle.resume()).rejects.toThrow('a stopped Server cannot resume serving');
  });

  it('stops a quiesced Server without closing anything twice', async () => {
    const stack = fakeStack('unlocked');
    const { lifecycle } = harness(stack);

    await lifecycle.quiesce();
    await lifecycle.stop();

    expect(stack.closed).toBe(1);
    expect(lifecycle.keyMaterial()).toBeUndefined();
  });

  /** A cutover step and a rollback can arrive together; they must not interleave
   *  and leave a stack closed while the lifecycle believes it is serving. */
  it('serializes transitions that overlap', async () => {
    const stack = fakeStack('unlocked');
    const { lifecycle, start, stacks } = harness(stack);

    const quiescing = lifecycle.quiesce();
    const resuming = lifecycle.resume();
    await Promise.all([quiescing, resuming]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(stack.closed).toBe(1);
    expect(lifecycle.state).toBe('serving');
    expect(stacks[0]?.closed).toBe(0);
  });

  /** A failure on one transition must not fail the next caller's. */
  it('keeps serializing after a transition rejected', async () => {
    const start = vi
      .fn<(input: { adoptedSecretKeyMaterial?: string }) => Promise<ServingStack>>()
      .mockRejectedValueOnce(new Error('lock is held'))
      .mockResolvedValue(fakeStack());
    const lifecycle = createStandbyLifecycle(fakeStack(), { start });

    await lifecycle.quiesce();
    const failing = lifecycle.resume();
    const retry = lifecycle.resume();

    await expect(failing).rejects.toThrow('lock is held');
    await expect(retry).resolves.toBeUndefined();
    expect(lifecycle.state).toBe('serving');
  });
});
