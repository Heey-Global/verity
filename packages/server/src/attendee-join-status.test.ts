import { expect, it } from 'vitest';
import { joinProgress } from './attendee-join-status.js';

const at = (second: number) => `2026-11-13T08:00:${String(second).padStart(2, '0')}Z`;

it.each([
  ['joining', 'joining'],
  ['ready', 'joining'],
  ['waiting_room', 'waiting'],
  ['joined_not_recording', 'joined'],
  ['joined_recording', 'joined'],
] as const)('reads provider state %s as %s', (state, status) => {
  expect(joinProgress({ state }, false).status).toBe(status);
});

it('names the newest failure reason, in event order rather than list order', () => {
  expect(
    joinProgress(
      {
        state: 'fatal_error',
        events: [
          { type: 'could_not_join_meeting', sub_type: 'login_required', created_at: at(9) },
          { type: 'could_not_join_meeting', sub_type: 'meeting_not_found', created_at: at(3) },
        ],
      },
      false,
    ),
  ).toMatchObject({ status: 'failed', reason: 'login_required' });
});

it('reports a fatal error without a reason as a failure all the same', () => {
  expect(joinProgress({ state: 'fatal_error' }, false)).toMatchObject({
    status: 'failed',
    reason: null,
  });
});

// Ending the meeting before Verity got in is the user's choice, not a failure to explain.
it('treats leaving before the bot joined as an ordinary end', () => {
  expect(
    joinProgress(
      {
        state: 'ended',
        events: [
          {
            type: 'could_not_join_meeting',
            sub_type: 'leave_requested_before_bot_joined',
            created_at: at(1),
          },
        ],
      },
      false,
    ).status,
  ).toBe('ended');
});

it('never reports a failure for a meeting the bot had already joined', () => {
  expect(joinProgress({ state: 'fatal_error' }, true).status).toBe('ended');
});

it('drops provider codes that are not plain identifiers', () => {
  expect(
    joinProgress(
      {
        state: 'fatal_error',
        events: [{ type: 'fatal_error', sub_type: 'see https://example.test', created_at: at(1) }],
      },
      false,
    ),
  ).toMatchObject({ status: 'failed', reason: null, eventSubType: null });
});
