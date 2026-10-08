import { nextSpeakerNameCheck, type SpeakerNameHistory } from './liveMeetingNames';
import type { SpeakerLine } from './liveMeetingSpeakers';

const line = (speaker: number | null, text: string, start: number, end: number): SpeakerLine => ({
  speaker,
  text,
  start,
  end,
});

test('checks an introduction phrase as soon as it is attributed, with the sentence after it', () => {
  const lines = [
    line(0, 'Hi, ich bin', 0, 1),
    line(0, 'Holger.', 1, 1.5),
    line(1, 'Guten Morgen.', 2, 3),
  ];
  expect(nextSpeakerNameCheck(lines, new Set(), new Map(), 0)).toEqual({
    speaker: 0,
    text: 'Hi, ich bin Holger.',
    through: 1,
    opening: false,
  });
});

// The phrases only pick the moment: a speaker who never says one is still asked once,
// so an introduction in other words is not missed.
test('checks a speaker’s opening words once after fifteen seconds of speech', () => {
  const opening = [
    line(1, 'Morning everyone, Anna from design.', 0, 9),
    line(1, 'Shall we?', 10, 16),
  ];
  expect(nextSpeakerNameCheck(opening.slice(0, 1), new Set(), new Map(), 0)).toBeNull();
  expect(nextSpeakerNameCheck(opening, new Set(), new Map(), 0)).toMatchObject({
    speaker: 1,
    text: 'Morning everyone, Anna from design. Shall we?',
    opening: true,
  });
  const done = new Map<number, SpeakerNameHistory>([
    [1, { openingChecked: true, checkedThrough: 16, lastAt: 0 }],
  ]);
  expect(nextSpeakerNameCheck(opening, new Set(), done, 60_000)).toBeNull();
});

test('never checks a named speaker, pending or unknown words, or the same phrase twice', () => {
  const lines = [
    line(0, 'Ich bin Holger.', 0, 1),
    line(null, "I'm Anna.", 2, 3),
    { ...line(1, "I'm Ben.", 4, 5), pending: true },
  ];
  expect(nextSpeakerNameCheck(lines, new Set([0]), new Map(), 0)).toBeNull();
  const asked = new Map<number, SpeakerNameHistory>([
    [0, { openingChecked: false, checkedThrough: 1, lastAt: 0 }],
  ]);
  expect(nextSpeakerNameCheck(lines, new Set(), asked, 60_000)).toBeNull();
  // A later introduction by the same speaker is checked, but not within ten seconds.
  const later = [...lines, line(0, 'Mein Name ist Holger Teske.', 20, 22)];
  expect(nextSpeakerNameCheck(later, new Set(), asked, 5_000)).toBeNull();
  expect(nextSpeakerNameCheck(later, new Set(), asked, 60_000)).toMatchObject({
    speaker: 0,
    through: 22,
  });
});
