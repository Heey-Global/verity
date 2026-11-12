import { describe, expect, it } from 'vitest';

import { createTurnCredentials, TURN_CAPABILITY_PATTERN } from './turn-credentials.js';

const binding = { projectId: 'p1', sessionId: 's1', turnId: 't1', userId: 'lena' };

describe('turn credentials', () => {
  it('names the turn and its person, only inside its own project', () => {
    const turns = createTurnCredentials();
    const token = turns.issue(binding);
    // The shape the sandbox helpers and the broker accept; anything else is dropped there.
    expect(token).toMatch(TURN_CAPABILITY_PATTERN);
    expect(turns.resolve({ projectId: 'p1', token })).toEqual(binding);
    expect(turns.resolve({ projectId: 'p2', token })).toBeUndefined();
    expect(turns.resolve({ projectId: 'p1', token: `${token.slice(0, 42)}A` })).toBeUndefined();
  });

  it('keeps a turn without an initiator personless', () => {
    const turns = createTurnCredentials();
    const token = turns.issue({ ...binding, userId: null });
    expect(turns.resolve({ projectId: 'p1', token })?.userId).toBeNull();
  });

  it('stops working when the turn settles, expires or its project is revoked', () => {
    let now = 0;
    const turns = createTurnCredentials({ now: () => now, ttlMs: 1_000 });
    const released = turns.issue(binding);
    turns.release(released);
    expect(turns.resolve({ projectId: 'p1', token: released })).toBeUndefined();

    const expiring = turns.issue(binding);
    now = 1_000;
    expect(turns.resolve({ projectId: 'p1', token: expiring })).toBeUndefined();

    const revoked = turns.issue(binding);
    const other = turns.issue({ ...binding, projectId: 'p2' });
    turns.revokeProject('p1');
    expect(turns.resolve({ projectId: 'p1', token: revoked })).toBeUndefined();
    expect(turns.resolve({ projectId: 'p2', token: other })?.projectId).toBe('p2');
  });

  it('refuses to grow without bound', () => {
    const turns = createTurnCredentials({ capacity: 2 });
    turns.issue(binding);
    turns.issue(binding);
    expect(() => turns.issue(binding)).toThrow(/capacity/u);
  });
});
