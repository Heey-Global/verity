import { describe, expect, it } from 'vitest';
import {
  schedulingApprovalSummary,
  schedulingCardDecision,
  schedulingCardEdit,
  schedulingCardEmail,
  type SchedulingEditable,
} from './schedulingSummary.js';

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
  sender: 'sam@example.test',
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
        'Email sent from: sam@example.test',
        'Booking closes Fri 6 Nov, 11:41',
      ],
      email: { subject: 'Pick a time', body: 'Hi Anna {link}' },
      scope: expect.stringContaining('remove the remaining holds'),
      // A server that does not report the language cannot take edits.
      editable: null,
    });
  });

  it('refuses to summarize a send whose draft the server did not attach', () => {
    // Without the server's copy, the card must fall back to the raw input rather than
    // presenting the agent's own arguments as the approved request.
    expect(schedulingApprovalSummary({ action: 'send', requestId: 'r', digest: 'd' })).toBeNull();
    expect(schedulingApprovalSummary({ action: 'prepare', scheduling: draft })).toBeNull();
    expect(
      schedulingApprovalSummary({ action: 'send', scheduling: { ...draft, email: undefined } }),
    ).toBeNull();
    expect(
      schedulingApprovalSummary({
        action: 'send',
        scheduling: { ...draft, colleagues: [...draft.colleagues, { name: 'No address' }] },
      }),
    ).toBeNull();
  });

  it('names the consequences of withdrawing a request', () => {
    expect(
      schedulingApprovalSummary({ action: 'revoke', requestId: 'r', scheduling: draft })?.scope,
    ).toContain('Lea (lea@example.test) get the cancellation');
  });

  describe('editing on the send card', () => {
    const defaults = {
      en: { subject: 'Pick a time: {title}', body: 'Hi Anna, {title}\n{link}' },
      de: { subject: 'Terminauswahl: {title}', body: 'Hallo Anna, {title}\n{link}' },
    };
    const editable = (defaultEmail: unknown = defaults): SchedulingEditable =>
      schedulingApprovalSummary({
        action: 'send',
        scheduling: {
          ...draft,
          language: 'en',
          email: {
            to: 'anna@example.test',
            subject: 'Pick a time: Intro call',
            body: 'Hi Anna, Intro call\n{link}',
          },
          defaultEmail,
        },
      })!.editable!;

    it('approves unchanged content without edits', () => {
      const card = editable();
      expect(card.meeting).toBe('30 min · Google Meet');
      expect(schedulingCardDecision(card, schedulingCardEdit(card))).toEqual({});
    });

    it('lets an untouched default email follow the title and language, as the server will', () => {
      const card = editable();
      const edit = { ...schedulingCardEdit(card), title: ' Kickoff ', language: 'de' as const };
      expect(schedulingCardEmail(card, edit)).toEqual({
        subject: 'Terminauswahl: Kickoff',
        body: 'Hallo Anna, Kickoff\n{link}',
      });
      // The email itself is not sent: the server regenerates it from title and language.
      expect(schedulingCardDecision(card, edit)).toEqual({
        updatedInput: { title: 'Kickoff', language: 'de' },
      });
    });

    it('sends the operator’s own email text and refuses one without the link', () => {
      const card = editable(undefined);
      const edit = { ...schedulingCardEdit(card), emailEdited: true, emailBody: 'Hello {link}' };
      expect(schedulingCardEmail(card, edit).body).toBe('Hello {link}');
      expect(schedulingCardDecision(card, edit)).toEqual({
        updatedInput: { emailSubject: 'Pick a time: Intro call', emailBody: 'Hello {link}' },
      });
      expect(schedulingCardDecision(card, { ...edit, emailBody: 'Hello' })).toEqual({
        error: expect.stringContaining('{link}'),
      });
      // A touched email that matches the draft again is still sent as shown, so a new title
      // cannot make the server regenerate it behind the card's back.
      const restored = { ...schedulingCardEdit(editable()), emailEdited: true, title: 'Kickoff' };
      expect(schedulingCardDecision(editable(), restored)).toEqual({
        updatedInput: {
          title: 'Kickoff',
          emailSubject: 'Pick a time: Intro call',
          emailBody: 'Hi Anna, Intro call\n{link}',
        },
      });
      expect(schedulingCardDecision(card, { ...edit, title: '  ' })).toEqual({
        error: expect.stringContaining('title'),
      });
    });
  });
});
