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
 * `--resume` already carries the full context. This only fires across a backend
 * boundary, where `resumeSessionId` is undefined for the target.
 *
 * Budgeting (see defaults): keep the MOST RECENT turns that fit a token budget
 * (recent context is the most relevant); cap each tool result so one giant output
 * can't eat the budget (the new model can re-read files from the live worktree).
 * Images are noted as placeholders — re-inlining them cross-backend is a later
 * enhancement.
 */

export interface HandoffOptions {
  /** Approximate token ceiling for the serialized history (chars/4 heuristic). */
  tokenBudget?: number;
  /** Per-tool-result char cap in the serialized history. */
  toolResultCharCap?: number;
  /** Max share of the history budget reserved for relevant older context. */
  retrievalBudgetRatio?: number;
}

const DEFAULT_TOKEN_BUDGET = 25_000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOOL_RESULT_CHAR_CAP = 2_000;
const TOOL_INPUT_SUMMARY_CAP = 200;
const DEFAULT_RETRIEVAL_BUDGET_RATIO = 0.25;
const MAX_RETRIEVAL_CHARS = 8_000;
const MIN_RECENT_CHARS = 4_000;
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
  const budgetChars = (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;
  const cap = opts.toolResultCharCap ?? DEFAULT_TOOL_RESULT_CHAR_CAP;
  const blocks = serializeEvents(priorEvents, cap);
  if (blocks.length === 0) return currentPrompt;

  const { kept, omitted } = takeSuffixWithinBudget(blocks, budgetChars);
  if (kept.length === 0) return currentPrompt;
  if (!omitted) return renderHandoffPrompt(kept, false, currentPrompt);

  const retrievalBudget = Math.min(
    MAX_RETRIEVAL_CHARS,
    Math.floor(budgetChars * (opts.retrievalBudgetRatio ?? DEFAULT_RETRIEVAL_BUDGET_RATIO)),
  );
  const recentFloor = Math.min(MIN_RECENT_CHARS, Math.floor(budgetChars * 0.75));
  const recentBudget = Math.max(recentFloor, budgetChars - retrievalBudget);
  const recent = takeSuffixWithinBudget(blocks, recentBudget);
  const retrieved = selectRelevantEarlierBlocks(
    blocks.slice(0, recent.firstKept),
    currentPrompt,
    budgetChars - totalChars(recent.kept),
  );
  if (retrieved.length === 0) return renderHandoffPrompt(kept, true, currentPrompt);

  return renderHandoffPrompt(
    ['**Relevant earlier context:**', ...retrieved, '**Most recent context:**', ...recent.kept],
    true,
    currentPrompt,
  );
}

/** Serialize events into chronological transcript blocks, coalescing streamed
 * text deltas into one assistant message and skipping sub-agent internals
 * (`parentToolId` set) and non-conversational events (status/result/task/…). */
function serializeEvents(events: readonly AgentEvent[], toolResultCap: number): string[] {
  const blocks: string[] = [];
  let textBuf = '';
  const flushText = (): void => {
    const trimmed = textBuf.trim();
    if (trimmed.length > 0) blocks.push(`**Assistant:**\n${trimmed}`);
    textBuf = '';
  };
  for (const event of events) {
    switch (event.t) {
      case 'prompt': {
        flushText();
        const text = event.text.trim();
        if (text.length > 0) blocks.push(`**Operator:**\n${text}`);
        break;
      }
      case 'text':
        if (event.parentToolId === undefined) textBuf += event.delta;
        break;
      case 'tool_call':
        if (event.parentToolId === undefined) {
          flushText();
          blocks.push(`**Tool call — ${event.name}:** ${summarizeInput(event.input)}`);
        }
        break;
      case 'tool_result':
        if (event.parentToolId === undefined) {
          flushText();
          const label = event.isError ? 'Tool result (error)' : 'Tool result';
          blocks.push(`**${label}:**\n${previewOutput(event.output, toolResultCap)}`);
        }
        break;
      default:
        break; // status/result/task/permission/etc. carry no conversational context
    }
  }
  flushText();
  return blocks;
}

/** Keep the most recent blocks that fit `budgetChars`, always keeping at least the
 * last one (truncated if it alone exceeds the budget). Returns them in chronological
 * order plus whether any earlier blocks were dropped. */
function takeSuffixWithinBudget(
  blocks: string[],
  budgetChars: number,
): { kept: string[]; omitted: boolean; firstKept: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] ?? '';
    if (kept.length === 0 && block.length > budgetChars) {
      kept.push(`${block.slice(0, budgetChars)}\n…[truncated]`);
      used = budgetChars;
      continue;
    }
    if (used + block.length > budgetChars)
      return { kept: kept.reverse(), omitted: true, firstKept: i + 1 };
    kept.push(block);
    used += block.length;
  }
  return { kept: kept.reverse(), omitted: false, firstKept: 0 };
}

function renderHandoffPrompt(blocks: string[], omitted: boolean, currentPrompt: string): string {
  const omittedNote = omitted ? '_(earlier turns omitted to fit the context budget)_\n\n' : '';
  return `${HEADER}\n\n${omittedNote}${blocks.join('\n\n')}\n\n${CURRENT_MARKER}\n\n${currentPrompt}`;
}

function selectRelevantEarlierBlocks(
  blocks: string[],
  currentPrompt: string,
  budgetChars: number,
): string[] {
  const query = tokenize(currentPrompt);
  if (query.size === 0 || budgetChars <= 0) return [];

  const scored = blocks
    .map((block, index) => ({ index, score: scoreBlock(block, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const selected = new Set<number>();
  let used = 0;
  for (const { index } of scored) {
    const start = Math.max(0, index - 1);
    const end = Math.min(blocks.length - 1, index + 1);
    const window: number[] = [];
    let windowChars = 0;
    for (let i = start; i <= end; i++) {
      if (selected.has(i)) continue;
      const block = blocks[i] ?? '';
      window.push(i);
      windowChars += block.length;
    }
    if (window.length === 0) continue;
    if (used + windowChars > budgetChars) {
      const block = blocks[index] ?? '';
      if (!selected.has(index) && used + block.length <= budgetChars) {
        selected.add(index);
        used += block.length;
      }
      continue;
    }
    for (const i of window) selected.add(i);
    used += windowChars;
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => blocks[index])
    .filter((block): block is string => block !== undefined);
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

function totalChars(blocks: readonly string[]): number {
  return blocks.reduce((sum, block) => sum + block.length, 0);
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
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}\n…[truncated, ${String(trimmed.length)} chars total]`;
}

function oneLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
