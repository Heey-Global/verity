import { describe, expect, it } from 'vitest';
import { schedulingApprovalSummary } from './schedulingSummary.js';

const draft = {
  title: 'Intro call',
  durationMinutes: 30,
  addGoogleMeet: true,
  timeZone: 'Europe/Berlin',
  guest: { email: 'anna@example.test', name: 'Anna' },
  colleagues: [{ email: 'lea@example.test', name: 'Lea' }],
  closesAt: '2026-11-06T10:41:00.000Z',
  windows: [
    {
      start: '2026-11-03T13:00:00.000Z',
      end: '2026-11-03T15:00:00.000Z',
      startTimes: ['a', 'b', 'c', 'd'],
    },
  ],
  email: { to: 'anna@example.test', subject: 'Pick a time', body: 'Hi Anna {link}' },
  sender: 'holger@example.test',
};

describe('scheduling approval summary', () => {
  it('shows the stored draft: windows in its zone, who is held and who picks, and the email', () => {
    expect(
      schedulingApprovalSummary({ action: 'send', requestId: 'r', digest: 'd', scheduling: draft }),
    ).toEqual({
      title: 'Send times to Anna?',
      details: [
        'Intro call · 30 min · Google Meet',
        'Tue 3 Nov · 14:00–16:00 · 4 start times',
        'Times in Europe/Berlin',
        'Holds in your calendar, invited: Lea (lea@example.test) (availability not checked)',
        'Booking link to: Anna (anna@example.test)',
        'Email sent from: holger@example.test',
        'Booking closes Fri 6 Nov, 11:41',
      ],
      email: { subject: 'Pick a time', body: 'Hi Anna {link}' },
      scope: expect.stringContaining('remove the remaining holds'),
    });
  });

  it('refuses to summarize a send whose draft the server did not attach', () => {
    // Without the server's copy, the card must fall back to the raw input rather than
    // presenting the agent's own arguments as the approved request.
    expect(schedulingApprovalSummary({ action: 'send', requestId: 'r', digest: 'd' })).toBeNull();
    expect(schedulingApprovalSummary({ action: 'prepare', scheduling: draft })).toBeNull();
  });

  it('names the consequences of withdrawing a request', () => {
    expect(
      schedulingApprovalSummary({ action: 'revoke', requestId: 'r', scheduling: draft })?.scope,
    ).toContain('Lea (lea@example.test) get the cancellation');
  });
});
