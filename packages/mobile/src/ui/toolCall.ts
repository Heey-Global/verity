import { extractToolResultImages } from '@verity/events';
import type { ToolCall } from '../happy/message.js';
import { spellOutBidiControls } from './bidi.js';

/**
 * Pure projection of a {@link ToolCall} into the fields the transcript's tool
 * card renders: a title (the tool name), a one-line summary of the call's most
 * meaningful input, a tone for styling, and a short result preview once the call
 * settles. Keeping this out of the RN component makes the "what does a Bash card
 * say" logic unit-testable and independent of the view.
 */

export type ToolCallTone = 'running' | 'done' | 'error';

/** An image lifted off a tool result (e.g. a `Read` of a PNG), for the card to
 * render with `expo-image` (issue #115). Exactly one of `id`/`data` is set: `id`
 * is a content-addressed ref the card fetches lazily (`GET /attachments/:id`) —
 * the normal case after the store externalizes the bytes; `data` is legacy inline
 * base64 (no `data:` prefix), still carried on live-streamed results and pre-#115
 * events. `mediaType` is e.g. `image/png`. */
export type ToolImage = { mediaType: string; id?: string; data?: string };

export interface ToolCallView {
  /** The tool name, e.g. `Bash`. */
  title: string;
  /** Human-readable one-line action for the collapsed row: verb + object, e.g.
   * `Ran git status`, `Read api.ts`, `Edited [id].tsx`, `Searched session`. */
  headline: string;
  /** One-line summary of the call's primary input (the raw command / path), for
   * the expanded view; or null when none applies. */
  subtitle: string | null;
  tone: ToolCallTone;
  /** Short preview of the result/error once settled; null while running. Excludes
   * image content (surfaced separately as {@link images}), so an image-only
   * result is `null` rather than a wall of base64. */
  preview: string | null;
  /** Images the tool returned (issue #115) — e.g. a `Read` of an image file. The
   * data already rides on the canonical `tool_result` event; the card renders it
   * inline instead of as a stringified blob. Empty when the result has none. */
  images: ToolImage[];
}

// Human verb per tool for the collapsed headline. Unmapped tools fall back to
// the tool name itself.
const ACTION: Record<string, string> = {
  Bash: 'Ran',
  Read: 'Read',
  Edit: 'Edited',
  MultiEdit: 'Edited',
  Write: 'Wrote',
  NotebookEdit: 'Edited',
  Grep: 'Searched',
  Glob: 'Found',
  WebFetch: 'Fetched',
  WebSearch: 'Searched',
  Task: 'Delegated',
  Agent: 'Delegated',
  TodoWrite: 'Updated todos',
  TaskCreate: 'Added task',
  TaskUpdate: 'Updated task',
};

// The single input field that best summarizes a call, per tool. Anything not
// listed falls back to the first string-valued field of the input object.
const PRIMARY_FIELD: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'description',
  Agent: 'description',
  TaskCreate: 'subject',
  TaskUpdate: 'subject',
  // A skill/slash-command invocation — headline reads "Skill code-review".
  Skill: 'skill',
  // Without this the fallback picks whichever string field comes first in the object, which
  // for a handoff could be the briefing — 80 squashed characters of a document, where the
  // title is the one field written to be read at a glance. The full briefing has its own
  // renderer on the approval card.
  verity_session_handoff: 'title',
  // Both of its arguments are optional, so the fallback would headline whichever the caller
  // happened to send — including the boolean `activeOnly`. The project narrowing is the part
  // worth seeing when there is one.
  verity_list_sessions: 'project',
};

/**
 * Tools whose {@link PRIMARY_FIELD} is the ONLY field allowed on the line — when it is
 * missing, the verb alone stands rather than the first string field.
 *
 * The general fallback is right for a tool nobody mapped: some text beats a bare name. It is
 * wrong where the fields it would reach for are the ones the entry exists to keep off the
 * line. A `verity_session_handoff` without its `title` is precisely the call whose first
 * string is the briefing — a 20,000-character document, agent-authored, with its own renderer
 * on the approval card — and a malformed call is where a reader can least afford a line that
 * looks like a summary and is not.
 *
 * Deliberately a small set rather than "every mapped tool": the mapped file and search tools
 * lose nothing by falling through, and widening this would change how existing cards read
 * for reasons that have nothing to do with these two.
 */
