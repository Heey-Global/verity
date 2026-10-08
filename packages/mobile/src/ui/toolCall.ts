import { extractToolResultImages } from '@verity/events';
import type { Message, ToolCall, ToolCallMessage } from '../happy/message.js';
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
  verity_tasks: 'action',
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

/**
 * Display labels for Verity's gateway tools. Verity's own features keep the product name
 * ("Verity Secret Run"); the Google connectors read as the service they reach ("Gmail"). Each backend reports them under its own
 * qualified name — Claude as `mcp__verity__verity_gmail`, OpenCode as `verity_verity_gmail` —
 * so without this the row reads as that raw, doubled identifier instead of what it does.
 */
const VERITY_TOOL_LABELS: Record<string, string> = {
  verity_gmail: 'Gmail',
  verity_google_calendar: 'Google Calendar',
  verity_google_contacts: 'Google Contacts',
  verity_google_docs: 'Google Docs',
  verity_google_drive: 'Google Drive',
  verity_google_sheets: 'Google Sheets',
  verity_google_slides: 'Google Slides',
  verity_http_request: 'Verity HTTP Request',
  verity_secret_run: 'Verity Secret Run',
  verity_secret_job: 'Verity Secret Job',
  verity_knowledge: 'Verity Knowledge',
  verity_session_handoff: 'Verity Handoff',
  verity_send_session_message: 'Verity Session Message',
  verity_list_sessions: 'Verity Sessions',
  verity_list_linked_sessions: 'Verity Linked Sessions',
  verity_recent_session_messages: 'Verity Session Messages',
  verity_session_progress: 'Verity Session Progress',
  verity_publish_session_progress: 'Verity Published Progress',
  verity_diagnostics: 'Verity Diagnostics',
  verity_start_planning: 'Verity Planning Mode',
  verity_present_plan: 'Verity Plan',
  verity_end_planning: 'Verity Implement Plan',
  verity_tasks: 'Verity Tasks',
};

/** Strip only Verity's own backend qualification, including tools added by the platform. */
function canonicalToolName(name: string): string {
  if (name.startsWith('mcp__verity__verity_')) return name.slice('mcp__verity__'.length);
  if (name.startsWith('verity_verity_')) return name.slice('verity_'.length);
  return name;
}

/** New platform tools must remain readable before a client ships a dedicated label. */
function toolDisplayName(name: string): string {
  const canonical = canonicalToolName(name);
  // Own-property check: a tool named `constructor` must not resolve to Object's.
  if (Object.hasOwn(VERITY_TOOL_LABELS, canonical)) return VERITY_TOOL_LABELS[canonical]!;
  if (/^verity_[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(canonical)) {
    const words = canonical.slice('verity_'.length).split('_');
    return `Verity ${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}`;
  }
  return name;
}

/** Agent-facing Verity CLIs, which run through Bash rather than the gateway. Without this a
 * code review reads as whatever description the agent happened to write for the command. */
const VERITY_CLI_LABELS: Record<string, string> = {
  'verity-code-review': 'Verity Code Review',
  'verity-memory': 'Verity Memory',
  'verity-dev-server': 'Verity Dev Server',
};

/** "Verity Code Review run" for a Bash call that invokes a Verity CLI; null otherwise. */
function verityCliHeadline(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string') return null;
  const [program, subcommand] = command.trim().split(/\s+/);
  if (program === undefined || !Object.hasOwn(VERITY_CLI_LABELS, program)) return null;
  const label = VERITY_CLI_LABELS[program]!;
  return subcommand !== undefined && /^[a-z][a-z-]*$/.test(subcommand)
    ? `${label} ${subcommand}`
    : label;
}

const MAX_LEN = 80;
const MAX_PREVIEW = 120;

export function toolCallView(tool: ToolCall): ToolCallView {
  const tone: ToolCallTone =
    tool.state === 'error' ? 'error' : tool.state === 'completed' ? 'done' : 'running';
  const name = canonicalToolName(tool.name);
  return {
    title: toolDisplayName(name),
    headline: buildHeadline(name, tool.input),
    subtitle: summarizeInput(name, tool.input),
    tone,
    // No result preview/images until the call settles — a running call has none yet.
    preview: tool.state === 'running' ? null : previewResult(name, tool.result),
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
  if (name === 'Bash') {
    const cli = verityCliHeadline(input);
    if (cli !== null) return cli;
  }
  const verb = ACTION[name] ?? toolDisplayName(name);
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

/** Only a materialization failure whose diagnostic confirms no process started is
 * safe for the app to resume automatically after unlocking. */
export function trustedCliRetrySafeAfterUnlock(tool: ToolCall): boolean {
  if (!isTrustedCliToolName(tool.name) || tool.state !== 'error') return false;
  const preview = retryDiagnosticText(tool.result);
  return (
    preview !== null &&
    preview.includes('Trusted CLI dispatch failed during spawn broker dispatch.') &&
    preview.includes('Broker phase: materialization;') &&
    preview.includes('The command was not started.') &&
    !preview.includes('Whether the command started is unknown')
  );
}

function isTrustedCliToolName(name: string): boolean {
  return name === 'verity_secret_run' || name === 'mcp__verity__verity_secret_run';
}

/** Read only the text shapes emitted by native tool results. Retry eligibility
 * needs exact sentinels, not the general preview formatter or its regexes. */
function retryDiagnosticText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return retryDiagnosticTextBlocks(result);
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? retryDiagnosticTextBlocks(content) : null;
}

function retryDiagnosticTextBlocks(blocks: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (
      block &&
      typeof block === 'object' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Return the last retry-safe trusted CLI failure from the current turn. A later
 * user message or trusted CLI call supersedes it; reporting tools do not. */
export function trustedCliUnlockCandidate(messages: readonly Message[]): ToolCallMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.kind === 'user-text') return null;
    if (message.kind === 'tool-call' && isTrustedCliToolName(message.tool.name)) {
      return trustedCliRetrySafeAfterUnlock(message.tool) ? message : null;
    }
  }
  return null;
}

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
