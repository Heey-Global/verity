import { speakerLines } from './liveMeetingSpeakers';

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
    { speaker: 0, text: 'Hello there' },
    { speaker: null, text: 'yes together later' },
  ]);
});