const ONLY_PRIMARY_FIELD = new Set(['verity_session_handoff', 'verity_list_sessions']);

const MAX_LEN = 80;
const MAX_PREVIEW = 120;

export function toolCallView(tool: ToolCall): ToolCallView {
  const tone: ToolCallTone =
    tool.state === 'error' ? 'error' : tool.state === 'completed' ? 'done' : 'running';
  return {
    title: tool.name,
    headline: buildHeadline(tool.name, tool.input),
    subtitle: summarizeInput(tool.name, tool.input),
    tone,
    // No result preview/images until the call settles — a running call has none yet.
    preview: tool.state === 'running' ? null : previewResult(tool.name, tool.result),
    images: tool.state === 'running' ? [] : extractToolImages(tool.result),
  };
}

/**
 * Lift images out of a settled tool result. `claude` returns an image-bearing
 * tool result (e.g. `Read` of a PNG) as a content-block array of
 * `{ type:'image', source:{ type:'base64', media_type, data } }`; the store then
 * externalizes those bytes to content-addressed refs (see
 * {@link extractToolResultImages}), so a reloaded result carries `id`s and a
 * live-streamed one still carries inline `data`. Both are handled. Anything not
 * matching an image content-block array yields no images (a plain text/JSON result
 * is unaffected).
 */
export function extractToolImages(result: unknown): ToolImage[] {
  return extractToolResultImages(result);
}

/** A compact `verb object` line for the collapsed row. For file tools the object
 * is the basename; for Bash the human `description` (falling back to the
 * command); otherwise the primary field. */
function buildHeadline(name: string, input: unknown): string {
  // A skill/slash-command reads as its own name, title-cased — "code-review" →
  // "Code Review", "review-loop" → "Review Loop" — not "Skill code-review".
  if (name === 'Skill') return skillLabel(input) ?? name;
  const verb = ACTION[name] ?? name;
  const object = headlineObject(name, input);
  return object ? `${verb} ${object}` : verb;
}

/** Title-case a `Skill` call's `input.skill` for display ("code-review" → "Code
 * Review"). Null when the skill name is missing/blank, so the caller falls back. */
function skillLabel(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const skill = (input as Record<string, unknown>).skill;
  if (typeof skill !== 'string' || skill.trim().length === 0) return null;
  return skill
    .trim()
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function headlineObject(name: string, input: unknown): string | null {
  if (typeof input === 'string') return oneLine(input, 48);
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (name === 'Bash') {
    const description = typeof obj.description === 'string' ? obj.description : undefined;
    const command = typeof obj.command === 'string' ? obj.command : undefined;
    const text = description ?? command;
    return text !== undefined ? oneLine(text, 60) : null;
  }
  const fileKey = name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  // Spelled out but not otherwise touched: `basename` returns a slice of a path the model
  // wrote, and a headline is the one-line-woven shape bidi controls reorder best — this was
  // the only branch reaching the card unspelled. Deliberately NOT `oneLine`, which would also
  // clip at 48 and collapse whitespace: a file name is already short and already one line, so
  // that would be an unrelated behaviour change to every Read/Write/Edit headline.
  if (typeof obj[fileKey] === 'string') return spellOutBidiControls(basename(obj[fileKey]));
  const primary = PRIMARY_FIELD[name];
  if (primary !== undefined && typeof obj[primary] === 'string') return oneLine(obj[primary], 48);
  if (ONLY_PRIMARY_FIELD.has(name)) return null;
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') return oneLine(value, 48);
  }
  return null;
}

/** Last path segment (the file name) without walking into edge-case territory. */
function basename(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] || path;
}

function summarizeInput(name: string, input: unknown): string | null {
  if (typeof input === 'string') return oneLine(input, MAX_LEN);
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const key = PRIMARY_FIELD[name];
  if (key !== undefined && typeof obj[key] === 'string') return oneLine(obj[key], MAX_LEN);
  if (ONLY_PRIMARY_FIELD.has(name)) return null;
  // Fall back to the first string-valued field so an unmapped tool still shows
  // something meaningful rather than a blank card.
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') return oneLine(value, MAX_LEN);
  }
  return null;
}

