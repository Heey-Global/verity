import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../api.js';
import { workOrder } from './workOrder.js';

function session(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: id, status: 'completed', lastActivityAt: 0, ...fields } as SessionSummary;
}

describe('workOrder', () => {
  it('puts what needs you or moves first, then favorites, then the rest by activity', () => {
    const order = workOrder([
      session('old', { lastActivityAt: 1 }),
      session('starred', { favorite: true, lastActivityAt: 9 }),
      session('new-answer', { eventCount: 5, lastSeenEventCount: 3, lastActivityAt: 2 }),
      session('working', { status: 'running', lastActivityAt: 3 }),
      session('recent', { lastActivityAt: 8 }),
      session('asks', { status: 'awaiting_input', lastActivityAt: 4 }),
      session('background', { backgroundWorking: true, lastActivityAt: 5 }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual([
      'asks',
      'background',
      'working',
      'new-answer',
      'starred',
      'recent',
      'old',
    ]);
  });

  // The operator chose this: a starred session must not push a waiting one down.
  it('ranks a favorite that is active with the active sessions, not above them', () => {
    const order = workOrder([
      session('starred-idle', { favorite: true, lastActivityAt: 10 }),
      session('crashed', { status: 'crashed', lastActivityAt: 1 }),
      session('starred-running', { favorite: true, status: 'running', lastActivityAt: 2 }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual(['crashed', 'starred-running', 'starred-idle']);
  });

  it('counts a session opened on this device as read', () => {
    const unread = session('a', { eventCount: 5, lastSeenEventCount: 3, lastActivityAt: 1 });
    const later = session('b', { lastActivityAt: 2 });
    expect(workOrder([later, unread]).map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(workOrder([later, unread], new Map([['a', 5]])).map((s) => s.sessionId)).toEqual([
      'b',
      'a',
    ]);
  });
});
