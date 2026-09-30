import type { SpeakerCorrection, SpeakerTurn, TimedWord } from './liveMeetingStore';

export interface SpeakerLine {
  speaker: number | null;
  text: string;
  start: number;
  end: number;
}

export function resolvedSpeaker(
  speaker: number | null,
  merges: Record<string, number>,
): number | null {
  if (speaker === null) return null;
  const seen = new Set<number>();
  while (merges[speaker] !== undefined && !seen.has(speaker)) {
    seen.add(speaker);
    speaker = merges[speaker]!;
  }
  return seen.has(speaker) ? null : speaker;
}

export function untimedTranscriptTail(transcript: string, words: TimedWord[]): string | null {
  if (!words.length) return transcript.trim();
  const spoken = words.flatMap((word) => word.text.match(/\S+/gu) ?? []);
  const transcriptWords = [...transcript.matchAll(/\S+/gu)];
  const comparable = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (let index = 0; index < spoken.length; index++) {
    if (
      !transcriptWords[index] ||
      comparable(spoken[index]!) !== comparable(transcriptWords[index]![0])
    )
      return null;
  }
  const last = transcriptWords[spoken.length - 1];
  return last ? transcript.slice(last.index + last[0].length).trim() : transcript.trim();
}

export function speakerLines(
  words: TimedWord[],
  turns: SpeakerTurn[],
  corrections: SpeakerCorrection[] = [],
  merges: Record<string, number> = {},
): SpeakerLine[] {
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
    const correction = corrections.findLast(
      (entry) => entry.start <= word.start && entry.end >= word.end,
    );
    const candidates = new Set(matches.map((match) => resolvedSpeaker(match.speaker, merges)));
    const speaker = correction
      ? resolvedSpeaker(correction.speaker, merges)
      : candidates.size === 1
        ? [...candidates][0]!
        : null;
    const previous = lines.at(-1);
    if (
      previous?.speaker === speaker &&
      word.start - previous.end <= 1.2 &&
      previous.text.length < 240 &&
      !/[.!?]$/.test(previous.text)
    ) {
      previous.text += ` ${word.text}`;
      previous.end = word.end;
    } else lines.push({ speaker, text: word.text, start: word.start, end: word.end });
  }
  return lines;
}
