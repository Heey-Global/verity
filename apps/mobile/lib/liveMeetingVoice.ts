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
  /^(?:(?:äh+m?|ähm|öh+m?|hm+|uh+m?|um+|also|okay|ok|bitte|please|mal|sag mal|hey|mach(?:e|st du)?|kannst du|könntest du|würdest du|can you|could you|would you)\b[\s,.]*)*/i;
const MODAL = /\b(?:kannst|könntest|würdest|can|could|would) (?:du|you)\b/i;
// Imperatives only: nouns and statements ("Recherche ergab …", "Google hat …") stay speech,
// and "schau mal, …" only asks when a question or object follows, not to get attention.
// The meeting runs German speech recognition, so German phrasings matter as much as English.
const RESEARCH =
  /^(?:recherchier\w*|research\b(?!\s+(?:shows?|showed|says|suggests|found|finds|indicates)\b)|(?:über)?prüf(?:e|en|st)?\b|check(?:e|en|st)?\b(?!-)|verifizier\w*|(?:(?:nach)?schau(?:e|en|st)?|guck(?:e|en|st)?)\b(?=(?:\s+(?:mal|bitte|doch|kurz))*[\s,]+(?:nach|ob|wie|was|wer|wo|wann|welche\w*|warum|wieso|in|im|auf|bei)\b)|such(?:e|en|st)?\b(?=\s+(?:mal|bitte|doch|nach|die|den|das|dem|ein\w*|uns|mir)\b)|find(?:e|est)?(?:\s+(?:mal|bitte|doch))*\s+(?:her|r)aus\b|(?:her|r)ausfinden\b|schlag(?:e)?(?:\s+(?:mal|bitte|doch))*\s+nach\b|nachschlagen\b|find out|look up|look into)/i;
const OPINION =
  /^(?:was (?:hältst|meinst|denkst|sagst) du|wie (?:siehst|findest|bewertest|beurteilst|schätzt) du|(?:was ist|wie ist|gib mir) deine (?:einschätzung|meinung|sicht)|bewert(?:e)?\b|beurteil(?:e)?\b|schätz(?:e)?\b|erklär(?:e)?\b|fass(?:e)?(?:\s+(?:mal|bitte|kurz|uns|doch))*\s+zusammen\b|stimmt (?:das|es)\b|ist (?:das|es) (?:realistisch|richtig|korrekt|plausibel)\b|what do you think|what's your take|how do you see|explain\b|summari[sz]e\b|is (?:that|this|it) (?:right|correct|realistic)\b)/i;
// After the wake word an -en verb is a statement ("Verity, prüfen wir morgen") or an idiom
// ("mal schauen, ob …"); it asks only after "kannst du …". Likewise a verb followed by ich/wir
// is a fronted statement ("Verity schätze ich auf drei Wochen").
const INFINITIVE =
  /^(?:recherchieren|(?:über)?prüfen|checken|verifizieren|(?:nach)?schauen|gucken|suchen)\b/i;
const STATEMENT_SUBJECT = /^[\s,]*(?:ich|wir)\b/i;
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

function requestVerb(request: string) {
  const leadIn = LEAD_IN.exec(request)?.[0] ?? '';
  const intent = request.slice(leadIn.length);
  if (INFINITIVE.test(intent) && !MODAL.test(leadIn)) return { intent, match: null };
  const research = RESEARCH.exec(intent);
  const match = research ?? OPINION.exec(intent);
  if (match && STATEMENT_SUBJECT.test(intent.slice(match[0].length)))
    return { intent, match: null };
  return { intent, match, research: Boolean(research) };
}

function requestKind(request: string): VoiceMeetingCommand['kind'] | null {
  const { intent, match, research } = requestVerb(request);
  if (!match) return null;
  const remainder = intent
    .slice(match[0].length)
    .replace(/^[\s,]*(?:mal\s+)?/i, '')
    .trim();
  if (remainder.length < 3 || intent.length < 12) return null;
  return research ? 'research' : 'opinion';
}

// A request cut off at a later wake word must not end mid-clause; if it does, that "Verity"
// is the product being talked about, not a second request.
const DANGLING_END =
  /(?:^|[\s,])(?:whether|if|how|what|who|why|when|where|which|about|of|for|to|with|on|in|at|the|a|an|and|or|that|ob|wie|was|wer|warum|wann|wo|welche\w*|über|von|für|mit|zu|bei|dass|der|die|das|den|dem|des|ein\w*|und|oder)$/i;

function isBareStart(request: string): boolean {
  const { intent, match } = requestVerb(request);
  return !intent.slice(match?.[0].length ?? 0).trim();
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
    let request = (terminator < 0 ? following : following.slice(0, terminator)).trim();
    let complete = terminator >= 0;
    if (requestStart + request.length > nextCommandStart) {
      const before = transcript
        .slice(requestStart, nextCommandStart)
        .replace(/[\s,;:-]+$/, '')
        .trim();
      if (!requestKind(before)) {
        // What came before the later wake was no request yet: the speaker restarted.
        if (isBareStart(before)) nextCommandStart = wake.index!;
        continue;
      }
      if (commands.length > 0 && !DANGLING_END.test(before)) {
        // Two requests in one breath ("Verity, prüfe X Verity, recherchiere Y") both go out.
        request = before;
        complete = true;
      } else {
        // "…say about Verity" or "whether Verity summarize…" names the product mid-request.
        const tail = transcript.slice(nextCommandStart).replace(WAKE_WORD, '').trim();
        // A trailing "Verity äh" is the start of another request, not part of this one.
        if (!commands.length && tail && isBareStart(tail)) request = before;
        if (request.length > 240) continue;
        while (commands.length && commands[0]!.start < requestStart + request.length)
          commands.shift();
      }
    }
    if (request.length > 240) continue;
    const kind = requestKind(request);
    if (!kind) {
      // A bare "Verity" (maybe with "äh" or just the verb) may start a restarted request.
      if (terminator < 0 && isBareStart(request)) nextCommandStart = wake.index!;
      continue;
    }
    commands.unshift({ kind, request, complete, start: wake.index! });
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
