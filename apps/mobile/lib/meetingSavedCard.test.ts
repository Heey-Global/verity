import { meetingSavedCard, latestMeetingCards } from './meetingSavedCard';

it('recognizes legacy notices without inventing metrics', () => {
  expect(
    meetingSavedCard('Meeting saved to the knowledge base: [Sync](/knowledge/meetings/sync.md)'),
  ).toEqual({ title: 'Sync', link: '/knowledge/meetings/sync.md' });
  expect(meetingSavedCard('Read [Sync](/knowledge/meetings/sync.md)')).toBeNull();
});
it('reads native navigation and bounded metrics from the saved notice', () => {
  const text =
    'Meeting saved to the knowledge base: [Sync](/knowledge/meetings/sync.md)\n<!-- verity-meeting: ' +
    JSON.stringify({
      sessionId: 'session',
      meetingId: 'meeting',
      durationMinutes: 42,
      people: 3,
      notes: 2,
      answers: -1,
    }) +
    ' -->';
  expect(meetingSavedCard(text)).toEqual({
    title: 'Sync',
    link: '/knowledge/meetings/sync.md',
    sessionId: 'session',
    meetingId: 'meeting',
    durationMinutes: 42,
    people: 3,
    notes: 2,
    answers: undefined,
  });
});
it('falls back safely when metadata is malformed', () => {
  expect(
    meetingSavedCard(
      'Meeting saved to the knowledge base: [Sync](/knowledge/meetings/sync.md)\n<!-- verity-meeting: invalid -->',
    ),
  ).toEqual({ title: 'Sync', link: '/knowledge/meetings/sync.md' });
});

it('displays escaped title punctuation without changing the saved destination', () => {
  expect(
    meetingSavedCard(
      String.raw`Meeting saved to the knowledge base: [Sync\](https://example.com) \[Q1\] \\ files](/knowledge/meeting.md)`,
    ),
  ).toEqual({
    title: String.raw`Sync](https://example.com) [Q1] \ files`,
    link: '/knowledge/meeting.md',
  });
});

it('retains a derived summary in the saved meeting card', () => {
  const text =
    'Meeting saved to the knowledge base: [Release](/knowledge/meetings/release.md)\n<!-- verity-meeting: ' +
    JSON.stringify({ sessionId: 's', meetingId: 'm', summary: 'The team agreed to ship.' }) +
    ' -->';
  expect(meetingSavedCard(text)?.summary).toBe('The team agreed to ship.');
});

it('keeps the newest version of a filed meeting card and preserves other rows', () => {
  const notice = (summary: string) =>
    'Meeting saved to the knowledge base: [Release](/knowledge/meetings/release.md)\n<!-- verity-meeting: ' +
    JSON.stringify({ sessionId: 's', meetingId: 'm', summary }) +
    ' -->';
  const make = (id: string, text: string) =>
    ({
      kind: 'message',
      message: { id, kind: 'agent-text', text },
    }) as import('@verity/mobile').Row;
  const newer = make('new', notice('Final summary'));
  const answer = make('answer', 'A normal answer');
  const older = make('old', notice(''));
  expect(latestMeetingCards([newer, answer, older])).toEqual([newer, answer]);
});
