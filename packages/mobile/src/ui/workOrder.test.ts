import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../api.js';
import { workOrder } from './workOrder.js';

function session(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: id, status: 'completed', lastActivityAt: 0, ...fields } as SessionSummary;
}

describe('workOrder', () => {
  it('puts what needs you or moves first, then favorites, then the rest', () => {
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
      'old',
      'recent',
    ]);
  });

  // The operator chose this: a starred session must not push a waiting one down.
  it('puts pending and running CI after unread sessions and before favorites', () => {
    const ci = (id: string, pipeline: 'pending' | 'running') =>
      session(id, {
        pr: { phase: 'open', pipeline, mergeable: null },
      });
    expect(
      workOrder([
        session('favorite', { favorite: true }),
        ci('running-ci', 'running'),
        session('unread', { eventCount: 3, lastSeenEventCount: 1 }),
        ci('pending-ci', 'pending'),
        session('active', { status: 'running' }),
        session('quiet'),
      ]).map((s) => s.sessionId),
    ).toEqual(['active', 'unread', 'running-ci', 'pending-ci', 'favorite', 'quiet']);
  });

  it('ranks a favorite that is active with the active sessions, not above them', () => {
    const order = workOrder([
      session('starred-idle', { favorite: true, lastActivityAt: 10 }),
      session('crashed', { status: 'crashed', lastActivityAt: 1 }),
      session('starred-running', { favorite: true, status: 'running', lastActivityAt: 2 }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual(['crashed', 'starred-running', 'starred-idle']);
  });

  it('counts a session opened on this device as read', () => {
    const unread = session('a', { eventCount: 5, lastSeenEventCount: 3, lastActivityAt: 3 });
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

  const merged = (updatedAt?: string) =>
    ({
      pr: { phase: 'merged', pipeline: 'success', mergeable: null },
      ...(updatedAt === undefined
        ? {}
        : {
            pullRequest: {
              number: 1,
              title: 'PR',
              url: 'https://example.test/pr/1',
              phase: 'merged',
              updatedAt,
              pipeline: 'success',
              checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
              mergeable: null,
            },
          }),
    }) as Partial<SessionSummary>;

  // A merged session that recent activity lifted above an idle chat would hide
  // the work still open behind the work that is done.
  it('sinks idle merged sessions below every other idle session', () => {
    const order = workOrder([
      session('merged-recent', { ...merged('2026-11-02T00:00:00Z'), lastActivityAt: 99 }),
      session('chat', { lastActivityAt: 1 }),
      session('open-pr', {
        pr: { phase: 'open', pipeline: 'success', mergeable: true },
        lastActivityAt: 2,
      }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual(['chat', 'open-pr', 'merged-recent']);
  });

  it('appends each newly merged session at the bottom, whatever its activity', () => {
    const order = workOrder([
      session('merged-last', { ...merged('2026-11-03T00:00:00Z'), lastActivityAt: 9 }),
      session('merged-first', { ...merged('2026-11-01T00:00:00Z'), lastActivityAt: 1 }),
      session('merged-second', { ...merged('2026-11-02T00:00:00Z'), lastActivityAt: 5 }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual(['merged-first', 'merged-second', 'merged-last']);
  });

  it('keeps a merged session that still needs attention or is starred in its tier', () => {
    const order = workOrder([
      session('merged-idle', { ...merged('2026-11-01T00:00:00Z'), lastActivityAt: 1 }),
      session('merged-starred', { ...merged(), favorite: true, lastActivityAt: 2 }),
      session('merged-running', { ...merged(), status: 'running', lastActivityAt: 3 }),
      session('merged-unread', {
        ...merged(),
        eventCount: 5,
        lastSeenEventCount: 3,
        lastActivityAt: 4,
      }),
      session('chat', { lastActivityAt: 5 }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual([
      'merged-running',
      'merged-unread',
      'merged-starred',
      'chat',
      'merged-idle',
    ]);
  });

  // Newest-first would push a session that just went quiet, asked or got its
  // answer above the ones that have been waiting longer.
  it('appends a session that just asked, got an answer or went quiet to the bottom of its tier', () => {
    const order = workOrder([
      session('asked-now', { status: 'awaiting_input', lastActivityAt: 9 }),
      session('asked-before', { status: 'awaiting_input', lastActivityAt: 2 }),
      session('answered-now', { eventCount: 5, lastSeenEventCount: 3, lastActivityAt: 8 }),
      session('answered-before', { eventCount: 5, lastSeenEventCount: 3, lastActivityAt: 3 }),
      session('starred-now', { favorite: true, lastActivityAt: 7 }),
      session('starred-before', { favorite: true, lastActivityAt: 4 }),
      session('quiet-now', { lastActivityAt: 6 }),
      session('quiet-before', { lastActivityAt: 5 }),
    ]);
    expect(order.map((s) => s.sessionId)).toEqual([
      'asked-before',
      'asked-now',
      'answered-before',
      'answered-now',
      'starred-before',
      'starred-now',
      'quiet-before',
      'quiet-now',
    ]);
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
