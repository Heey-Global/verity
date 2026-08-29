import { jsonrepair } from 'jsonrepair';
import { choicesPayloadSchema, type ChoicesPayload } from './events.js';

/**
 * The end-of-turn "Quick-Action chips" contract (issue #97, Path B).
 *
 * Headless `claude` does not fire the native `AskUserQuestion` tool — it falls
 * back to prose `A) / B)` questions. Rather than heuristically scrape those
 * (false-positive-prone), Verity instructs the agent (via an appended system
 * prompt, {@link CHOICES_SYSTEM_PROMPT}) to append a machine-readable fenced
 * block whenever it poses a decision. The adapter parses that block off the
 * agent's final text ({@link parseChoicesBlock}) into a canonical `choices`
 * event; the app renders tappable chips and a tap sends the chosen label as a
 * normal new turn. The format is OUR contract, so parsing is reliable — no
 * runtime-specific scraping leaks downstream of the adapter.
 *
 * This module is the single source of truth for the contract: the prompt that
 * tells the agent what to emit and the parser that reads it live together so the
 * two can never drift.
 */

/** The info-string tag that opens the contract's fenced block. */
export const CHOICES_FENCE_TAG = 'verity:choices';

/**
 * Matches a ` ```verity:choices ` fenced block and captures its body. Lazy so it
 * stops at the first closing fence; tolerant of CRLF and trailing spaces on the
 * opener. Global so {@link parseChoicesBlock} can find EVERY block: the contract
 * says emit at most one, but when several slip through we honor the last and
 * strip them all so a stray block never leaks downstream as raw JSON.
 */
const CHOICES_FENCE_RE = /```verity:choices[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;

const YES_NO_QUESTION_START_RE =
  /^(?:soll(?:en)?|kann(?:st| ich|st du| man| es)?|könn(?:en|test|te)|darf(?: ich|st du| man)?|dürf(?:en|te|test)|möchtest|möchten|willst|wollen|ist|sind|wäre|wärst|würdest|should|shall|can|could|would|do|does|did|is|are|was|were|will|may|might|must|commit|push|proceed|continue|open)\b/i;

const OPEN_QUESTION_START_RE =
  /^(?:what|which|who|whom|whose|when|where|why|how|welche(?:r|s|n|m)?|wer|wen|wem|wessen|wann|wo|warum|wieso|weshalb|wie)\b/i;

const OPEN_QUESTION_ANYWHERE_RE =
  /\b(?:what|which|who|whom|whose|when|where|why|how|welche(?:r|s|n|m)?|wer|wen|wem|wessen|wann|wo|warum|wieso|weshalb|wie|or|oder)\b/i;

const ENGLISH_WAS_QUESTION_RE =
  /^was\s+(?:i|it|he|she|we|you|they|there|this|that|the|a|an|your|my|our|their)\b/i;

/** Result of scanning an agent text block for the choices contract. */
export interface ParsedChoices {
  /**
   * The prose to render: the input with EVERY `verity:choices` fence removed and
   * trailing whitespace trimmed, once a block is honored. When no block is
   * honored the input is returned verbatim, so a lone malformed block degrades to
   * visible plain text rather than being dropped. Note the asymmetry: a malformed
   * fence sitting ALONGSIDE a valid one is stripped with the rest — fence bodies
   * are machine contract data, not prose, so once chips surface no fence (valid
   * or not) is left behind to leak downstream as a raw-JSON code card.
   */
  text: string;
  /** The parsed decision, present only when a well-formed block was found. */
  choices?: ChoicesPayload;
}

/**
 * Parse the fence body into JSON, tolerating the malformations LLMs reliably
 * produce in the human-facing question/label text. The dominant one (observed
 * live, mobile screenshot): an UNESCAPED double-quote inside a string value —
 * German `„…"` quoting or any quoted phrase the agent forgot to escape — which
 * terminates the JSON string early and makes strict `JSON.parse` throw. Strict
 * parse first (the happy path, zero cost); only on failure fall back to
 * {@link jsonrepair}, which closes unescaped quotes, trailing commas, and the
 * like. The repaired value is still validated against {@link choicesPayloadSchema}
 * by the caller, so a mis-repair that yields the wrong shape degrades to raw text
 * exactly as before — the fallback can only RECOVER a block, never corrupt a turn.
 * Returns `undefined` when neither parse yields a value (no valid JSON document
 * ever parses to `undefined`, so it is a safe miss sentinel).
 */
function parseLenientJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    // Strict parse failed — fall through to the tolerant repair pass.
  }
  try {
    return JSON.parse(jsonrepair(body));
  } catch {
    return undefined;
  }
}

function lastNonEmptyLine(input: string): string | undefined {
  const lines = input.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line !== undefined && line.length > 0) return line;
  }
  return undefined;
}

function synthesizeYesNoChoices(input: string): ChoicesPayload | undefined {
  const line = lastNonEmptyLine(input);
  if (line === undefined || !line.endsWith('?')) return undefined;
  if (line.startsWith('```') || line.startsWith('>')) return undefined;

  const question = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
  if (!ENGLISH_WAS_QUESTION_RE.test(question) && /\bwas\b/i.test(question)) return undefined;
  if (OPEN_QUESTION_START_RE.test(question)) return undefined;
  if (OPEN_QUESTION_ANYWHERE_RE.test(question)) return undefined;
  if (!YES_NO_QUESTION_START_RE.test(question)) return undefined;

  return {
    question,
    options: [{ label: 'Ja', recommended: true }, { label: 'Nein' }],
    multiSelect: false,
  };
}

