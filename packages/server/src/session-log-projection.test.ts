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
    expect(cache.heldPermissionRequests).toBeLessThanOrEqual(512);
    expect(cache.get('s0', stats)).toBeUndefined();
    expect(cache.get('s8', stats)).toBeDefined();

    cache.set('s8', facts('1'), withPermissions(0));
    expect(cache.heldPermissionRequests).toBe(64 * 7);
  });

  it('does not keep a single projection with an outsized permission run', () => {
    const cache = new SessionLogProjectionCache(2_048);
    cache.set('s1', facts('1'), withPermissions(65));
    expect(cache.get('s1', stats)).toBeUndefined();
    expect(cache.heldPermissionRequests).toBe(0);
  });
});
