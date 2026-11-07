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

  it('keeps active sessions in place when activity and server response order change', () => {
    const active = [
      session('a', { status: 'running', lastActivityAt: 1 }),
      session('b', { status: 'awaiting_dependency', lastActivityAt: 2 }),
      session('c', { backgroundWorking: true, lastActivityAt: 3 }),
    ];
    const before = workOrder(active).map((s) => s.sessionId);
    expect(before).toEqual(['a', 'b', 'c']);
    expect(
      workOrder([...active].reverse().map((s) => ({ ...s, lastActivityAt: 100 }))).map(
        (s) => s.sessionId,
      ),
    ).toEqual(before);
    expect(
      workOrder(active.map((s) => ({ ...s, lastActivityAt: s.sessionId === 'c' ? 999 : 0 }))).map(
        (s) => s.sessionId,
      ),
    ).toEqual(before);
  });

  it('respects saved positions within the active group', () => {
    expect(
      workOrder([
        session('a', { status: 'running', sortOrder: 1 }),
        session('b', { status: 'running', sortOrder: 0 }),
        session('c', { status: 'running' }),
      ]).map((s) => s.sessionId),
    ).toEqual(['b', 'a', 'c']);
  });

  it('appends newly running sessions even when their IDs or saved positions sort first', () => {
    const existing = session('z', { status: 'running', sortOrder: 9 });
    const idle = session('a', { sortOrder: 0 });
    const before = workOrder([idle, existing]);
    const next = workOrder(
      [
        { ...idle, status: 'running', lastActivityAt: 999 },
        { ...existing, lastActivityAt: 1000 },
      ],
      new Map(),
      before,
    );
    expect(next.map((s) => s.sessionId)).toEqual(['z', 'a']);
    expect(workOrder([...next].reverse(), new Map(), next).map((s) => s.sessionId)).toEqual([
      'z',
      'a',
    ]);
  });

  it('appends a restarted session after removing its old active position', () => {
    const a = session('a', { status: 'running' });
    const b = session('b', { backgroundWorking: true });
    const before = workOrder([a, b]);
    const completed = workOrder([{ ...a, status: 'completed' }, b], new Map(), before);
    expect(workOrder([a, b], new Map(), completed).map((s) => s.sessionId)).toEqual(['b', 'a']);
    const removed = workOrder([b], new Map(), before);
    expect(workOrder([a, b], new Map(), removed).map((s) => s.sessionId)).toEqual(['b', 'a']);
  });
});