/**
 * Lift a {@link ChoicesPayload} off the contract block(s) in an agent text block,
 * returning the prose (block(s) removed, surrounding text rejoined) plus the
 * parsed choices. The contract instructs the agent to emit ONE block, last — but
 * an agent occasionally slips and emits two (e.g. an illustrative example plus
 * the real question). We honor the LAST well-formed block, because "append one
 * final block" makes the trailing one the operative decision and an earlier one
 * the stray. The match is position-independent on purpose: a block the agent puts
 * mid-message is still lifted rather than shown as raw JSON. The body is parsed
 * leniently ({@link parseLenientJson}) so a near-miss like an unescaped quote in
 * the question still renders as chips.
 *
 * Once ANY block surfaces as chips, EVERY `verity:choices` fence is stripped from
 * the prose — a second/stray block must never leak downstream, where the renderer
 * would show it as raw JSON in a code card. When NO block parses (a lone,
 * un-repairable, or schema-invalid block) the input is returned verbatim, so a
 * botched block degrades to visible prose rather than being silently dropped —
 * the contract is best-effort and never errors the turn.
 */
export function parseChoicesBlock(input: string): ParsedChoices {
  const matches = [...input.matchAll(CHOICES_FENCE_RE)];
  if (matches.length === 0) {
    const choices = synthesizeYesNoChoices(input);
    if (choices !== undefined) return { text: input, choices };
    return { text: input };
  }

  // Honor the last block that parses to a valid payload (the operative one).
  let choices: ChoicesPayload | undefined;
  for (let i = matches.length - 1; i >= 0 && choices === undefined; i--) {
    const parsedJson = parseLenientJson(matches[i]![1] ?? '');
    if (parsedJson === undefined) continue;
    const result = choicesPayloadSchema.safeParse(parsedJson);
    if (result.success) choices = result.data;
  }

  // No block parsed — degrade to verbatim prose (a malformed block stays visible
  // rather than vanishing), matching the best-effort contract.
  if (choices === undefined) return { text: input };

  // A block surfaced as chips — strip every fence (valid or not) from the prose,
  // right-to-left so earlier match indices stay valid, so none leaks as raw JSON.
  let text = input;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!;
    text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  }
  return { text: text.trimEnd(), choices };
}

/**
 * Render the operator's selection back into the prompt sent as the next turn.
 * A single tap sends just that label; a multi-select confirm joins the chosen
 * labels so the agent reads them as one comma-separated answer.
 */
export function formatChoiceAnswer(labels: readonly string[]): string {
  return labels.join(', ');
}

/**
 * Appended to a live Claude process when it starts so the agent emits the
 * {@link CHOICES_FENCE_TAG} contract block when it poses a decision. Kept terse
 * and adjacent to {@link parseChoicesBlock} so the instructed format and the
 * parsed format stay in lockstep.
 */
export const CHOICES_SYSTEM_PROMPT = `# Quick-Action choices (Verity)

When your final response asks the operator to choose, approve, or give a go-ahead, append one final \`${CHOICES_FENCE_TAG}\` block. This is mandatory for yes/no approval questions such as "Soll ich ...?", "Should I ...?", "Commit?", "Push?", or "Open a PR?":

\`\`\`${CHOICES_FENCE_TAG}
{"question":"<the question, optional>","options":[{"label":"<short option label>","recommended":true},{"label":"<short option label>"}],"multiSelect":false}
\`\`\`

Use concrete short labels because each label is sent verbatim as the user's next message. Prefer action labels such as "Implement local fix" or "Refactor shared module" when the choice selects an approach; use "Ja" / "Nein" only when the preceding question makes the authorized action unambiguous. For a remote-workflow approval, use labels such as "Push + PR" / "Nicht pushen". A selected label is an instruction to execute that option, so proceed without asking for the same confirmation again. Offer only actions you can actually perform.

Do not use a Quick Action to defer work already authorized by the user's request. If the user asked you to solve a problem and one small, low-risk solution is clear, implement it instead of asking whether to implement it. Use choices when the user must make a genuine consequential decision, including materially different solution approaches, a larger change in scope, or a risky or difficult-to-reverse action.

Mark at most one option recommended. Set \`multiSelect:false\` (the default) for almost every prompt: a single tap then sends the option immediately. Set \`multiSelect:true\` ONLY when the options are additive and the operator would genuinely pick several at once (e.g. "which files to include") — this adds a two-step confirm (tap to select, then a separate Send button), so never use it for mutually exclusive choices, go-aheads, or "pick one to start" prompts. Skip pure status updates, open-ended brainstorming, and the final merge decision on an open PR (the PR status/merge bar handles that). When not already authorized, a go-ahead to commit, review, push, or open a PR is still a decision, so emit the block for those; when the user already requested the action, execute it without another choice. Do not write check-only status prose or poll/monitor PR checks/CI with tools such as \`gh pr checks\` unless explicitly asked; Verity refreshes that status. Valid JSON only: double-quoted keys/strings, no trailing commas, and escape inner double-quotes as \\".`;