const NATIVE_TOOL_FAILURE_CAUSE =
  / Cause: (?:native (?:Secret Tool (?:requires permission control|approval timed out before broker dispatch|denied)|tool (?:result mailbox timed out|mailbox could not be read|mailbox frame|ready receipt|result hash|receipt acknowledgement|call id|attestation acknowledgement|attestation exceeds)[^.]*|Secret Tool result)|Secret resolution failed during [^.]+\. No secret value was exposed\.|Trusted CLI dispatch failed during (?:runner supervisor connection|runner supervisor response)\. (?:The command was not started\.|Whether the command started is unknown; do not retry a mutating command automatically\.) No secret value was exposed\.|Trusted CLI dispatch failed during spawn broker dispatch\.(?: Broker phase: (validation|materialization|launch-spec|spawn); cause: \1 failed\.)? (?:The command was not started\.|Whether the command started is unknown; do not retry a mutating command automatically\.) No secret value was exposed\.)$/u;

function previewResult(name: string, result: unknown): string | null {
  if (result === undefined || result === null) return null;
  let text: string | null;
  if (typeof result === 'string') {
    text = result;
  } else if (Array.isArray(result)) {
    // A claude content-block array: preview the TEXT blocks only (images render
    // separately — see extractToolImages). An image-only result → null, not a
    // base64 wall. A plain (non-content-block) array still stringifies as before.
    const parts: string[] = [];
    for (const block of result) {
      if (
        block &&
        typeof block === 'object' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    if (parts.length > 0) text = parts.join('\n');
    else if (extractToolImages(result).length > 0)
      text = null; // image-only content blocks
    else text = safeStringify(result); // not a content-block array → preview as JSON
  } else {
    text = safeStringify(result);
  }
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Native Secret Tool failures are already produced from closed, sanitized
  // diagnostics. Truncating them hides the only actionable cause in the UI.
  if (
    (name === 'verity_secret_job' ||
      name === 'verity_http_request' ||
      name === 'verity_secret_run') &&
    NATIVE_TOOL_FAILURE_CAUSE.test(trimmed)
  ) {
    return oneLine(trimmed, 1_024);
  }
  return oneLine(trimmed, MAX_PREVIEW);
}

/**
 * Collapse a value to one displayable line.
 *
 * Bidi controls are spelled out rather than collapsed away: they are not whitespace, so
 * `\s+` leaves them in, and a single line woven from a tool name and an argument is the
 * shape they reorder most effectively — "Send briefing to sess-a" is one control away from
 * reading as another session's id. Every field that reaches this helper is written by a model
 * or read back from a tool result, and the argument that arrives with one has not been through
 * a schema that refuses it: `cardLine` runs on the server, on requests that reach it.
 *
 * Spelled out, not filtered, for the reason {@link spellOutBidiControls} gives — and a line
 * that legitimately contains one is a line whose reader should know.
 *
 * Result previews get the same treatment as inputs, deliberately. LRM and RLM are ordinary in
 * correctly typeset Arabic and Hebrew, so a preview of such a file does pick up `<U+200E>`
 * noise — but a preview is the squashed-to-one-line form, where those marks reorder the
 * neutral characters around them most effectively, and a tool result is the least trustworthy
 * text on the card: it is whatever the tool returned. A reader forms a belief about what a
 * session did from these lines, so a preview that silently reads backwards is worse than one
 * that reads noisily. Bounded to 120 characters either way.
 *
 * Truncated BEFORE the controls are spelled out, so the cut lands on a character of the
 * original rather than inside an eight-character `<U+202E>` — a line ending `…<U+20` reads as
 * text the value did not contain, and the budget would otherwise be spent eight characters at
 * a time on the very controls being flagged. The rendered line can therefore run past `max`,
 * which is the right direction: a line that grows is a line dense in controls.
 */
function oneLine(value: string, max: number): string {
  const firstLine = value.split('\n').find((line) => line.trim().length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
  return spellOutBidiControls(clipped);
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise non-serializable result — no preview rather than throw.
    return null;
  }
}
