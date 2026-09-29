/** A sentence in which someone said "Verity". Whether it asks for something, and what, is left
 * to the server's model, so no language's phrasing is written down here. */
export interface VoiceMeetingCommand {
  utterance: string;
  complete: boolean;
  start: number;
}

const WAKE_WORD = /\bVerity\b/gi;
// A period ends a sentence only before a space, after a word longer than two letters: this keeps
// "Node.js", "3.5", "z.B." and "Dr. Müller" inside the request without a list of abbreviations.
// Joining too much only gives the model more to read; a period before the name always splits.
const SENTENCE_END = /[!?\n]|(?<=\p{L}{3}|\d)\.(?=\s|$)|\.(?=\s+Verity\b)/giu;
// Partial transcripts often lack punctuation; bound the sentence so one run-on line stays small.
const MAX_BEFORE = 200;
const MAX_UTTERANCE = 600;

function hasWords(text: string): boolean {
  return /\p{L}{2}/u.test(text.replace(WAKE_WORD, ''));
}

function sameUtterance(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/[.!?]+$/, '')
      .trim();
  if (normalize(a) === normalize(b)) return true;
  const words = (value: string) =>
    new Set(
      (value.toLocaleLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word !== 'verity'),
    );
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared >= 2 && shared / Math.min(left.size, right.size) >= 0.5;
}

export function voiceMeetingCommands(transcript: string): VoiceMeetingCommand[] {
  const commands: VoiceMeetingCommand[] = [];
  const ends = [...transcript.matchAll(SENTENCE_END)]
    .filter((match) => {
      if (match[0] !== '.') return true;
      const before = transcript.slice(0, match.index!).match(/(?:^|\s)(\p{Lu}\p{L}*)$/u)?.[1];
      const after = transcript.slice(match.index! + 1).match(/^\s+(\p{Lu}\p{L}*)/u)?.[1];
      return !(before && before.length <= 4 && after && after.toLowerCase() !== 'verity');
    })
    .map((match) => match.index!);
  let covered = 0;
  for (const wake of transcript.matchAll(WAKE_WORD)) {
    if (wake.index! < covered) continue;
    const previousEnd = ends.filter((end) => end < wake.index!).at(-1) ?? -1;
    const start = Math.max(previousEnd + 1, wake.index! - MAX_BEFORE);
    // "Verity. Recherchier mal …": a name said on its own belongs to the next sentence.
    let end = ends.find((candidate) => candidate >= wake.index!);
    if (end !== undefined && !hasWords(transcript.slice(wake.index!, end)))
      end = ends.find((candidate) => candidate > end!);
    let complete = end !== undefined;
    let utterance = transcript.slice(start, end === undefined ? undefined : end + 1);
    if (utterance.length > MAX_UTTERANCE) {
      utterance = utterance.slice(0, MAX_UTTERANCE);
      complete = true;
    }
    covered = start + utterance.length;
    const trimmed = utterance.trim();
    if (!hasWords(trimmed)) continue;
    commands.push({ utterance: trimmed, complete, start: start + utterance.indexOf(trimmed) });
  }
  return commands;
}

export class VoiceMeetingCommandDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: VoiceMeetingCommand | null = null;
  private consumed: VoiceMeetingCommand[] = [];
  private previousTranscript = '';
  private latestTranscript = '';
  private latestFinal = false;

  constructor(private readonly dispatch: (command: VoiceMeetingCommand) => void) {}

  observe(transcript: string, final: boolean): void {
    this.latestTranscript = transcript;
    this.latestFinal = final;
    const commands = this.unconsumed(transcript);
    const command = commands[0];
    if (!command) {
      this.clear();
      return;
    }
    if (final || command.complete) {
      this.clear();
      this.consumed.push(command);
      this.dispatch(command);
      if (commands.length > 1) this.observe(transcript, final);
      return;
    }
    if (
      this.pending?.start === command.start &&
      this.pending.utterance === command.utterance &&
      !final &&
      !command.complete
    )
      return;
    if (this.timer) clearTimeout(this.timer);
    this.pending = command;
    this.timer = setTimeout(() => this.flush(), 3000);
  }

  stop(): void {
    this.clear();
    this.consumed = [];
    this.previousTranscript = '';
    this.latestTranscript = '';
  }

  pause(transcript: string): void {
    this.unconsumed(transcript);
    this.consumed = voiceMeetingCommands(transcript);
    this.clear();
    this.latestTranscript = '';
  }

  private unconsumed(transcript: string): VoiceMeetingCommand[] {
    const commands = voiceMeetingCommands(transcript);
    const previous = this.previousTranscript;
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < transcript.length &&
      previous[prefix] === transcript[prefix]
    )
      prefix += 1;
    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < transcript.length - prefix &&
      previous[previous.length - 1 - suffix] === transcript[transcript.length - 1 - suffix]
    )
      suffix += 1;
    const matched = new Set<number>();
    const kept: VoiceMeetingCommand[] = [];
    for (const old of this.consumed) {
      const mappedStart =
        old.start < prefix
          ? old.start
          : old.start >= previous.length - suffix
            ? old.start + transcript.length - previous.length
            : old.start;
      let index = commands.findIndex(
        (candidate, position) => !matched.has(position) && candidate.utterance === old.utterance,
      );
      if (index < 0)
        index = commands.findIndex(
          (candidate, position) =>
            !matched.has(position) &&
            candidate.start === mappedStart &&
            sameUtterance(candidate.utterance, old.utterance),
        );
      if (index < 0) {
        const shiftedStart = old.start + transcript.length - previous.length;
        index = commands.findIndex(
          (candidate, position) =>
            !matched.has(position) &&
            Math.abs(candidate.start - shiftedStart) <= 12 &&
            sameUtterance(candidate.utterance, old.utterance),
        );
      }
      if (index < 0) continue;
      matched.add(index);
      kept.push(commands[index]!);
    }
    this.consumed = kept;
    this.previousTranscript = transcript;
    return commands.filter((_, index) => !matched.has(index));
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private flush(): void {
    const command = this.pending;
    const transcript = this.latestTranscript;
    const final = this.latestFinal;
    this.clear();
    if (!command) return;
    const current = this.unconsumed(transcript).find(
      (candidate) => candidate.start === command.start,
    );
    if (!current) return;
    this.consumed.push(current);
    this.dispatch(current);
    this.observe(transcript, final);
  }
}
