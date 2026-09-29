export interface VoiceMeetingCommand {
  kind: 'research' | 'opinion';
  request: string;
  complete: boolean;
  start: number;
}

const WAKE_WORD = /\bVerity\b[\s,:-]*/gi;
// Spoken requests open with hesitations and politeness before the verb:
// "Verity, äh mach mal bitte Research …", "Verity, kannst du mal schauen, …".
const LEAD_IN =
  /^(?:(?:äh+m?|ähm|öh+m?|hm+|uh+m?|um+|also|okay|ok|bitte|please|mal|mach(?:e|st du)?|kannst du|könntest du|würdest du|can you|could you|would you)\b[\s,.]*)*/i;
// Imperatives only: nouns and statements ("Recherche ergab …", "Google hat …") stay speech.
const RESEARCH =
  /^(?:recherchier\w*|research\b|(?:über)?prüf(?:e|en|st)?\b|check\b|verifizier\w*|(?:nach)?schau(?:e|en|st)?\b|guck(?:e|en|st)?\b|such(?:e|en|st)\b|finde? heraus|find out|look up|look into)/i;
const OPINION = /^(?:was hältst du|wie siehst du|was ist deine einschätzung|what do you think)\b/i;
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'etc', 'vs']);

function sentenceEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n' || character === '?' || character === '!') return index;
    if (character !== '.' || (index + 1 < text.length && !/\s/.test(text[index + 1]!))) continue;
    const word = text.slice(0, index).match(/[\p{L}\p{N}]+$/u)?.[0] ?? '';
    if (word.length > 1 && !ABBREVIATIONS.has(word.toLocaleLowerCase())) return index;
  }
  return -1;
}

function requestKind(request: string): VoiceMeetingCommand['kind'] | null {
  const intent = request.slice(LEAD_IN.exec(request)?.[0].length ?? 0);
  const research = RESEARCH.exec(intent);
  const match = research ?? OPINION.exec(intent);
  if (!match) return null;
  const remainder = intent
    .slice(match[0].length)
    .replace(/^[\s,]*(?:mal\s+)?/i, '')
    .trim();
  if (remainder.length < 3 || intent.length < 12) return null;
  return research ? 'research' : 'opinion';
}

/** Only explicit, limited requests may leave the microphone as session turns. */
function voiceMeetingCommands(transcript: string): VoiceMeetingCommand[] {
  const wakes = [...transcript.matchAll(WAKE_WORD)];
  const commands: VoiceMeetingCommand[] = [];
  // Walk backwards so a restarted request ("Verity, äh … Verity, research X") ends the
  // abandoned one instead of sending both.
  let nextCommandStart = transcript.length;
  for (let position = wakes.length - 1; position >= 0; position -= 1) {
    const wake = wakes[position]!;
    const requestStart = wake.index! + wake[0].length;
    const following = transcript.slice(requestStart);
    const terminator = sentenceEnd(following);
    const request = (terminator < 0 ? following : following.slice(0, terminator)).trim();
    if (requestStart + request.length > nextCommandStart) {
      // A later wake inside this request is a restart only if what came before it was no
      // request yet; "research how Verity checks invoices" names the product instead.
      if (!requestKind(transcript.slice(requestStart, nextCommandStart).trim())) continue;
      while (commands.length && commands[0]!.start < requestStart + request.length)
        commands.shift();
    }
    if (request.length > 240) continue;
    const kind = requestKind(request);
    if (!kind) {
      // A bare "Verity" (maybe with "äh") may be the start of a restarted request.
      if (terminator < 0 && !request.slice(LEAD_IN.exec(request)?.[0].length ?? 0).trim())
        nextCommandStart = wake.index!;
      continue;
    }
    commands.unshift({ kind, request, complete: terminator >= 0, start: wake.index! });
    nextCommandStart = wake.index!;
  }
  return commands;
}

export function latestVoiceMeetingCommand(transcript: string): VoiceMeetingCommand | null {
  return voiceMeetingCommands(transcript).at(-1) ?? null;
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
      this.pending.request === command.request &&
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
        (candidate, position) =>
          !matched.has(position) && candidate.kind === old.kind && candidate.start === mappedStart,
      );
      if (index < 0)
        index = commands.findIndex(
          (candidate, position) =>
            !matched.has(position) &&
            candidate.kind === old.kind &&
            candidate.request === old.request,
        );
      if (index < 0) {
        const shiftedStart = old.start + transcript.length - previous.length;
        index = commands.findIndex(
          (candidate, position) =>
            !matched.has(position) &&
            candidate.kind === old.kind &&
            Math.abs(candidate.start - shiftedStart) <= 12,
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
