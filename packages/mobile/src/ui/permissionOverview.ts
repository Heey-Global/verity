import { spellOutBidiControls } from './bidi.js';
import { permissionSummary, type PermissionLine } from './permissionSummary.js';
import { toolCallPrimaryField, toolCallView } from './toolCall.js';

const PREVIEW_CHARACTERS = 240;
const TITLE_CHARACTERS = 100;
// These summaries reject unknown fields and include the complete request.
// Other specialized cards may show only a subject or omit account/auth details.
const INLINE_SUMMARIES = new Set([
  'verity_send_session_message',
  'verity_session_handoff',
  'verity_list_sessions',
  'verity_knowledge',
]);

export interface PermissionOverview {
  title: string;
  lines?: PermissionLine[];
  message?: string;
  decidable: boolean;
}

/** A preview never supplies the authority for an inline approval. */
export function permissionOverview(tool: string, input: unknown): PermissionOverview {
  const summary = permissionSummary(tool, input);
  const primary = toolCallPrimaryField(tool, input);
  const reviewCommand = tool === 'verity_secret_run' || primary?.field === 'command';
  const wholeText = summary.lines.map((line) => line.text).join('\n');
  const decidable =
    !reviewCommand &&
    tool !== 'verity_package_install' &&
    input !== undefined &&
    summary.covered &&
    (INLINE_SUMMARIES.has(tool) ||
      (primary !== null &&
        Object.keys(input as Record<string, unknown>).length === 1 &&
        summary.lines.length === 1 &&
        summary.lines[0]?.text === primary.text)) &&
    summary.lines.length > 0 &&
    summary.title.length <= TITLE_CHARACTERS &&
    wholeText.length <= PREVIEW_CHARACTERS &&
    wholeText.split(/\r\n|[\n\r\u2028\u2029]/u).length <= 3;
  const title =
    summary.title.length > TITLE_CHARACTERS || (!reviewCommand && summary.lines.length === 0)
      ? 'Review request'
      : summary.title;
  if (decidable) return { title, lines: summary.lines, decidable };
  if (reviewCommand) return { title, decidable };

  const fields =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const fallback =
    typeof fields?.summary === 'string'
      ? fields.summary
      : toolCallView({
          name: tool,
          input,
          state: 'running',
          createdAt: 0,
          startedAt: null,
          completedAt: null,
          description: null,
        }).subtitle;
  const preview = spellOutBidiControls(wholeText || fallback || '')
    .replace(/\s+/gu, ' ')
    .trim();
  const characters = Array.from(preview);
  const message =
    characters.length > PREVIEW_CHARACTERS
      ? `${characters.slice(0, PREVIEW_CHARACTERS - 1).join('')}…`
      : preview;
  return { title, ...(message ? { message } : {}), decidable };
}
