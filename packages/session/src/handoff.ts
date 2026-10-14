import type { AgentEvent } from '@verity/events';

/**
 * Cross-backend context handoff (concept: model-switch continuity).
 *
 * Each backend (claude, codex, opencode) has its OWN native transcript format;
 * those formats are mutually incompatible, so switching backend (e.g. Claude →
 * Codex) cannot carry history natively. Verity keeps only one active backend
 * handle per session, and uses the append-only `events` log as the backend-neutral
 * record of the conversation. When a fresh backend session starts on a session
 * that already has history, we serialize that history into a text preamble and
 * prepend it to the turn's prompt — every backend accepts a prompt string, so this
 * is universal.
 *
 * Within a backend (e.g. Claude Opus → Sonnet) no handoff is needed: the native
 * `--resume` already carries the full context. A returning backend also receives
 * the history gap since its last recorded context cursor.
 *
 * Budgeting (see defaults): prioritize the latest instruction and assistant outcome,
 * then recent exchanges and relevant older context. Keep tool calls with their
 * results, and cap each exchange so a giant output cannot consume the history.
 * Images are noted as placeholders — re-inlining them cross-backend is a later
 * enhancement.
 */

export interface HandoffOptions {
  workspaceChanged?: boolean;
  /** Approximate history ceiling (chars/4); framing and the current prompt are separate. */
  tokenBudget?: number;
  /** Per-tool-result char cap in the serialized history. */
  toolResultCharCap?: number;
  /** Max share of the history budget reserved for relevant older context. */
  retrievalBudgetRatio?: number;
}

const DEFAULT_TOKEN_BUDGET = 25_000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOOL_RESULT_CHAR_CAP = 12_000;
const TOOL_INPUT_SUMMARY_CAP = 4_000;
const DEFAULT_RETRIEVAL_BUDGET_RATIO = 0.25;
const MAX_RETRIEVAL_CHARS = 8_000;
const MAX_STORED_RESULT_BYTES = 256 * 1024;
const MAX_STORED_RESULT_TOTAL_BYTES = 1024 * 1024;
const MAX_STORED_RESULT_READS = 16;
const RETRIEVAL_HEADER = '**Relevant earlier context:**';
const RECENT_HEADER = '**Most recent context:**';

interface HandoffBlock {
  text: string;
  kind: 'prompt' | 'assistant' | 'tool';
  resultIndex?: number;
}
interface HandoffSelection {
  blocks: Map<number, string>;
  retrieved: Set<number>;
  omitted: boolean;
}

type StoredResultReader = (
  id: string,
  maxBytes: number,
) => Promise<{ mediaType: string; bytes: Uint8Array } | undefined>;
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'before',
  'could',
  'did',
  'does',
  'for',
  'from',
  'have',
  'how',
  'into',
  'our',
  'please',
  'should',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'you',
]);

const HEADER =
  'The following is the earlier part of THIS session — your own prior work, done ' +
  'while the session ran on a different model/engine. That engine has stopped: you ' +
  'are now the sole agent on this session, branch, and worktree, and no other agent ' +
  'is working here concurrently. Any commits, branch changes, or files from that ' +
  "earlier work are yours — don't mistake them for a separate agent's concurrent " +
  'edits. Continue seamlessly. Tool outputs below may be truncated — re-run a tool ' +
  'or re-read a file if you need its current contents.';
const MOVED_HEADER =
  'The following is the earlier part of THIS session — your own prior work. ' +
  'You are the sole agent continuing this session. Continue from this history using the current project and workspace instructions. ' +
  'Earlier paths, branches, and files may belong to a previous workspace; consult ' +
  'any project move notice and verify their current location before using them. ' +
  'Tool outputs below may be truncated — re-run a tool or re-read a file when needed.';
const CURRENT_MARKER = "Now respond to the operator's latest message:";

/**
 * Build the prompt for a fresh backend session: a serialized transcript of
 * `priorEvents` (most recent within budget) followed by `currentPrompt`. Returns
 * `currentPrompt` unchanged when there is no meaningful prior history — so a
 * brand-new session's first turn is unaffected. Pure and side-effect-free.
 */
