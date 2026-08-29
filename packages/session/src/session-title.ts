/**
 * Pure helpers for deriving a session's short display name from the opening of its
 * conversation. The actual model call is the {@link Backend.query} hook the
 * conductor routes by the session's model — so the title is produced by the SAME
 * engine (Claude / Codex / OpenCode) the session uses, never a hard-coded default.
 * These two functions only frame the prompt and clean up the reply.
 */

/** Cap the conversation we feed the model — the opening is enough to name a topic,
 * and a bounded prompt keeps the one-shot cheap. */
const MAX_CONVERSATION_CHARS = 4000;
/** Title shape guardrails: at most this many words, this many characters. */
const MAX_TITLE_WORDS = 3;
const MAX_TITLE_CHARS = 40;

const TITLE_PROMPT_PREFIX = `Name this coding-assistant session. Read the start of the conversation below and reply with a SHORT title of at most ${MAX_TITLE_WORDS} words (two is ideal) that captures its topic.

Reply with ONLY the title: no quotes, no surrounding punctuation, no preamble or explanation. Use Title Case and the same language as the conversation.

Conversation:
`;

const BRANCH_PROMPT_PREFIX = `Name the git branch for this coding-assistant session. Read the start of the conversation below and reply with a SHORT English branch name in this exact format:

<type>/<slug>

Rules:
- type must be one of: feat, fix, chore, refactor, docs, style, test
- choose fix for bugs, feat for user-facing additions, chore for maintenance or unclear work
- slug must be lower-kebab-case English words, at most 40 characters
- reply with ONLY the branch name: no quotes, no issue number, no suffix, no explanation

Conversation:
`;

/**
 * Frame the opening-conversation digest into the titling prompt, bounding the
 * conversation length. Returns an empty string for an empty digest so the caller
 * can skip the model call.
 */
export function buildTitlePrompt(conversation: string): string {
  const trimmed = conversation.trim();
  if (trimmed.length === 0) return '';
  return TITLE_PROMPT_PREFIX + trimmed.slice(0, MAX_CONVERSATION_CHARS);
}

export function buildBranchPrompt(conversation: string): string {
  const trimmed = conversation.trim();
  if (trimmed.length === 0) return '';
  return BRANCH_PROMPT_PREFIX + trimmed.slice(0, MAX_CONVERSATION_CHARS);
}

/**
 * Reduce a model's raw reply to a bare label: take the first non-empty line, strip
 * wrapping quotes/backticks/asterisks and trailing punctuation, collapse
 * whitespace, and clamp to {@link MAX_TITLE_WORDS} words / {@link MAX_TITLE_CHARS}
 * characters. Returns `undefined` if nothing usable is left.
 */
export function sanitizeTitle(raw: string): string | undefined {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;

  const stripped = firstLine
    .replace(/^["'`*\s]+/, '')
    .replace(/["'`*.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return undefined;

  const title = stripped
    .split(' ')
    .slice(0, MAX_TITLE_WORDS)
    .join(' ')
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return title.length > 0 ? title : undefined;
}

export function sanitizeBranchName(raw: string): string | undefined {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;

  const stripped = firstLine
    .replace(/^["'`*\s]+/, '')
    .replace(/["'`*.\s]+$/, '')
    .trim()
    .toLowerCase();
  const match = /^(feat|fix|chore|refactor|docs|style|test)\/(.+)$/.exec(stripped);
  if (match === null) return undefined;
  const type = match[1];
  const rawSlug = match[2];
  if (type === undefined || rawSlug === undefined) return undefined;

  const slug = rawSlug
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (slug.length === 0) return undefined;
  return `${type}/${slug}`;
}
