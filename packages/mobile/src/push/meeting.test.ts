import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { VerityApiError } from '../api.js';
import { PUSH_ACTION, PUSH_CATEGORY, PUSH_NOTIFICATION_CATEGORIES } from './categories.js';
import { parseMeetingPush, resolveMeetingPushResponse } from './meeting.js';
import { parsePushPayload } from './payload.js';
import { DEFAULT_ACTION_IDENTIFIER, createPushReplyPerformer } from './response.js';

const watcher = readFileSync(
  new URL('../../../server/src/calendar-meeting-watcher.ts', import.meta.url),
  'utf8',
);

describe('meeting push categories', () => {
  // The device looks the buttons up by this id; a rename on the server side alone would
  // deliver the notification without Join / Skip and nothing would fail.
  it.each([
    ['MEETING_UPCOMING_CATEGORY', PUSH_CATEGORY.meetingUpcoming],
    ['MEETING_STARTED_CATEGORY', PUSH_CATEGORY.meetingStarted],
  ])('uses the id the server sends as %s', (constant, id) => {
    const declared = new RegExp(`export const ${constant} = '([A-Z_]+)'`, 'u').exec(watcher);
    expect(declared?.[1]).toBe(id);
  });

  it('asks for an unlock before joining or discarding from the lock screen', () => {
    const action = (category: string, id: string) =>
      PUSH_NOTIFICATION_CATEGORIES.find((spec) => spec.identifier === category)?.actions.find(
        (item) => item.identifier === id,
      );
    expect(
      action(PUSH_CATEGORY.meetingUpcoming, PUSH_ACTION.joinMeeting)?.authenticationRequired,
    ).toBe(true);
    expect(
      action(PUSH_CATEGORY.meetingUpcoming, PUSH_ACTION.skipMeeting)?.authenticationRequired,
    ).toBeUndefined();
    expect(action(PUSH_CATEGORY.meetingStarted, PUSH_ACTION.discardMeeting)).toMatchObject({
      authenticationRequired: true,
      destructive: true,
    });
    expect(action(PUSH_CATEGORY.meetingStarted, PUSH_ACTION.openMeeting)?.opensApp).toBe(true);
  });
});

describe('parseMeetingPush', () => {
  it('reads both kinds the watcher sends', () => {
    expect(
      parseMeetingPush({ kind: 'meeting-upcoming', eventKey: 'k1', startsAt: 1, deviceId: 'd' }),
    ).toEqual({ kind: 'meeting-upcoming', eventKey: 'k1', startsAt: 1, deviceId: 'd' });
    expect(parseMeetingPush({ kind: 'meeting-started', meetingId: 'm1', eventKey: 'k1' })).toEqual({
      kind: 'meeting-started',
      meetingId: 'm1',
      eventKey: 'k1',
    });
  });

  it('rejects anything else, and the session parser rejects meeting pushes', () => {
    expect(parseMeetingPush({ kind: 'meeting-started' })).toBeNull();
    expect(parseMeetingPush({ sessionId: 's1', kind: 'completed' })).toBeNull();
    expect(parsePushPayload({ kind: 'meeting-upcoming', eventKey: 'k1' })).toBeNull();
  });
});

describe('resolveMeetingPushResponse', () => {
  const upcoming = { kind: 'meeting-upcoming', eventKey: 'k1' } as const;
  const started = { kind: 'meeting-started', meetingId: 'm1' } as const;

  it('turns the buttons into outbox replies and a tap into a screen', () => {
    expect(resolveMeetingPushResponse(PUSH_ACTION.joinMeeting, upcoming)).toEqual({
      type: 'reply',
      action: { type: 'join-calendar-meeting', eventKey: 'k1' },
    });
    expect(resolveMeetingPushResponse(PUSH_ACTION.skipMeeting, upcoming)).toEqual({
      type: 'reply',
      action: { type: 'skip-calendar-meeting', eventKey: 'k1' },
    });
    expect(resolveMeetingPushResponse(DEFAULT_ACTION_IDENTIFIER, upcoming)).toEqual({
      type: 'show-upcoming',
      eventKey: 'k1',
    });
    expect(resolveMeetingPushResponse(PUSH_ACTION.discardMeeting, started)).toEqual({
      type: 'reply',
      action: { type: 'discard-live-meeting', meetingId: 'm1' },
    });
    for (const id of [DEFAULT_ACTION_IDENTIFIER, PUSH_ACTION.openMeeting])
      expect(resolveMeetingPushResponse(id, started)).toEqual({
        type: 'show-started',
        meetingId: 'm1',
      });
  });

  // A button of the other category must never act on this meeting.
  it('ignores actions that do not belong to the push', () => {
    expect(resolveMeetingPushResponse(PUSH_ACTION.discardMeeting, upcoming)).toBeNull();
    expect(resolveMeetingPushResponse(PUSH_ACTION.joinMeeting, started)).toBeNull();
    expect(resolveMeetingPushResponse(PUSH_ACTION.allow, upcoming)).toBeNull();
  });
});

describe('meeting replies', () => {
  const client = () => ({
    decidePermission: vi.fn(),
    sendTurn: vi.fn(),
    mergePullRequest: vi.fn(),
    joinCalendarMeeting: vi.fn().mockResolvedValue({ meetingId: 'm1' }),
    skipCalendarMeeting: vi.fn().mockResolvedValue(undefined),
    discardLiveMeeting: vi.fn().mockResolvedValue(undefined),
  });

  it('joins unassigned, skips and discards through the client', async () => {
    const methods = client();
    const perform = createPushReplyPerformer(methods);
    await expect(perform({ type: 'join-calendar-meeting', eventKey: 'k1' }, 'r1')).resolves.toBe(
      'done',
    );
    expect(methods.joinCalendarMeeting).toHaveBeenCalledWith('k1');
    await perform({ type: 'skip-calendar-meeting', eventKey: 'k1' }, 'r2');
    expect(methods.skipCalendarMeeting).toHaveBeenCalledWith('k1');
    await perform({ type: 'discard-live-meeting', meetingId: 'm1' }, 'r3');
    expect(methods.discardLiveMeeting).toHaveBeenCalledWith('m1');
  });

  it('drops a reply the server already settled and keeps one it could not take', async () => {
    const methods = client();
    const perform = createPushReplyPerformer(methods);
    methods.joinCalendarMeeting.mockRejectedValueOnce(new VerityApiError(409, 'already joined'));
    await expect(perform({ type: 'join-calendar-meeting', eventKey: 'k1' }, 'r1')).resolves.toBe(
      'stale',
    );
    methods.joinCalendarMeeting.mockRejectedValueOnce(new VerityApiError(503, 'uplink'));
    await expect(perform({ type: 'join-calendar-meeting', eventKey: 'k1' }, 'r1')).resolves.toBe(
      'retry',
    );
    methods.discardLiveMeeting.mockRejectedValueOnce(new VerityApiError(404, 'assigned'));
    await expect(perform({ type: 'discard-live-meeting', meetingId: 'm1' }, 'r2')).resolves.toBe(
      'stale',
    );
  });
});
