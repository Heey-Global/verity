import { describe, expect, it } from 'vitest';
import { BackgroundWork } from './background-work.js';

describe('BackgroundWork', () => {
  // A wake that lands between one wait resolving and the next being registered —
  // the agent exiting right after its last update — must still end the hold.
  // Lost, it left a crashed agent's turn held until the two-hour limit.
  it('keeps a wake that arrives while no wait is registered', async () => {
    const work = new BackgroundWork();
    work.signal({ type: 'background', live: ['review'] });
    work.wake();
    expect(await work.waitUntilQuiet(10, Date.now() + 60_000)).toBe('woken');
  });

  it('settles once nothing is live and the quiet window has passed', async () => {
    const work = new BackgroundWork();
    work.signal({ type: 'background', live: ['review'] });
    const waiting = work.waitUntilQuiet(10, Date.now() + 60_000);
    work.signal({ type: 'task', id: 'review', phase: 'ended' });
    expect(await waiting).toBe('quiet');
  });

  // An `ended` edge can be lost; with no level to correct it, an edge-only hold
  // would sit out the whole limit. Without levels a turn ends as it always did.
  it('does not hold on task edges until the runtime has sent a level', () => {
    const work = new BackgroundWork();
    work.signal({ type: 'task', id: 'lost-end', phase: 'started' });
    expect(work.busy).toBe(false);
    work.signal({ type: 'background', live: [] });
    work.signal({ type: 'task', id: 'later', phase: 'started' });
    expect(work.busy).toBe(true);
    work.signal({ type: 'task', id: 'later', phase: 'ended' });
    expect(work.busy).toBe(false);
  });

  // Bare edges must not cost a turn without levels the extra quiet window either.
  it('reports observed work only from levels, cycles and confirmed edges', () => {
    const edgesOnly = new BackgroundWork();
    edgesOnly.signal({ type: 'task', id: 'subagent', phase: 'started' });
    edgesOnly.signal({ type: 'task', id: 'subagent', phase: 'ended' });
    expect(edgesOnly.observedWork).toBe(false);
    const withLevel = new BackgroundWork();
    withLevel.signal({ type: 'background', live: [] });
    expect(withLevel.observedWork).toBe(true);
    const withCycle = new BackgroundWork();
    withCycle.signal({ type: 'cycle', phase: 'ended' });
    expect(withCycle.observedWork).toBe(true);
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