export function buildHandoffPrompt(
  priorEvents: readonly AgentEvent[],
  currentPrompt: string,
  opts: HandoffOptions = {},
): string {
  const blocks = serializeEvents(
    priorEvents,
    opts.toolResultCharCap ?? DEFAULT_TOOL_RESULT_CHAR_CAP,
  );
  const selection = selectBlocks(blocks, currentPrompt, opts);
  if (selection.blocks.size === 0) return currentPrompt;
  const ordered = [...selection.blocks].sort(([a], [b]) => a - b);
  const selected =
    selection.retrieved.size === 0
      ? ordered.map(([, text]) => text)
      : [
          RETRIEVAL_HEADER,
          ...ordered.filter(([index]) => selection.retrieved.has(index)).map(([, text]) => text),
          RECENT_HEADER,
          ...ordered.filter(([index]) => !selection.retrieved.has(index)).map(([, text]) => text),
        ];
  return renderHandoffPrompt(
    selected,
    selection.omitted,
    currentPrompt,
    opts.workspaceChanged ? MOVED_HEADER : HEADER,
  );
}

/** Only selected history may load stored outputs. Limits apply to actual blob bytes,
 * not just the reference metadata, and reads stay sequential to bound peak memory. */
export async function buildHandoffPromptWithStoredResults(
  priorEvents: readonly AgentEvent[],
  currentPrompt: string,
  read: StoredResultReader,
  opts: HandoffOptions = {},
): Promise<string> {
  const blocks = serializeEvents(
    priorEvents,
    opts.toolResultCharCap ?? DEFAULT_TOOL_RESULT_CHAR_CAP,
  );
  const selected = selectBlocks(blocks, currentPrompt, opts);
  const events = [...priorEvents];
  let remainingBytes = MAX_STORED_RESULT_TOTAL_BYTES;
  let reads = 0;
  for (const index of [...selected.blocks.keys()].sort((a, b) => b - a)) {
    const eventIndex = blocks[index]?.resultIndex;
    if (eventIndex === undefined) continue;
    const event = events[eventIndex];
    if (event?.t !== 'tool_result' || event.outputRef === undefined) continue;
    const maxBytes = Math.min(MAX_STORED_RESULT_BYTES, remainingBytes);
    let reason = 'handoff read limit';
    if (event.outputRef.bytes <= maxBytes && reads < MAX_STORED_RESULT_READS) {
      reads++;
      try {
        const blob = await read(event.outputRef.id, maxBytes);
        if (blob === undefined) {
          reason = 'stored body missing or exceeds read limit';
        } else if (blob.bytes.byteLength > maxBytes) {
          reason = 'stored body exceeds read limit';
        } else {
          remainingBytes -= blob.bytes.byteLength;
          if (blob.mediaType !== 'application/json') throw new Error('invalid stored body type');
          const output: unknown = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
          if (typeof output !== 'string' && !Array.isArray(output)) {
            throw new Error('invalid stored output shape');
          }
          const inline = { ...event };
          delete inline.outputRef;
          events[eventIndex] = { ...inline, output };
          continue;
        }
      } catch {
        reason = 'stored body unavailable or invalid';
      }
    }
    const inline = { ...event };
    delete inline.outputRef;
    events[eventIndex] = {
      ...inline,
      output: `${previewOutput(event.output, opts.toolResultCharCap ?? DEFAULT_TOOL_RESULT_CHAR_CAP)}\n[stored tool result: preview only; ${reason}]`,
    };
  }
  // Full results can occupy more space than their persisted previews. Re-budget
  // after loading so hydration cannot crowd out the latest instruction or outcome.
  return buildHandoffPrompt(events, currentPrompt, opts);
}

/** Keep exchanges together even when parallel calls interleave. A completed
 * exchange is placed at its result; unmatched calls remain at their call position. */
