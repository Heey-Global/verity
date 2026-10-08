import type { SpeakerLine } from './liveMeetingSpeakers';

// These phrases only decide when to ask the model. Whether a name was given, and which,
// is the model's call: "ich bin Lehrer" or "I'm ready" match here and are rejected there.
const INTRODUCTION =
  /(?<![\p{L}\p{N}])(?:ich\s+bin|ich\s+hei(?:ß|ss)e|mein\s+name|hier\s+ist|hier\s+spricht|i['’]?m|i\s+am|my\s+name|this\s+is|call\s+me)(?![\p{L}\p{N}])/iu;

/** Without an introduction phrase, a speaker's opening words are checked once after
 * this much speech, which also catches introductions the phrases do not cover. */
const OPENING_SECONDS = 15;
export const MIN_INTERVAL_MS = 10_000;
/** "I'm" and "this is" are common in ordinary speech; each check is a model call, so a
 * speaker who never introduces themselves is not asked about for the whole meeting. */
const MAX_CHECKS = 3;
const MAX_TEXT = 1500;

export interface SpeakerNameHistory {
  openingChecked: boolean;
  /** Audio time up to which this speaker's lines were already sent. */
  checkedThrough: number;
  checks: number;
  lastAt: number;
}

export interface SpeakerNameCheck {
  speaker: number;
  text: string;
  through: number;
  opening: boolean;
}

/** The next unnamed speaker whose words are worth one name check, if any. */
export function nextSpeakerNameCheck(
  lines: readonly SpeakerLine[],
  skip: ReadonlySet<number>,
  history: ReadonlyMap<number, SpeakerNameHistory>,
  now: number,
): SpeakerNameCheck | null {
  const speakers = [
    ...new Set(
      lines.flatMap((line) => (line.speaker === null || line.pending ? [] : [line.speaker])),
    ),
  ];
  for (const speaker of speakers) {
    if (skip.has(speaker)) continue;
    const previous = history.get(speaker);
    if (previous && (previous.checks >= MAX_CHECKS || now - previous.lastAt < MIN_INTERVAL_MS))
      continue;
    const spoken = lines.filter((line) => line.speaker === speaker && !line.pending);
    const index = spoken.findIndex(
      (line) => line.end > (previous?.checkedThrough ?? -Infinity) && INTRODUCTION.test(line.text),
    );
    if (index >= 0) {
      // The sentence before and after carry the name when recognition split it off.
      const around = spoken.slice(Math.max(0, index - 1), index + 2);
      return {
        speaker,
        text: around
          .map((line) => line.text)
          .join(' ')
          .slice(0, MAX_TEXT),
        through: spoken[index]!.end,
        opening: false,
      };
    }
    if (previous?.openingChecked) continue;
    if (spoken.reduce((total, line) => total + line.end - line.start, 0) < OPENING_SECONDS)
      continue;
    let text = '';
    let through = -Infinity;
    for (const line of spoken) {
      if (text && text.length + line.text.length + 1 > MAX_TEXT) break;
      text = text ? `${text} ${line.text}` : line.text.slice(0, MAX_TEXT);
      through = line.end;
    }
    return { speaker, text, through, opening: true };
  }
  return null;
}
