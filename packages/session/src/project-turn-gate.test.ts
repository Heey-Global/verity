import { describe, expect, it } from 'vitest';
import { ProjectTurnGate } from './project-turn-gate.js';

describe('ProjectTurnGate', () => {
  it('admits up to the limit per key and hands freed slots out in FIFO order', async () => {
    const gate = new ProjectTurnGate(2);
    const a = await gate.acquire('p');
    const b = await gate.acquire('p');
    const order: string[] = [];
    const c = gate.acquire('p').then((release) => {
      order.push('c');
      return release;
    });
    const d = gate.acquire('p').then((release) => {
      order.push('d');
      return release;
    });
    // Another project's sandbox has its own budget.
    expect(await gate.acquire('other')).toBeTypeOf('function');
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(gate.runningCount('p')).toBe(2);

    a?.();
    a?.(); // idempotent: a double release must not free a second slot
    await c;
    expect(order).toEqual(['c']);
    expect(gate.runningCount('p')).toBe(2);
    b?.();
    await d;
    expect(order).toEqual(['c', 'd']);
  });

  it('drops an aborted waiter without consuming a slot', async () => {
    const gate = new ProjectTurnGate(1);
    const held = await gate.acquire('p');
    const controller = new AbortController();
    const aborted = gate.acquire('p', controller.signal);
    const next = gate.acquire('p');
    controller.abort();
    expect(await aborted).toBeUndefined();
    held?.();
    // The slot goes to the waiter behind the aborted one, not to nobody.
    expect(await next).toBeTypeOf('function');
    expect(gate.runningCount('p')).toBe(1);
  });

  it('is a no-op when disabled', async () => {
    const gate = new ProjectTurnGate(0);
    await Promise.all([gate.acquire('p'), gate.acquire('p'), gate.acquire('p')]);
    expect(gate.wouldWait('p')).toBe(false);
  });
});