function serializeEvents(events: readonly AgentEvent[], toolResultCap: number): HandoffBlock[] {
  const blocks: HandoffBlock[] = [];
  const calls = new Map<string, HandoffBlock>();
  let textBuf = '';
  const flushText = (): void => {
    const trimmed = textBuf.trim();
    if (trimmed.length > 0) blocks.push({ text: `**Assistant:**\n${trimmed}`, kind: 'assistant' });
    textBuf = '';
  };
  for (const [eventIndex, event] of events.entries()) {
    switch (event.t) {
      case 'prompt': {
        flushText();
        const text = event.text.trim();
        if (text.length > 0) blocks.push({ text: `**Operator:**\n${text}`, kind: 'prompt' });
        break;
      }
      case 'text':
        if (event.parentToolId === undefined) textBuf += event.delta;
        break;
      case 'tool_call':
        if (event.parentToolId === undefined) {
          flushText();
          const block: HandoffBlock = {
            text: `**Tool call — ${event.name}:** [id: ${event.id}] ${summarizeInput(event.input)}`,
            kind: 'tool',
          };
          blocks.push(block);
          calls.set(event.id, block);
        }
        break;
      case 'tool_result':
        if (event.parentToolId === undefined) {
          flushText();
          const call = calls.get(event.id);
          const callText = call?.text;
          if (call !== undefined) call.text = '';
          calls.delete(event.id);
          const label = event.isError ? 'Tool result (error)' : 'Tool result';
          const storedNote =
            event.outputRef === undefined ? '' : '\n[stored tool result: preview only]';
          blocks.push({
            text: `${callText ? `${callText}\n\n` : ''}**${label}:**\n${previewOutput(event.output, toolResultCap)}${storedNote}\n[tool call id: ${event.id}]`,
            kind: 'tool',
            resultIndex: eventIndex,
          });
        }
        break;
      default:
        break;
    }
  }
  flushText();
  return blocks.filter((block) => block.text.length > 0);
}

function blockCost(text: string): number {
  return text.length + 2; // Include separators in the history budget.
}

