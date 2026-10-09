import { afterEach, expect, it, vi } from 'vitest';
import type { EventStore, LiveMeetingSyncRecord } from '@verity/store';
import { meetingQuestionChecks, questionWindow } from './live-meeting-questions.js';

const meeting = (transcript: string, revision = 1): LiveMeetingSyncRecord => ({
  id: 'meeting',
  sessionId: 'session',
  engine: 'apple-speech',
  startedAt: 1,
  endedAt: null,
  state: 'active',
  captureStatus: 'listening',
  ownerTokenHash: 'test',
  revision,
  transcript,
});
afterEach(() => vi.useRealTimers());
function setup(
  query = vi.fn().mockResolvedValue(
    JSON.stringify({
      questions: [{ question: 'Was kostet der Plan?', quote: 'Was kostet. Der Plan?' }],
    }),
  ),
) {
  const insights = vi.fn().mockResolvedValue([]);
  const addInsight = vi.fn().mockResolvedValue(true);
  const onError = vi.fn();
  const reconcileQuestions = vi.fn().mockResolvedValue(true);
  const controller = meetingQuestionChecks({
    store: {
      liveMeetings: {
        insights,
        addInsight,
        reconcileQuestions,
      },
    } as unknown as EventStore,
    query,
    delayMs: 10,
    onError,
  });
  return { controller, query, insights, addInsight, onError, reconcileQuestions };
}
it('settles a burst and joins recognition fragments with verified evidence', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.controller.ingest(meeting('Was kostet.'));
  s.controller.ingest(meeting('Was kostet. Der Plan?', 2));
  await vi.advanceTimersByTimeAsync(20);
  expect(s.query).toHaveBeenCalledTimes(1);
  expect(s.addInsight).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({
      summary: 'Was kostet der Plan?',
      evidenceA: 'Was kostet. Der Plan?',
      id: expect.stringMatching(/^question-/),
    }),
    true,
  );
  s.controller.ingest(meeting('Was kostet. Der Plan?', 3));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(s.query).toHaveBeenCalledTimes(1);
  s.controller.close();
});
it('checks questions without a question mark and ignores incomplete or ordinary speech', () => {
  expect(questionWindow('Wie viel kostet der Plan.')).toContain('Wie viel');
  expect(questionWindow('Wie viel kostet')).toBeNull();
  expect(questionWindow('Ein normaler Satz.')).toBeNull();
  const initial = questionWindow(
    'Was kostet der Plan? Danke. Wir besprechen etwas anderes. Ein letzter Satz.',
  );
  expect(
    questionWindow(
      'Was kostet der Plan? Danke. Wir besprechen etwas anderes. Ein letzter Satz. Jetzt weiter.',
    ),
  ).toBe(initial);
  expect(questionWindow('What does it cost? Let me check. It costs ten euros.')).toContain(
    'It costs ten euros.',
  );
});
it('reuses a known identity for a paraphrase and refuses invented evidence', async () => {
  vi.useFakeTimers();
  const s = setup(
    vi.fn().mockResolvedValue(
      JSON.stringify({
        questions: [
          {
            question: 'Wie teuer ist der Plan?',
            quote: 'Was kostet. Der Plan?',
            existingId: 'question-known',
          },
          { question: 'Another invented question?', quote: 'This was never spoken.' },
        ],
      }),
    ),
  );
  s.insights.mockResolvedValue([{ id: 'question-known', summary: 'Was kostet der Plan?' }]);
  s.controller.ingest(meeting('Was kostet. Der Plan?'));
  await vi.advanceTimersByTimeAsync(20);
  expect(s.addInsight).toHaveBeenCalledTimes(1);
  expect(s.addInsight).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ id: 'question-known' }),
    true,
  );
  s.controller.close();
});
it('discards an in-flight result after transcription was corrected', async () => {
  vi.useFakeTimers();
  let finish!: (text: string) => void;
  const s = setup(
    vi.fn().mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  s.controller.ingest(meeting('Was kostet. Der Plan?'));
  await vi.advanceTimersByTimeAsync(20);
  s.controller.ingest(meeting('Was kostet die Reise?', 2));
  finish(
    JSON.stringify({
      questions: [{ question: 'Was kostet der Plan?', quote: 'Was kostet. Der Plan?' }],
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(s.addInsight).not.toHaveBeenCalled();
  s.controller.close();
});
it('limits persistent failures and stops all work on close', async () => {
  vi.useFakeTimers();
  const s = setup(vi.fn().mockRejectedValue(new Error('unavailable')));
  s.controller.ingest(meeting('Was kostet. Der Plan?'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(s.query).toHaveBeenCalledTimes(3);
  s.controller.ingest(meeting('Was kostet die Reise?', 2));
  s.controller.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(s.query).toHaveBeenCalledTimes(3);
});

it('does not publish a late result after shutdown', async () => {
  vi.useFakeTimers();
  let finish!: (text: string) => void;
  const s = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  s.controller.ingest(meeting('Was kostet. Der Plan?'));
  await vi.advanceTimersByTimeAsync(20);
  s.controller.close();
  finish(
    JSON.stringify({
      questions: [{ question: 'Was kostet der Plan?', quote: 'Was kostet. Der Plan?' }],
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(s.addInsight).not.toHaveBeenCalled();
});

it('bounds concurrent checks across meetings and resumes queued work', async () => {
  vi.useFakeTimers();
  const finishes: Array<(text: string) => void> = [];
  const s = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishes.push(resolve);
        }),
    ),
  );
  for (let index = 0; index < 3; index += 1)
    s.controller.ingest({ ...meeting('Was kostet. Der Plan?'), id: `meeting-${index}` });
  await vi.advanceTimersByTimeAsync(20);
  expect(s.query).toHaveBeenCalledTimes(2);
  finishes[0]!(JSON.stringify({ questions: [] }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.query).toHaveBeenCalledTimes(3);
  s.controller.close();
  for (const finish of finishes) finish(JSON.stringify({ questions: [] }));
  await vi.advanceTimersByTimeAsync(1);
});

it('postpones classification until changed transcript text settles', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.controller.ingest(meeting('Was kostet.'));
  await vi.advanceTimersByTimeAsync(9);
  s.controller.ingest(meeting('Was kostet. Der Plan?', 2));
  await vi.advanceTimersByTimeAsync(9);
  expect(s.query).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.query).toHaveBeenCalledTimes(1);
  s.controller.close();
});

it('reconciles classification against the current revision when its window is unchanged', async () => {
  vi.useFakeTimers();
  let finish!: (text: string) => void;
  const s = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const text = 'Was kostet der Plan? Danke. Ein weiterer Satz. Noch ein Satz.';
  s.controller.ingest(meeting(text));
  await vi.advanceTimersByTimeAsync(20);
  s.controller.ingest(meeting(text + ' Weiter geht es.', 2));
  finish(JSON.stringify({ questions: [] }));
  await vi.advanceTimersByTimeAsync(1);
  expect(s.reconcileQuestions).toHaveBeenCalledWith('session', 'meeting', 2, {
    text,
    acceptedIds: [],
  });
  s.controller.close();
});
it('retries classification when the database rejects its revision', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.reconcileQuestions.mockResolvedValueOnce(false);
  s.controller.ingest(meeting('Was kostet. Der Plan?'));
  await vi.advanceTimersByTimeAsync(5020);
  expect(s.query).toHaveBeenCalledTimes(2);
  s.controller.close();
});
