import type { SessionHistoryPage } from '@verity/mobile';
import {
  compactMeetingAnswer,
  meetingAnswerCards,
  meetingAnswerSource,
  meetingRequestFromPrompt,
  unacknowledgedMeetingAnswers,
} from './liveMeetingAnswers';

test('matches a meeting request to its own streamed answer across ordinary session turns', () => {
  const events = [
    { seq: 1, event: { t: 'prompt', text: 'Ordinary session request' } },
    { seq: 2, event: { t: 'text', delta: 'Unrelated answer' } },
    { seq: 3, event: { t: 'result' } },
    {
      seq: 4,
      event: {
        t: 'prompt',
        text: 'Research this point raised during live meeting meeting-1:\n\nIs Friday correct?\n\nRecent meeting transcript:\nFriday was mentioned.',
      },
    },
    { seq: 5, event: { t: 'text', delta: 'I will check.' } },
    { seq: 6, event: { t: 'tool_call', id: 'search-1', name: 'WebSearch', input: {} } },
    { seq: 7, event: { t: 'text', delta: 'The plan says ' } },
    { seq: 8, event: { t: 'text', delta: 'Tuesday.' } },
    { seq: 9, event: { t: 'result' } },
    {
      seq: 10,
      event: {
        t: 'prompt',
        text: 'During live meeting meeting-2, please respond to this request:\n\nWhat next?',
      },
    },
    { seq: 11, event: { t: 'text', delta: 'Another meeting answer' } },
  ] as SessionHistoryPage['events'];
  expect(meetingAnswerCards(events, 'meeting-1')).toEqual([
    {
      id: '4',
      request: 'Is Friday correct?',
      kind: 'research',
      status: 'ready',
      answer: 'The plan says Tuesday.',
    },
  ]);
});

test('keeps an in-progress spoken request in the meeting and does not show subagent text', () => {
  const events = [
    {
      seq: 10,
      event: {
        t: 'prompt',
        text: 'During live meeting meeting-1, please respond to this request:\n\nWhat do you think?',
      },
    },
    { seq: 11, event: { t: 'text', delta: 'Hidden work', parentToolId: 'tool-1' } },
  ] as SessionHistoryPage['events'];
  expect(meetingAnswerCards(events, 'meeting-1')).toEqual([
    {
      id: '10',
      request: 'What do you think?',
      kind: 'request',
      status: 'working',
      answer: '',
    },
  ]);
});

test('keeps a short, readable answer in the compact card', () => {
  expect(compactMeetingAnswer('## Finding\n\n[Roadmap](https://example.com): Tuesday.')).toBe(
    'Finding Roadmap: Tuesday.',
  );
  expect(meetingAnswerSource('[Roadmap](https://example.com/plan): Tuesday.')).toBe('example.com');
});

test('keeps a multiline typed request together before transcript context', () => {
  expect(
    meetingRequestFromPrompt(
      'During live meeting meeting-1, please respond to this request:\n\nCheck the budget.\n\nAlso check the date.\n\nRecent meeting transcript:\nThe plan changed.',
      'meeting-1',
    ),
  ).toEqual({ request: 'Check the budget.\n\nAlso check the date.', kind: 'request' });
});

test('completed requests do not return as working cards after the visible four move on', () => {
  const completed = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    request: `Question ${index}`,
    kind: 'research' as const,
    status: 'ready' as const,
    answer: `Answer ${index}`,
  }));
  const local = completed.map((card) => ({
    ...card,
    id: `local-${card.id}`,
    status: 'working' as const,
    answer: '',
  }));
  expect(unacknowledgedMeetingAnswers(local, completed)).toEqual([]);
});
