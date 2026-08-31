import { describe, expect, it } from 'vitest';
import { parsePushPayload, parseServerUpdatePush } from './payload.js';

describe('parsePushPayload', () => {
  it('accepts the permission payload the server sends', () => {
    expect(parsePushPayload({ sessionId: 's1', kind: 'permission', toolUseId: 't1' })).toEqual({
      sessionId: 's1',
      kind: 'permission',
      toolUseId: 't1',
    });
  });

  it('accepts the informational status payloads (no toolUseId)', () => {
    expect(parsePushPayload({ sessionId: 's1', kind: 'completed' })).toEqual({
      sessionId: 's1',
      kind: 'completed',
    });
    expect(parsePushPayload({ sessionId: 's1', kind: 'crashed' })?.kind).toBe('crashed');
  });

  it('rejects a permission payload missing its toolUseId', () => {
    // Without a toolUseId the app cannot address the resolve endpoint, so this must
    // fail rather than route a reply nowhere.
    expect(parsePushPayload({ sessionId: 's1', kind: 'permission' })).toBeNull();
  });

  it('accepts a PR-ready payload only with a positive PR number', () => {
    expect(
      parsePushPayload({
        sessionId: 's1',
        kind: 'pull_request_ready',
        pullRequestNumber: 831,
        deviceId: 'device-1',
      }),
    ).toEqual({
      sessionId: 's1',
      kind: 'pull_request_ready',
      pullRequestNumber: 831,
      deviceId: 'device-1',
    });
    expect(parsePushPayload({ sessionId: 's1', kind: 'pull_request_ready' })).toBeNull();
    expect(
      parsePushPayload({
        sessionId: 's1',
        kind: 'pull_request_ready',
        pullRequestNumber: 831,
      }),
    ).toBeNull();
    expect(
      parsePushPayload({ sessionId: 's1', kind: 'pull_request_ready', pullRequestNumber: 0 }),
    ).toBeNull();
  });

  it('returns null (never throws) for malformed input', () => {
    expect(parsePushPayload(undefined)).toBeNull();
    expect(parsePushPayload(null)).toBeNull();
    expect(parsePushPayload('nope')).toBeNull();
    expect(parsePushPayload({ sessionId: '', kind: 'completed' })).toBeNull();
    expect(parsePushPayload({ sessionId: 's1', kind: 'bogus' })).toBeNull();
    expect(parsePushPayload({ kind: 'completed' })).toBeNull();
  });
});

describe('parseServerUpdatePush', () => {
  it('keeps the deviceId the sender stamps, so the tap can be bound to a pairing', () => {
    expect(
      parseServerUpdatePush({ kind: 'server-update', version: 'v11.1.0', deviceId: 'device-1' }),
    ).toEqual({ kind: 'server-update', version: 'v11.1.0', deviceId: 'device-1' });
    // The version is informational; the tap destination does not depend on it.
    expect(parseServerUpdatePush({ kind: 'server-update' })).toEqual({ kind: 'server-update' });
  });

  it('stays out of the session-scoped parser in both directions', () => {
    // A session push is not an update announcement...
    expect(parseServerUpdatePush({ sessionId: 's1', kind: 'completed' })).toBeNull();
    expect(parseServerUpdatePush(null)).toBeNull();
    expect(parseServerUpdatePush('nope')).toBeNull();
    // ...and the announcement is still rejected by the session parser, which is
    // what keeps `sessionId` mandatory for everything that can route a reply.
    expect(parsePushPayload({ kind: 'server-update', version: 'v11.1.0' })).toBeNull();
  });
});
