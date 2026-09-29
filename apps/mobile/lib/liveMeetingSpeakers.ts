import type { SpeakerTurn, TimedWord } from './liveMeetingStore';

export interface SpeakerLine {
  speaker: number | null;
  text: string;
}

export function speakerLines(words: TimedWord[], turns: SpeakerTurn[]): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  for (const word of words) {
    const duration = word.end - word.start;
    if (!word.text.trim() || duration <= 0) continue;
    const matches = turns
      .map((turn) => ({
        speaker: turn.speaker,
        overlap: Math.max(0, Math.min(word.end, turn.end) - Math.max(word.start, turn.start)),
      }))
      .filter(({ overlap }) => overlap > duration * 0.6);
    const speaker = matches.length === 1 ? matches[0]!.speaker : null;
    const previous = lines.at(-1);
    if (previous?.speaker === speaker) previous.text += ` ${word.text}`;
    else lines.push({ speaker, text: word.text });
  }
  return lines;
}
