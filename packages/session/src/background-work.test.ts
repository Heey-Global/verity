import { describe, expect, it } from 'vitest';
import { BackgroundWork } from './background-work.js';

describe('BackgroundWork', () => {
  // A wake that lands between one wait resolving and the next being registered —
  // the agent exiting right after its last update — must still end the hold.
  // Lost, it left a crashed agent's turn held until the two-hour limit.
  it('keeps a wake that arrives while no wait is registered', async () => {
    const work = new BackgroundWork();
    work.signal({ type: 'task', id: 'review', phase: 'started' });
    work.wake();
    expect(await work.waitUntilQuiet(10, Date.now() + 60_000)).toBe('woken');
  });

  it('settles once nothing is live and the quiet window has passed', async () => {
    const work = new BackgroundWork();
    work.signal({ type: 'task', id: 'review', phase: 'started' });
    const waiting = work.waitUntilQuiet(10, Date.now() + 60_000);
    work.signal({ type: 'task', id: 'review', phase: 'ended' });
    expect(await waiting).toBe('quiet');
  });

  it('counts a self-started cycle and a level as live work', () => {
    const work = new BackgroundWork();
    work.signal({ type: 'cycle', phase: 'started' });
    expect(work.busy).toBe(true);
    work.signal({ type: 'cycle', phase: 'ended' });
    work.signal({ type: 'background', live: ['monitor'] });
    expect(work.busy).toBe(true);
    work.signal({ type: 'background', live: [] });
    expect(work.busy).toBe(false);
  });
});
