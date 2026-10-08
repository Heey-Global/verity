import { reconcileTimedTranscript, resolvedSpeaker, speakerLines } from './liveMeetingSpeakers';

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

test('treats overlapping merged identities as one speaker', () => {
  expect(
    speakerLines(
      [{ text: 'Together', start: 0, end: 0.5 }],
      [
        { speaker: 0, start: 0, end: 0.5 },
        { speaker: 1, start: 0, end: 0.5 },
      ],
      [],
      { '1': 0 },
    ),
  ).toEqual([{ speaker: 0, text: 'Together', start: 0, end: 0.5 }]);
});

test('keeps live text visible while word timings catch up', () => {
  expect(
    reconcileTimedTranscript('Hello, world is speaking', [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'world', start: 0.5, end: 1 },
    ]),
  ).toEqual({
    words: [
      { text: 'Hello,', start: 0, end: 0.4 },
      { text: 'world', start: 0.5, end: 1 },
    ],
    tail: 'is speaking',
  });
  expect(
    reconcileTimedTranscript('A changed partial transcript', [{ text: 'Old', start: 0, end: 0.4 }]),
  ).toBeNull();
});

test('keeps source punctuation and casing across a timed segment', () => {
  expect(
    reconcileTimedTranscript('Hello, WORLD!', [{ text: 'hello world', start: 0, end: 1 }]),
  ).toEqual({ words: [{ text: 'Hello, WORLD!', start: 0, end: 1 }], tail: '' });
});

// Streaming diarization splits one voice into short turns. A word across such a
// boundary used to match neither turn on its own and showed as Unknown speaker.
test('attributes a word that spans adjacent turns of the same speaker', () => {
  expect(
    speakerLines(
      [{ text: 'Holger', start: 0.8, end: 1.3 }],
      [
        { speaker: 0, start: 0, end: 1 },
        { speaker: 0, start: 1, end: 2 },
        // A repeated turn must not make a partial overlap look complete.
        { speaker: 1, start: 1.1, end: 1.2 },
        { speaker: 1, start: 1.1, end: 1.2 },
      ],
    ),
  ).toEqual([{ speaker: 0, text: 'Holger', start: 0.8, end: 1.3 }]);
  expect(
    speakerLines(
      [{ text: 'gap', start: 0.8, end: 1.3 }],
      [
        { speaker: 0, start: 0, end: 0.9 },
        { speaker: 0, start: 0.85, end: 0.95 },
      ],
    ),
  ).toEqual([{ speaker: null, text: 'gap', start: 0.8, end: 1.3 }]);
});