function selectBlocks(
  blocks: HandoffBlock[],
  currentPrompt: string,
  opts: HandoffOptions,
): HandoffSelection {
  const budget = Math.max(
    0,
    Math.floor((opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN),
  );
  const selected = new Map<number, string>();
  const retrieved = new Set<number>();
  if (budget === 0 || blocks.length === 0)
    return { blocks: selected, retrieved, omitted: blocks.length > 0 };
  if (blocks.reduce((sum, block) => sum + blockCost(block.text), 0) <= budget) {
    return {
      blocks: new Map(blocks.map((block, index) => [index, block.text])),
      retrieved,
      omitted: false,
    };
  }

  const latest = (kind: HandoffBlock['kind']) =>
    blocks.findLastIndex((block) => block.kind === kind);
  const primary = [latest('prompt'), latest('assistant')]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  // Reserve room for recent evidence even when a single instruction is enormous.
  let primaryRoom =
    primary.length > 0 && Math.max(...primary) < blocks.length - 1
      ? Math.floor(budget * 0.75)
      : budget;
  const pending = [...primary].sort(
    (a, b) => (blocks[a]?.text.length ?? 0) - (blocks[b]?.text.length ?? 0),
  );
  for (const [position, index] of pending.entries()) {
    const block = blocks[index];
    if (block === undefined) continue;
    const cap = Math.max(0, Math.floor(primaryRoom / (pending.length - position)) - 2);
    const text = truncateMiddle(block.text, cap);
    if (text.length > 0) selected.set(index, text);
    primaryRoom -= blockCost(text);
  }
  let room = budget - [...selected.values()].reduce((sum, text) => sum + blockCost(text), 0);
  const retrievalRoom = Math.min(
    MAX_RETRIEVAL_CHARS,
    Math.floor(budget * (opts.retrievalBudgetRatio ?? DEFAULT_RETRIEVAL_BUDGET_RATIO)),
  );
  const recentRoom = Math.max(0, room - retrievalRoom);
  let firstRecent = primary.length > 0 ? Math.max(...primary) : blocks.length;
  const addRecent = (available: number): number => {
    for (let index = blocks.length - 1; index >= 0; index--) {
      if (selected.has(index)) continue;
      const block = blocks[index];
      if (block === undefined) continue;
      const cost = blockCost(block.text);
      if (cost > available) break;
      selected.set(index, block.text);
      firstRecent = Math.min(firstRecent, index);
      available -= cost;
      room -= cost;
    }
    return available;
  };
  addRecent(recentRoom);
  if (selected.size === 0) {
    const index = blocks.length - 1;
    const text = truncateMiddle(blocks[index]?.text ?? '', Math.max(0, budget - 2));
    if (text.length > 0) selected.set(index, text);
    room -= blockCost(text);
    firstRecent = index;
  }
  const headingCost = blockCost(RETRIEVAL_HEADER) + blockCost(RECENT_HEADER);
  const earlier = selectRelevantEarlierBlocks(
    blocks.slice(0, firstRecent),
    currentPrompt,
    room - headingCost,
    selected,
  );
  for (const index of earlier) {
    const text = blocks[index]?.text;
    if (text === undefined) continue;
    selected.set(index, text);
    retrieved.add(index);
    room -= blockCost(text);
  }
  if (retrieved.size > 0) room -= headingCost;
  addRecent(room);
  return { blocks: selected, retrieved, omitted: true };
}

/** Preserve the start (identity/context) and end (outcome) within the cap. */
function truncateMiddle(text: string, cap: number, marker = '\n…[truncated]…\n'): string {
  if (text.length <= cap) return text;
  if (cap < marker.length) return '[omitted]'.slice(0, cap);
  const contentRoom = cap - marker.length;
  const head = Math.ceil(contentRoom / 2);
  const tail = Math.floor(contentRoom / 2);
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}

function renderHandoffPrompt(
  blocks: string[],
  omitted: boolean,
  currentPrompt: string,
  header: string,
): string {
  const omittedNote = omitted ? '_(earlier turns omitted to fit the context budget)_\n\n' : '';
  return `${header}\n\n${omittedNote}${blocks.join('\n\n')}\n\n${CURRENT_MARKER}\n\n${currentPrompt}`;
}

function selectRelevantEarlierBlocks(
  blocks: HandoffBlock[],
  currentPrompt: string,
  budgetChars: number,
  excluded: Map<number, string>,
): number[] {
  const query = tokenize(currentPrompt);
  if (query.size === 0 || budgetChars <= 0) return [];
  const scored = blocks
    .map((block, index) => ({
      index,
      score: excluded.has(index) ? 0 : scoreBlock(block.text, query),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = new Set<number>();
  let used = 0;
  for (const { index } of scored) {
    const window = [index - 1, index, index + 1].filter(
      (i) => blocks[i] !== undefined && !excluded.has(i) && !selected.has(i),
    );
    const cost = window.reduce((sum, i) => sum + blockCost(blocks[i]?.text ?? ''), 0);
    if (used + cost <= budgetChars) {
      for (const i of window) selected.add(i);
      used += cost;
    } else if (!selected.has(index)) {
      const singleCost = blockCost(blocks[index]?.text ?? '');
      if (used + singleCost <= budgetChars) {
        selected.add(index);
        used += singleCost;
      }
    }
  }
  return [...selected].sort((a, b) => a - b);
}

function scoreBlock(block: string, query: Set<string>): number {
  let score = 0;
  const seen = new Set<string>();
  for (const token of tokenize(block)) {
    if (!query.has(token)) continue;
    score += seen.has(token) ? 1 : 3;
    seen.add(token);
  }
  return score;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const token = match[0] ?? '';
    if (!STOP_WORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return oneLine(input, TOOL_INPUT_SUMMARY_CAP);
  const json = safeStringify(input);
  return json === undefined ? '' : oneLine(json, TOOL_INPUT_SUMMARY_CAP);
}

/** Text preview of a tool result: the string, or the joined text blocks of a
 * content-block array (images → a `[image]` placeholder), capped to `cap` chars. */
function previewOutput(output: unknown, cap: number): string {
  let text: string;
  if (typeof output === 'string') {
    text = output;
  } else if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image') parts.push('[image]');
    }
    text = parts.join('\n');
  } else {
    text = safeStringify(output) ?? '';
  }
  const trimmed = text.trim();
  return truncateMiddle(trimmed, cap, `\n…[truncated, ${String(trimmed.length)} chars total]…\n`);
}

function oneLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return truncateMiddle(collapsed, max, ' …[truncated]… ');
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
