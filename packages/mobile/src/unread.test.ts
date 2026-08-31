import { describe, expect, it } from 'vitest';
import type { SessionSummary } from './api.js';
import {
  advanceOverride,
  effectiveSeen,
  isUnread,
  reconcileOverrides,
  unreadSessionIds,
} from './unread.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

/** A session summary with an optional live `eventCount` and server-persisted
 * `lastSeenEventCount` mark (null = never opened on any device). */
function session(
  id: string,
  eventCount?: number,
  lastSeenEventCount?: number | null,
): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: null,
    status: 'idle',
    usage: ZERO_USAGE,
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(lastSeenEventCount !== undefined ? { lastSeenEventCount } : {}),
  };
}

const NO_OVERRIDES = new Map<string, number>();

describe('isUnread', () => {
  it('is false for a session that was never opened (no server mark, no override)', () => {
    expect(isUnread(session('a', 12, null), NO_OVERRIDES)).toBe(false);
  });

  it('is true once the event count grows past the server mark', () => {
    expect(isUnread(session('a', 12, 8), NO_OVERRIDES)).toBe(true);
  });

  it('is false when nothing new happened since the server mark', () => {
    expect(isUnread(session('a', 8, 8), NO_OVERRIDES)).toBe(false);
  });

  it('is false when the server omits the event count', () => {
    expect(isUnread(session('a', undefined, 8), NO_OVERRIDES)).toBe(false);
  });

  it('lets an optimistic override clear the dot before the server confirms', () => {
    // Server still marks seen at 8, but the operator just opened it at 12 here.
    expect(isUnread(session('a', 12, 8), new Map([['a', 12]]))).toBe(false);
  });

  it('an override wins even when the server has no mark yet', () => {
    expect(isUnread(session('a', 12, null), new Map([['a', 12]]))).toBe(false);
  });
});

describe('effectiveSeen', () => {
  it('prefers a pending override over the server mark', () => {
    expect(effectiveSeen(session('a', 12, 8), new Map([['a', 12]]))).toBe(12);
  });

  it('falls back to the server mark with no override', () => {
    expect(effectiveSeen(session('a', 12, 8), NO_OVERRIDES)).toBe(8);
  });

  it('is undefined when neither exists', () => {
    expect(effectiveSeen(session('a', 12, null), NO_OVERRIDES)).toBeUndefined();
  });
});

describe('unreadSessionIds', () => {
  it('collects only the sessions with new activity since last open', () => {
    const sessions = [
      session('opened-new', 20, 10), // seen at 10 → unread
      session('opened-same', 5, 5), // seen at 5 → read
      session('never-opened', 99, null), // no mark → not unread
    ];
    expect([...unreadSessionIds(sessions, NO_OVERRIDES)]).toEqual(['opened-new']);
  });
});

describe('advanceOverride', () => {
  it('records the seen count for a session', () => {
    expect(advanceOverride(NO_OVERRIDES, 'a', 12).get('a')).toBe(12);
  });

  it('never moves an override backward (a stale open must not undo a fresher mark)', () => {
    const before = new Map([['a', 12]]);
    expect(advanceOverride(before, 'a', 8)).toBe(before);
  });

  it('advances the override forward', () => {
    expect(advanceOverride(new Map([['a', 8]]), 'a', 12).get('a')).toBe(12);
  });

  it('is a no-op when the count is unknown', () => {
    const before = new Map([['a', 8]]);
    expect(advanceOverride(before, 'a', undefined)).toBe(before);
  });
});

describe('reconcileOverrides', () => {
  it('drops an override once the server mark reaches it', () => {
    const overrides = new Map([['a', 12]]);
    const next = reconcileOverrides(overrides, [session('a', 20, 12)]);
    expect(next.has('a')).toBe(false);
  });

  it('keeps an override the server has not confirmed yet', () => {
    const overrides = new Map([['a', 12]]);
    const next = reconcileOverrides(overrides, [session('a', 20, 8)]);
    expect(next.get('a')).toBe(12);
  });

  it('drops overrides for sessions no longer in the list', () => {
    const overrides = new Map([['gone', 5]]);
    expect(reconcileOverrides(overrides, []).has('gone')).toBe(false);
  });

  it('returns the same reference when nothing reconciles', () => {
    const overrides = new Map([['a', 12]]);
    expect(reconcileOverrides(overrides, [session('a', 20, 8)])).toBe(overrides);
  });
});
