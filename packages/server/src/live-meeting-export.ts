import type {
  LiveMeetingInsight,
  LiveMeetingNoteSyncRecord,
  LiveMeetingSyncRecord,
} from '@verity/store';

type Meeting = Omit<LiveMeetingSyncRecord, 'ownerTokenHash'>;
type TimedWord = { text: string; start: number; end: number };
type SpeakerTurn = { speaker: number; start: number; end: number };
type SpeakerCorrection = { start: number; end: number; speaker: number | null };

interface SpeakerLine {
  speaker: number | null;
  text: string;
  start: number;
  end: number;
}

// Server copy of apps/mobile/lib/liveMeetingSpeakers.ts. The filed transcript must
// attribute words exactly as the meeting screen did, so keep the two in step.
function resolvedSpeaker(speaker: number | null, merges: Record<string, number>): number | null {
  if (speaker === null) return null;
  const seen = new Set<number>();
  while (merges[speaker] !== undefined && !seen.has(speaker)) {
    seen.add(speaker);
    speaker = merges[speaker]!;
  }
  return seen.has(speaker) ? null : speaker;
}

function reconcileTimedTranscript(
  transcript: string,
  words: TimedWord[],
): { words: TimedWord[]; tail: string } | null {
  const transcriptWords = [...transcript.matchAll(/\S+/gu)];
  const comparable = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let index = 0;
  const aligned = words.map((word) => {
    const spoken = word.text.match(/\S+/gu) ?? [];
    const first = transcriptWords[index];
    for (const token of spoken) {
      if (!transcriptWords[index] || comparable(token) !== comparable(transcriptWords[index]![0]))
        return null;
      index++;
    }
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

function speakerLines(
  words: TimedWord[],
  turns: SpeakerTurn[],
  corrections: SpeakerCorrection[],
  merges: Record<string, number>,
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

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Collapses line breaks so meeting text cannot open a Markdown heading or list. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** For text that starts its own line: also keeps its first word from being markup. */
function paragraph(text: string): string {
  return inline(text).replace(/^(#|>|[-*+](?=\s)|\d+[.)](?=\s))/, '\\$1');
}

export function liveMeetingTitle(meeting: Pick<Meeting, 'startedAt'>): string {
  const started = new Date(meeting.startedAt).toISOString();
  return `Live meeting ${started.slice(0, 10)} ${started.slice(11, 16)} UTC`;
}

export function renderLiveMeetingMarkdown(input: {
  meeting: Meeting;
  notes: LiveMeetingNoteSyncRecord[];
  insights: LiveMeetingInsight[];
}): string {
  const { meeting } = input;
  const names = meeting.speakerNames ?? {};
  const label = (speaker: number | null) =>
    speaker === null ? 'Unknown speaker' : inline(names[speaker] ?? `Speaker ${speaker + 1}`);

  const rows: Array<{ speaker: string | null; at: number | null; text: string }> = [];
  const aligned = meeting.timedWords?.length
    ? reconcileTimedTranscript(meeting.transcript, meeting.timedWords)
    : null;
  if (aligned) {
    for (const line of speakerLines(
      aligned.words,
      meeting.speakerTurns ?? [],
      meeting.speakerCorrections ?? [],
      meeting.speakerMerges ?? {},
    ))
      rows.push({ speaker: label(line.speaker), at: line.start, text: line.text });
    if (aligned.tail) rows.push({ speaker: 'Speaker pending', at: null, text: aligned.tail });
  } else if (meeting.transcript.trim()) {
    rows.push({ speaker: null, at: null, text: meeting.transcript });
  }

  const header = [`# ${liveMeetingTitle(meeting)}`, ''];
  header.push(`- Date: ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`);
  if (meeting.endedAt !== null && meeting.endedAt > meeting.startedAt)
    header.push(`- Duration: ${clock((meeting.endedAt - meeting.startedAt) / 1000)}`);
  const speakers = [...new Set(rows.flatMap((row) => (row.speaker ? [row.speaker] : [])))].filter(
    (speaker) => speaker !== 'Speaker pending',
  );
  if (speakers.length) header.push(`- Speakers: ${speakers.join(', ')}`);
  header.push('- Source: live meeting recording (audio not kept)');
  if (meeting.state === 'interrupted')
    header.push('- Status: the recording was interrupted; the transcript may be incomplete');

  const sections: string[][] = [header];
  if (input.insights.length) {
    const lines = ['## Verity insights', ''];
    for (const insight of [...input.insights].sort((a, b) => a.createdAt - b.createdAt)) {
      const kind = insight.kind === 'contradiction' ? 'Possible contradiction' : 'Worth checking';
      lines.push(`- **${kind}:** ${inline(insight.summary)}`);
      lines.push(`  - "${inline(insight.evidenceA)}"`);
      if (insight.evidenceB) {
        const source = insight.sourcePath ? ` (${inline(insight.sourcePath)})` : '';
        lines.push(`  - "${inline(insight.evidenceB)}"${source}`);
      }
    }
    sections.push(lines);
  }
  const notes = input.notes
    .filter((note) => note.text.trim())
    .sort((a, b) => a.atSeconds - b.atSeconds);
  if (notes.length) {
    sections.push([
      '## Notes',
      '',
      ...notes.map((note) => `- (${clock(note.atSeconds)}) ${inline(note.text)}`),
    ]);
  }
  const transcript = ['## Transcript', ''];
  if (!rows.length) transcript.push('_Nothing was transcribed._', '');
  for (const row of rows) {
    const text = inline(row.text);
    if (!row.speaker) transcript.push(paragraph(row.text), '');
    else if (row.at === null) transcript.push(`**${row.speaker}:** ${text}`, '');
    else transcript.push(`**${row.speaker}** (${clock(row.at)}): ${text}`, '');
  }
  sections.push(transcript);
  return `${sections
    .map((lines) => lines.join('\n').trimEnd())
    .join('\n\n')
    .trimEnd()}\n`;
}

export function liveMeetingSavedMessage(link: string, title: string): string {
  return `Meeting saved to the knowledge base: [${title}](${link})`;
}
