import { aggregateUsage } from '@verity/events';
import type { SessionProjectionFacts } from '@verity/store';
import { describe, expect, it } from 'vitest';
import { SessionLogProjectionCache, type SessionLogProjection } from './session-log-projection.js';

const facts = (revision: string): SessionProjectionFacts => ({
  eventCount: 0,
  lastEventSeq: 1,
  revision,
  lastActivityAt: 1,
  lastMessageAt: null,
  events: [],
  eventsTruncated: false,
  rateLimitEvents: [],
  usage: aggregateUsage([]),
});

const withPermissions = (count: number): SessionLogProjection => ({
  status: 'completed',
  awaitsPermission: false,
  openTasks: false,
  choices: undefined,
  requestInitiator: undefined,
  permissionRequests: new Map(
    Array.from({ length: count }, (_, at) => [
      `tool-${String(at)}`,
      { toolUseId: `tool-${String(at)}`, tool: 'Bash', riskClass: 'ask', input: 'x'.repeat(4_000) },
    ]),
  ),
});

const stats = { revision: '1', lastEventSeq: 1, lastActivityAt: 1 };

// Each permission request can carry kilobytes of tool input, and an idle
// session keeps its last turn's. Bounding only the session count would let the
// cache hold hundreds of megabytes on a server with many such sessions.
describe('SessionLogProjectionCache', () => {
  it('bounds the permission requests it holds across sessions', () => {
    const cache = new SessionLogProjectionCache(2_048);
    for (let at = 0; at < 9; at += 1) cache.set(`s${String(at)}`, facts('1'), withPermissions(64));
    expect(cache.heldPermissionRequests).toBe(512);
    expect(cache.get('s8', stats)).toBeUndefined();

    cache.set('s7', facts('1'), withPermissions(0));
    expect(cache.heldPermissionRequests).toBe(64 * 7);
  });

  it('does not keep a single projection with an outsized permission run', () => {
    const cache = new SessionLogProjectionCache(2_048);
    cache.set('s1', facts('1'), withPermissions(65));
    expect(cache.get('s1', stats)).toBeUndefined();
    expect(cache.heldPermissionRequests).toBe(0);
  });

  // The list reads every session in the same order on each poll. Evicting the
  // least recently used entry to admit the next one would evict exactly the one
  // the following poll needs, so a cache one entry too small would never hit.
  it('keeps serving the sessions it holds when more are polled than fit', () => {
    const cache = new SessionLogProjectionCache(3);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids)
      if (cache.get(id, stats) === undefined) cache.set(id, facts('1'), withPermissions(0));
    const hits = ids.filter((id) => cache.get(id, stats) !== undefined);
    expect(hits).toEqual(['a', 'b', 'c']);
  });

  it('gives up entries nobody has read for a while, such as deleted sessions', () => {
    let now = 0;
    const cache = new SessionLogProjectionCache(2, () => now);
    cache.set('gone', facts('1'), withPermissions(0));
    cache.set('kept', facts('1'), withPermissions(0));
    now = 4 * 60_000;
    expect(cache.get('kept', stats)).toBeDefined();
    now = 6 * 60_000;
    cache.set('new', facts('1'), withPermissions(0));
    expect(cache.get('gone', stats)).toBeUndefined();
    expect(cache.get('kept', stats)).toBeDefined();
    expect(cache.get('new', stats)).toBeDefined();
  });
});
