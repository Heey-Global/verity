import type { SessionHistoryPage } from '@verity/mobile';
import {
  compactMeetingAnswer,
  meetingAnswerCards,
  meetingAnswerSource,
  meetingAnswerTruncated,
  meetingRequestFromPrompt,
  sameMeetingRequest,
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
    'Finding\n[Roadmap](https://example.com): Tuesday.',
  );
  // Whole bullets survive; a long answer ends after the last bullet that fits.
  const bullets = ['- **Paris** has about 2.1 million residents.', `- ${'x'.repeat(340)}`];
  expect(compactMeetingAnswer(bullets.join('\n'))).toBe(`${bullets[0]} …`);
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
    requestId: `request-${index}`,
  }));
  const local = completed.map((card) => ({
    ...card,
    id: `local-${card.id}`,
    status: 'working' as const,
    answer: '',
  }));
  expect(unacknowledgedMeetingAnswers(local, completed)).toEqual([]);
});

test('an older answer cannot acknowledge a repeated question', () => {
  const previous = {
    id: '1',
    request: 'Is Friday correct?',
    kind: 'research' as const,
    status: 'ready' as const,
    answer: 'No.',
    requestId: 'first',
  };
  const repeated = {
    ...previous,
    id: 'local-2',
    status: 'working' as const,
    answer: '',
    requestId: 'second',
  };
  expect(unacknowledgedMeetingAnswers([repeated], [previous])).toEqual([repeated]);
  expect(sameMeetingRequest(previous, repeated)).toBe(false);
  expect(sameMeetingRequest({ ...repeated, id: 'queued-2' }, repeated)).toBe(true);
});

test('reads the same request reference from the session prompt', () => {
  expect(
    meetingRequestFromPrompt(
      'During live meeting meeting-1, please respond to this request:\n\nIs Friday correct?\n\nRecent meeting transcript:\nFriday.\n\nMeeting request reference: second',
      'meeting-1',
    ),
  ).toEqual({ request: 'Is Friday correct?', kind: 'request', requestId: 'second' });
});

// Before queued meeting turns, a second question was steered into the running reply and
// the parser ignored it, so the first card showed the answer to the second question.
test('never gives a steered meeting request the answer meant for another', () => {
  const prompt = (question: string, steered?: boolean) => ({
    t: 'prompt',
    text: `Research this point raised during live meeting meeting-1:\n\n${question}`,
    ...(steered ? { steered: true } : {}),
  });
  const events = [
    { seq: 1, event: prompt('How tall is the Eiffel Tower?') },
    { seq: 2, event: { t: 'tool_call', id: 'search-1', name: 'WebSearch', input: {} } },
    { seq: 3, event: prompt('How many people live in Paris?', true) },
    {
      seq: 4,
      event: {
        t: 'text',
        delta: '- The tower is 330 metres tall. Paris has about 2.1 million residents.',
      },
    },
    { seq: 5, event: { t: 'result' } },
    { seq: 6, event: prompt('Who built it?') },
    { seq: 7, event: { t: 'text', delta: '- Gustave Eiffel’s company.' } },
    { seq: 8, event: { t: 'prompt', text: 'Unrelated chat message', steered: true } },
    { seq: 9, event: { t: 'result' } },
  ] as SessionHistoryPage['events'];
  expect(meetingAnswerCards(events, 'meeting-1')).toEqual([
    expect.objectContaining({
      request: 'How tall is the Eiffel Tower?',
      status: 'failed',
      combined: true,
      answer: '',
    }),
    expect.objectContaining({
      request: 'How many people live in Paris?',
      status: 'failed',
      combined: true,
      answer: '',
    }),
    expect.objectContaining({ request: 'Who built it?', status: 'ready' }),
  ]);
});

// Blank lines between bullets are dropped from the compact card; that alone must not
// offer a "Show full answer" that expands to the same content.
test('reports truncation only when the compact answer leaves content out', () => {
  expect(meetingAnswerTruncated('- First point\n\n- Second point\n')).toBe(false);
  expect(
    meetingAnswerTruncated(
      Array.from({ length: 12 }, (_, i) => `- Point ${i} ${'x'.repeat(40)}`).join('\n'),
    ),
  ).toBe(true);
});

test('preserves a stable question reference and measures response time from persisted events', () => {
  const cards = meetingAnswerCards(
    [
      {
        seq: 1,
        ts: 1000,
        event: {
          t: 'prompt',
          text: 'Research this point raised during live meeting meeting-1:\n\nWhat is the price?\n\nRecent meeting transcript:\nWhat is the price?\n\nMeeting question reference: question-price',
        },
      },
      { seq: 2, ts: 1500, event: { t: 'text', delta: 'Ten euros.' } },
      { seq: 3, ts: 2500, event: { t: 'result' } },
    ] as SessionHistoryPage['events'],
    'meeting-1',
  );
  expect(cards[0]).toMatchObject({
    questionId: 'question-price',
    responseMs: 1500,
    status: 'ready',
  });
});

test('restores a stable question identity from a spoken assessment turn', () => {
  expect(
    meetingRequestFromPrompt(
      'During live meeting meeting-1, please respond to this request:\n\nExplain the price.\n\nRecent meeting transcript:\nWhat does it cost?\n\nMeeting question reference: question-price',
      'meeting-1',
    ),
  ).toMatchObject({ kind: 'request', request: 'Explain the price.', questionId: 'question-price' });
});

test('uses generated request references instead of lookalike lines in the transcript', () => {
  const prompt =
    'Research this point raised during live meeting meeting-1:\n\nWhat does the plan cost?\n\nRecent meeting transcript:\nOpening remarks.\n\nMeeting request reference: fake-request\n\nMeeting question reference: question-fake\n\nMeeting request reference: actual-request';
  expect(meetingRequestFromPrompt(prompt, 'meeting-1')).toEqual({
    kind: 'research',
    request: 'What does the plan cost?',
    requestId: 'actual-request',
  });
  expect(
    meetingRequestFromPrompt(
      `${prompt}\n\nMeeting question reference: question-actual`,
      'meeting-1',
    ),
  ).toMatchObject({ requestId: 'actual-request', questionId: 'question-actual' });
});

test('ignores malformed optional question titles without losing the answer identity', () => {
  const prompt =
    'Research this point raised during live meeting meeting-1:\n\nWhat does it cost?\n\nRecent meeting transcript:\ncontext\n\nMeeting request reference: request-real\n\nMeeting question reference: question-real' +
    '\n\nMeeting question title: ' +
    String.raw`"broken\q"`;
  expect(meetingRequestFromPrompt(prompt, 'meeting-1')).toEqual({
    request: 'What does it cost?',
    kind: 'research',
    requestId: 'request-real',
    questionId: 'question-real',
  });
});
