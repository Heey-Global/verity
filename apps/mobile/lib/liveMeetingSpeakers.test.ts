import {
  reconcileTimedTranscript,
  resolvedSpeaker,
  speakerLines,
  wordsFromRuns,
} from './liveMeetingSpeakers';

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
});

// A single person speaking with pauses showed as Unknown speaker: the phrase's
// timing includes the pauses, and the diarizer marks only the speech in between.
test('keeps the speaker of a phrase spoken with pauses', () => {
  const turns = [
    { speaker: 0, start: 0.2, end: 1.1 },
    { speaker: 0, start: 1.9, end: 2.4 },
    { speaker: 0, start: 3.3, end: 3.9 },
  ];
  expect(
    speakerLines([{ text: 'Das wäre ja super, wenn das klappt.', start: 0, end: 4.2 }], turns),
  ).toEqual([{ speaker: 0, text: 'Das wäre ja super, wenn das klappt.', start: 0, end: 4.2 }]);
  // The same holds per word: a word falling in a short pause belongs to the speaker
  // around it.
  expect(
    speakerLines(
      [
        { text: 'Das', start: 0.2, end: 0.5 },
        { text: 'wäre', start: 1.3, end: 1.7 },
        { text: 'super', start: 1.9, end: 2.4 },
      ],
      turns,
    ),
  ).toEqual([{ speaker: 0, text: 'Das wäre super', start: 0.2, end: 2.4 }]);
});

// Older phrase-level timings span seconds; a voice heard for a sliver of one is no
// evidence of who said the rest.
test('counts repeated and overlapping turns of one speaker once', () => {
  // Union coverage: 0.8–0.95 is heard once, 30 % of the word, enough for speaker 0.
  expect(
    speakerLines(
      [{ text: 'gap', start: 0.8, end: 1.3 }],
      [
        { speaker: 0, start: 0, end: 0.9 },
        { speaker: 0, start: 0.85, end: 0.95 },
      ],
    ),
  ).toEqual([{ speaker: 0, text: 'gap', start: 0.8, end: 1.3 }]);
});

// Padding makes turn edges clip words slightly; such a word must not become unknown
// when the clipping turn is the only voice around it.
test('keeps the speaker of a word clipped by that speaker’s turn edge', () => {
  expect(
    speakerLines([{ text: 'klappt', start: 1, end: 2 }], [{ speaker: 0, start: 0, end: 1.1 }]),
  ).toEqual([{ speaker: 0, text: 'klappt', start: 1, end: 2 }]);
  // Clipped by one speaker while another starts right after: unknown.
  expect(
    speakerLines(
      [{ text: 'klappt', start: 1, end: 2 }],
      [
        { speaker: 0, start: 0, end: 1.1 },
        { speaker: 1, start: 2.1, end: 3 },
      ],
    ),
  ).toEqual([{ speaker: null, text: 'klappt', start: 1, end: 2 }]);
});

test('leaves a long span unknown when a voice covers only a sliver of it', () => {
  expect(
    speakerLines([{ text: 'Long phrase', start: 0, end: 4 }], [{ speaker: 1, start: 1, end: 1.2 }]),
  ).toEqual([{ speaker: null, text: 'Long phrase', start: 0, end: 4 }]);
});

test('leaves a pause between two different speakers unknown', () => {
  expect(
    speakerLines(
      [{ text: 'hm', start: 1.2, end: 1.4 }],
      [
        { speaker: 0, start: 0, end: 1 },
        { speaker: 1, start: 1.6, end: 2 },
      ],
    ),
  ).toEqual([{ speaker: null, text: 'hm', start: 1.2, end: 1.4 }]);
});

// Diarization runs about a second behind transcription; words it has not reached
// were shown as Unknown speaker until it caught up.
test('marks words the diarizer has not processed yet as pending', () => {
  const words = [
    { text: 'Hello', start: 0, end: 0.5 },
    { text: 'everyone', start: 2, end: 2.5 },
  ];
  const turns = [{ speaker: 0, start: 0, end: 0.6 }];
  expect(speakerLines(words, turns, [], {}, 1.5)).toEqual([
    { speaker: 0, text: 'Hello', start: 0, end: 0.5 },
    { speaker: null, text: 'everyone', start: 2, end: 2.5, pending: true },
  ]);
  // Without a horizon (the filed transcript), the same word is simply unattributed.
  expect(speakerLines(words, turns)[1]).toEqual({
    speaker: null,
    text: 'everyone',
    start: 2,
    end: 2.5,
  });
  // A correction still wins over a pending state.
  expect(speakerLines(words, turns, [{ start: 2, end: 2.5, speaker: 0 }], {}, 1.5)[1]).toEqual({
    speaker: 0,
    text: 'everyone',
    start: 2,
    end: 2.5,
  });
});

test('aligns timed words across punctuation that stands as its own token', () => {
  expect(
    reconcileTimedTranscript('alles erkennt . Das klappt', [
      { text: 'alles', start: 0, end: 0.4 },
      { text: 'erkennt', start: 0.5, end: 1 },
      { text: '.', start: 1, end: 1.1 },
      { text: 'Das', start: 2, end: 2.3 },
      { text: 'klappt', start: 2.4, end: 2.8 },
    ]),
  ).toEqual({
    words: [
      { text: 'alles', start: 0, end: 0.4 },
      { text: 'erkennt', start: 0.5, end: 1 },
      { text: '', start: 1, end: 1.1 },
      { text: 'Das', start: 2, end: 2.3 },
      { text: 'klappt', start: 2.4, end: 2.8 },
    ],
    tail: '',
  });
});

test('regroups Apple runs into timed words', () => {
  expect(
    wordsFromRuns([
      { text: '.', start: 0.9, end: 1 },
      { text: ' ' },
      { text: 'Hallo', start: 1, end: 1.4 },
      { text: ',', start: 1.4, end: 1.45 },
      { text: ' ' },
      { text: 'zusammen' },
      { text: ' ' },
      { text: 'heute', start: 2, end: 2.3 },
      { text: '.' },
    ]),
  ).toEqual([
    { text: 'Hallo, zusammen', start: 1, end: 1.45 },
    { text: 'heute.', start: 2, end: 2.3 },
  ]);
  // A leading untimed word joins the first timed one instead of being dropped.
  expect(wordsFromRuns([{ text: 'Ja ' }, { text: 'gut', start: 0, end: 0.3 }])).toEqual([
    { text: 'Ja gut', start: 0, end: 0.3 },
  ]);
});
