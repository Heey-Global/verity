import { meetingSavedCard } from './meetingSavedCard';

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
