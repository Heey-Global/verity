import type { MeetingRecord, SpeakerCorrection, SpeakerTurn, TimedWord } from './liveMeetingStore';

export interface SpeakerLine {
  speaker: number | null;
  text: string;
  start: number;
  end: number;
  /** Not yet reached by the diarizer; shown without a speaker until it is. */
  pending?: boolean;
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

export function reconcileTimedTranscript(
  transcript: string,
  words: TimedWord[],
): { words: TimedWord[]; tail: string } | null {
  const transcriptWords = [...transcript.matchAll(/\S+/gu)];
  const comparable = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // Apple joins results so a lone "." or "," can stand as its own token. Such tokens
  // carry no timing to align, and comparing them to the next word broke alignment.
  const skipPunctuation = (from: number) => {
    while (transcriptWords[from] && !comparable(transcriptWords[from]![0])) from++;
    return from;
  };
  let index = 0;
  const aligned = words.map((word) => {
    const spoken = (word.text.match(/\S+/gu) ?? []).filter((token) => comparable(token));
    if (!spoken.length) return { ...word, text: '' };
    const first = transcriptWords[index];
    for (const token of spoken) {
      index = skipPunctuation(index);
      if (!transcriptWords[index] || comparable(token) !== comparable(transcriptWords[index]![0]))
        return null;
      index++;
    }
    // Preserve untimed punctuation in the adjacent timed text, including sentence ends.
    index = skipPunctuation(index);
    const last = transcriptWords[index - 1];
    return first && last
      ? { ...word, text: transcript.slice(first.index, last.index + last[0].length) }
      : null;
  });
  if (aligned.some((word) => word === null)) return null;
  const last = transcriptWords[index - 1];
  return {
    words: aligned as TimedWord[],
    tail: last ? transcript.slice(last.index + last[0].length).trim() : transcript.trim(),
  };
}

export function speakerLines(
  words: TimedWord[],
  turns: SpeakerTurn[],
  corrections: SpeakerCorrection[] = [],
  merges: Record<string, number> = {},
  /** Audio time the diarizer has processed through; later words are pending. */
  horizon = Infinity,
): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  const resolved = turns
    .map((turn) => ({ ...turn, who: resolvedSpeaker(turn.speaker, merges) }))
    .sort((a, b) => a.start - b.start);
  // Turns are sorted by start, so each word only needs the window that can reach it:
  // a long meeting would otherwise scan every turn for every word.
  const longest = resolved.reduce((max, turn) => Math.max(max, turn.end - turn.start), 0);
  const firstReaching = (time: number) => {
    let low = 0;
    let high = resolved.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (resolved[middle]!.start < time - longest) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  // Coverage is a union, so a turn repeated by the model is not counted twice.
  const heardFor = (spans: [number, number][]) => {
    let total = 0;
    let reached = -Infinity;
    for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
      total += Math.max(0, to - Math.max(from, reached));
      reached = Math.max(reached, to);
    }
    return total;
  };
  for (const word of words) {
    const duration = word.end - word.start;
    if (!word.text.trim() || duration <= 0) continue;
    // A word's timing includes the pause around it, while the diarizer marks only
    // speech; measured against the whole word, a phrase spoken with pauses matched
    // nobody. The share is therefore taken of the time any voice was heard, and
    // adjacent turns of one speaker count together.
    const covered = new Map<number | null, [number, number][]>();
    // Turns running past the word's edge: evidence of who was speaking around it.
    const crossing = new Set<number | null>();
    const nearby: typeof resolved = [];
    for (let index = firstReaching(word.start - 0.6); index < resolved.length; index++) {
      const turn = resolved[index]!;
      if (turn.start >= word.end + 0.6) break;
      nearby.push(turn);
    }
    for (const turn of nearby) {
      const from = Math.max(word.start, turn.start);
      const to = Math.min(word.end, turn.end);
      if (to <= from) continue;
      covered.set(turn.who, [...(covered.get(turn.who) ?? []), [from, to]]);
      if (turn.start < word.start || turn.end > word.end) crossing.add(turn.who);
    }
    const heard = heardFor([...covered.values()].flat());
    let speaker: number | null | undefined;
    // A voice heard for only a sliver of a long span is not enough evidence; older
    // phrase-level timings would otherwise go to whoever spoke briefly inside them.
    if (heard >= duration * 0.25) {
      // Two voices each heard for most of the word is real overlap: leave it unknown.
      const dominant = [...covered].filter(([, spans]) => heardFor(spans) > heard * 0.6);
      speaker = dominant.length === 1 ? dominant[0]![0] : null;
    } else if (heard === 0 && word.start >= horizon) {
      // The diarizer has not reached this audio yet; it is pending, not unknown.
      speaker = undefined;
    } else {
      // A short pause inside one person's speech belongs to that person, and so does a
      // word clipped by that person's turn edge. Anyone else heard nearby leaves it
      // unknown.
      const neighbours = nearby.filter(
        (turn) =>
          (turn.end <= word.start && word.start - turn.end < 0.6) ||
          (turn.start >= word.end && turn.start - word.end < 0.6),
      );
      const around = new Set([...covered.keys(), ...neighbours.map((turn) => turn.who)]);
      // A voice heard only inside the word, with no one around it, is too little to go on.
      speaker =
        duration <= 1 && (neighbours.length || crossing.size) && around.size === 1
          ? [...around][0]!
          : null;
    }
    const correction = corrections.findLast(
      (entry) => entry.start <= word.start && entry.end >= word.end,
    );
    if (correction) speaker = resolvedSpeaker(correction.speaker, merges);
    const pending = speaker === undefined;
    const previous = lines.at(-1);
    if (
      previous &&
      previous.speaker === (speaker ?? null) &&
      (previous.pending ?? false) === pending &&
      word.start - previous.end <= 1.2 &&
      previous.text.length < 240 &&
      !/[.!?]$/.test(previous.text)
    ) {
      previous.text += ` ${word.text}`;
      previous.end = word.end;
    } else
      lines.push({
        speaker: speaker ?? null,
        text: word.text,
        start: word.start,
        end: word.end,
        ...(pending ? { pending: true } : {}),
      });
  }
  return lines;
}

