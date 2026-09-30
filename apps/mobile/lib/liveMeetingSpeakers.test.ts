import { resolvedSpeaker, speakerLines, untimedTranscriptTail } from './liveMeetingSpeakers';

test('attributes words through a speaker change and leaves overlapping speech unknown', () => {
  const lines = speakerLines(
    [
      { text: 'Hello', start: 0.1, end: 0.6 },
      { text: 'there', start: 0.7, end: 1.1 },
      { text: 'yes', start: 1.3, end: 1.6 },
      { text: 'together', start: 1.8, end: 2.1 },
      { text: 'later', start: 3, end: 3.3 },
    ],
    [
      { speaker: 0, start: 0, end: 2.2 },
      { speaker: 1, start: 1.2, end: 2.2 },
    ],
  );
  expect(lines).toEqual([
    { speaker: 0, text: 'Hello there', start: 0.1, end: 1.1 },
    { speaker: null, text: 'yes together later', start: 1.3, end: 3.3 },
  ]);
});

test('applies a correction to an individual timed segment without changing other words', () => {
  expect(
    speakerLines(
      [
        { text: 'One', start: 0, end: 0.5 },
        { text: 'Two', start: 0.6, end: 1 },
      ],
      [{ speaker: 0, start: 0, end: 1 }],
      [{ speaker: 1, start: 0.6, end: 1 }],
    ),
  ).toEqual([
    { speaker: 0, text: 'One', start: 0, end: 0.5 },
    { speaker: 1, text: 'Two', start: 0.6, end: 1 },
  ]);
});

test('merges duplicate identities across earlier and later words', () => {
  const merges = { '1': 0 };
  expect(
    speakerLines(
      [
        { text: 'First', start: 0, end: 0.3 },
        { text: 'Later', start: 2, end: 2.3 },
      ],
      [
        { speaker: 1, start: 0, end: 0.3 },
        { speaker: 0, start: 2, end: 2.3 },
      ],
      [],
      merges,
    ),
  ).toEqual([
    { speaker: 0, text: 'First', start: 0, end: 0.3 },
    { speaker: 0, text: 'Later', start: 2, end: 2.3 },
  ]);
  expect(resolvedSpeaker(1, merges)).toBe(0);
});

test('keeps live text visible while word timings catch up', () => {
  expect(
    untimedTranscriptTail('Hello, world is speaking', [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'world', start: 0.5, end: 1 },
    ]),
  ).toBe('is speaking');
  expect(
    untimedTranscriptTail('A changed partial transcript', [{ text: 'Old', start: 0, end: 0.4 }]),
  ).toBe('A changed partial transcript');
});
