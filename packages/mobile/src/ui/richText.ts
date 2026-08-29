/**
 * Splits agent text into renderable blocks — plain prose and fenced code — so the
 * chat transcript can render code in a monospace card without pulling a full
 * markdown engine into the app. This is the v1 of rich rendering: fenced
 * ```` ``` ```` blocks become {@link RichBlock} `code`; everything else is `text`.
 * Inline markdown (bold, lists, links) is deliberately deferred — a dedicated
 * renderer is a later, dependency-bearing decision; this keeps the data layer
 * pure and unit-tested.
 */

export type RichBlock =
  { type: 'text'; content: string } | { type: 'code'; lang: string | null; content: string };

const STRONG_SECTION = /^\s*\*\*([^*]{1,72})\*\*:?\s*$/;
const COLON_SECTION = /^\s*([A-ZÄÖÜ0-9][^:\n]{1,72}):\s*$/;

// A line that opens or closes a fence: exactly ``` optionally followed by a
// language tag. `[^`]*` (not `.*`) so a run of >3 backticks doesn't leak extra
// backticks into the captured tag — such a line isn't treated as a fence at all.
const FENCE = /^```([^`]*)$/;

/**
 * Project a text string into ordered prose/code blocks. Blank text segments
 * (e.g. the gap a code fence leaves behind) are dropped so the renderer never
 * emits an empty bubble. An unterminated opening fence renders its remainder as
 * code — the agent's stream may be mid-block when we render it live.
 */
export function splitRichText(text: string): RichBlock[] {
  const lines = text.split('\n');
  const blocks: RichBlock[] = [];
  let mode: 'text' | 'code' = 'text';
  let buf: string[] = [];
  let lang: string | null = null;

  const flushText = (): void => {
    // Strip the surrounding blank lines a fence boundary leaves behind, but keep
    // interior structure. An all-blank segment collapses to nothing.
    const content = buf.join('\n').replace(/^\n+|\n+$/g, '');
    if (content.length > 0) blocks.push({ type: 'text', content });
    buf = [];
  };
  const flushCode = (): void => {
    blocks.push({ type: 'code', lang, content: buf.join('\n') });
    buf = [];
    lang = null;
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence) {
      const tag = fence[1]?.trim() ?? '';
      if (mode === 'text') {
        // An opening fence; its tag (if any) is the language.
        flushText();
        mode = 'code';
        lang = tag || null;
        continue;
      }
      // In code mode, only a BARE ``` closes the block. A fence-like line that
      // carries a trailing tag is ambiguous as a close, so render it as code
      // content rather than silently dropping the tail.
      if (tag === '') {
        flushCode();
        mode = 'text';
        continue;
      }
    }
    buf.push(line);
  }
  // EOF: flush the open block. A still-open code fence stays code (live stream).
  if (mode === 'code') flushCode();
  else flushText();
  return blocks;
}

/**
 * Detects standalone prose section labels that agents commonly emit without
 * markdown heading markers, e.g. `Änderung:` or `**Verification**`.
 */
export function markdownSectionTitle(line: string): string | null {
  const strong = STRONG_SECTION.exec(line);
  if (strong) return strong[1]?.replace(/:\s*$/, '').trim() || null;
  const colon = COLON_SECTION.exec(line);
  return colon?.[1]?.trim() || null;
}

/** An inline run within a line of prose: plain text, **bold**, `code`, or a link
 * (a markdown `[label](url)` or a bare `https://…` URL). A `link` carries both its
 * display `text` and the `url` to open on tap. */
export type InlineSpan =
  | { t: 'plain' | 'bold' | 'code'; text: string }
  | { t: 'link'; text: string; url: string; external: boolean };

// One pass, in precedence order: `**bold**`, `` `code` ``, a markdown
// `[label](target)`, then a bare `http(s)://…` URL. Code is matched before bare URLs
// so a URL inside backticks stays literal code, not a link. Markdown targets may be
// local file refs (`/work/a.ts:12`), which the renderer displays compactly without
// trying to open through Linking.
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s]+)/g;

// Trailing sentence punctuation that shouldn't be swallowed into a bare URL (so
// "see https://x.com." links "https://x.com" and keeps the period as text).
const TRAILING_PUNCT = /[.,;:!?)]+$/;

/**
 * Split a single line of prose into inline spans, recognizing `**bold**`,
 * `` `code` ``, markdown `[label](target)` links, and bare URLs. Everything else is
 * plain. Used by the transcript renderer so an agent's markdown reads as formatted
 * text (and links are tappable) instead of literal markup. (Block constructs —
 * headings, lists, code fences, tables — are handled by the renderer around this;
 * this is inline-only.)
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) spans.push({ t: 'plain', text: text.slice(last, match.index) });
    if (match[1] !== undefined) {
      spans.push({ t: 'bold', text: match[1] });
    } else if (match[2] !== undefined) {
      spans.push({ t: 'code', text: match[2] });
    } else if (match[3] !== undefined && match[4] !== undefined) {
      spans.push({
        t: 'link',
        text: match[3],
        url: match[4],
        external: /^https?:\/\//.test(match[4]),
      });
    } else if (match[5] !== undefined) {
      // Bare URL: strip trailing punctuation back out to plain text.
      const punct = TRAILING_PUNCT.exec(match[5])?.[0] ?? '';
      const url = punct ? match[5].slice(0, -punct.length) : match[5];
      spans.push({ t: 'link', text: url, url, external: true });
      if (punct) spans.push({ t: 'plain', text: punct });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ t: 'plain', text: text.slice(last) });
  return spans;
}

export function sessionFilePathFromLocalLink(url: string): string | null {
  const withoutHash = url.split('#')[0] ?? '';
  const withoutLine = withoutHash.replace(/:\d+(?::\d+)?$/, '');
  const withoutFileScheme = withoutLine.startsWith('file://')
    ? withoutLine.slice('file://'.length)
    : withoutLine;
  const sessionWorktree = /^\/work\/\.verity-sessions\/[^/]+\/(.+)$/.exec(withoutFileScheme);
  if (withoutFileScheme.startsWith('/') && sessionWorktree === null) return null;
  if (!withoutFileScheme.startsWith('/') && /^[a-z][a-z0-9+.-]*:/i.test(withoutFileScheme)) {
    return null;
  }
  const candidate = sessionWorktree?.[1] ?? withoutFileScheme;
  const normalized = candidate
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
  if (normalized.length === 0) return null;
  if (normalized.split('/').some((part) => part === '..' || part === '.git')) return null;
  return normalized;
}

export function isSessionImageFilePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}