/**
 * Apple reports timing per attributed-string run. A run can split a word from its
 * punctuation or hold only whitespace, so runs are regrouped into the
 * whitespace-delimited words the transcript is aligned on. A word without any
 * timed run joins its neighbour rather than leaving a gap in the alignment.
 */
export function wordsFromRuns(
  runs: ReadonlyArray<{ text: string; start?: number; end?: number }>,
): TimedWord[] {
  let offset = 0;
  const spans = runs.map((run) => {
    const span = { from: offset, to: offset + run.text.length, start: run.start, end: run.end };
    offset = span.to;
    return span;
  });
  const words: TimedWord[] = [];
  let orphan = '';
  for (const match of runs
    .map((run) => run.text)
    .join('')
    .matchAll(/\S+/gu)) {
    const from = match.index;
    const to = from + match[0].length;
    const timed = spans.filter(
      (span) =>
        span.from < to &&
        span.to > from &&
        Number.isFinite(span.start) &&
        Number.isFinite(span.end) &&
        span.end! > span.start!,
    );
    if (!/[\p{L}\p{N}]/u.test(match[0])) continue;
    const previous = words.at(-1);
    if (!timed.length) {
      if (previous) previous.text += ` ${match[0]}`;
      else orphan += `${match[0]} `;
      continue;
    }
    words.push({
      text: `${orphan}${match[0]}`,
      start: Math.min(...timed.map((span) => span.start!)),
      end: Math.max(...timed.map((span) => span.end!)),
    });
    orphan = '';
  }
  return words;
}

/** Transcript rows as the meeting screen shows them: attributed lines where word
 * timings align with the text, then any text the timings have not reached yet. */
export function meetingTranscriptRows(
  meeting: MeetingRecord,
): Array<SpeakerLine | { text: string; pending?: boolean }> {
  if (meeting.timedWords?.length) {
    const aligned = reconcileTimedTranscript(meeting.transcript, meeting.timedWords);
    if (!aligned) return [{ text: meeting.transcript }];
    // Without a running diarizer nothing will arrive, so no word may wait for it.
    const diarizing =
      meeting.state === 'active' &&
      (meeting.speakerStatus === 'loading' || meeting.speakerStatus === 'ready');
    const rows: Array<SpeakerLine | { text: string; pending?: boolean }> = speakerLines(
      aligned.words,
      [
        ...(meeting.speakerTurns ?? []),
        ...(diarizing ? (meeting.tentativeSpeakerTurns ?? []) : []),
      ],
      meeting.speakerCorrections ?? [],
      meeting.speakerMerges ?? {},
      // Native builds without progress reports leave words pending only until the
      // first finalized turn arrives.
      diarizing
        ? (meeting.speakerHorizon ?? (meeting.speakerTurns?.length ? Infinity : 0))
        : Infinity,
    );
    if (aligned.tail) rows.push({ text: aligned.tail, pending: true });
    return rows;
  }
  const rows: Array<{ text: string }> = [];
  for (let start = 0; start < meeting.transcript.length; start += 900)
    rows.push({ text: meeting.transcript.slice(start, start + 900) });
  return rows;
}
