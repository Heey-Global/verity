/**
 * Turns a previewed session file into a self-contained HTML document for the
 * native print dialog and for PDF export. iOS only offers "Print" in the share
 * sheet for content it can render itself — PDFs and images — so a Markdown or
 * text file shared as-is never shows it; printing goes through this HTML instead.
 *
 * Markdown files are formatted (headings, lists, quotes, tables, code, inline
 * emphasis) with the same block and inline parsers the transcript uses; every
 * other text file prints verbatim in a monospace block. Everything the file
 * contains is escaped, and only http(s) links become anchors: the HTML is
 * rendered by a native web view, so a stray `<script>` or `javascript:` target in
 * a worktree file must stay text.
 */
import { parseMarkdownBlocks } from './markdownTable.js';
import { parseInline, splitRichText } from './richText.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path) || /(^|\/)README$/i.test(path);
}

// `*em*` / `_em_` inside a plain span. parseInline has already taken `**bold**`,
// so a lone asterisk pair here is emphasis. Underscores only count at word
// boundaries, so snake_case identifiers stay intact.
const EMPHASIS = /\*([^*\s](?:[^*]*[^*\s])?)\*|(^|[^\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])/g;

function emphasisHtml(text: string): string {
  let html = '';
  let last = 0;
  let match: RegExpExecArray | null;
  EMPHASIS.lastIndex = 0;
  while ((match = EMPHASIS.exec(text)) !== null) {
    const lead = match[2] ?? '';
    const start = match.index + lead.length;
    html += escapeHtml(text.slice(last, start));
    html += `<em>${escapeHtml(match[1] ?? match[3] ?? '')}</em>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

function inlineHtml(text: string): string {
  return parseInline(text)
    .map((span) => {
      switch (span.t) {
        case 'bold':
          return `<strong>${emphasisHtml(span.text)}</strong>`;
        case 'code':
          return `<code>${escapeHtml(span.text)}</code>`;
        case 'link':
          return span.external
            ? `<a href="${escapeHtml(span.url)}">${emphasisHtml(span.text)}</a>`
            : emphasisHtml(span.text);
        default:
          return emphasisHtml(span.text);
      }
    })
    .join('');
}

// A closing `#` run only counts after whitespace, so `# Using C#` keeps its `#`.
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

type ListKind = 'ul' | 'ol';

function listItemHtml(text: string): string {
  const task = TASK.exec(text);
  if (task) {
    const box = task[1] === ' ' ? '&#9744;' : '&#9745;';
    return `<li class="task">${box} ${inlineHtml(task[2] ?? '')}`;
  }
  return `<li>${inlineHtml(text)}`;
}

/** Plain markdown lines (no fences, no tables) → block HTML. Lists nest by
 * indentation; a paragraph's soft line breaks join with a space as in markdown. */
function linesHtml(lines: readonly string[]): string {
  const out: string[] = [];
  const lists: { kind: ListKind; indent: number }[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) out.push(`<p>${inlineHtml(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushQuote = (): void => {
    if (quote.length > 0) out.push(`<blockquote>${linesHtml(quote)}</blockquote>`);
    quote = [];
  };
  const closeLists = (toDepth = 0): void => {
    while (lists.length > toDepth) out.push(`</li></${lists.pop()?.kind ?? 'ul'}>`);
  };
  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
    closeLists();
  };

  for (const line of lines) {
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      closeLists();
      quote.push(quoted[1] ?? '');
      continue;
    }
    flushQuote();

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inlineHtml(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    if (RULE.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const kind: ListKind = bullet ? 'ul' : 'ol';
      const indent = (bullet?.[1] ?? ordered?.[1] ?? '').replace(/\t/g, '    ').length;
      const text = bullet ? (bullet[2] ?? '') : (ordered?.[3] ?? '');
      while (lists.length > 0 && indent < (lists[lists.length - 1]?.indent ?? 0)) {
        closeLists(lists.length - 1);
      }
      const top = lists[lists.length - 1];
      if (top === undefined || indent > top.indent) {
        const start = ordered && ordered[2] !== '1' ? ` start="${ordered[2] ?? '1'}"` : '';
        out.push(`<${kind}${start}>`);
        lists.push({ kind, indent });
      } else if (top.kind !== kind) {
        closeLists(lists.length - 1);
        out.push(`<${kind}>`);
        lists.push({ kind, indent });
      } else {
        out.push('</li>');
      }
      out.push(listItemHtml(text));
      continue;
    }
    if (lists.length > 0 && paragraph.length === 0 && /^\s+\S/.test(line)) {
      // An indented continuation line belongs to the open list item.
      out.push(` ${inlineHtml(line.trim())}`);
      continue;
    }
    closeLists();
    paragraph.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

function tableHtml(header: readonly string[], rows: readonly string[][]): string {
  const head = header.map((cell) => `<th>${inlineHtml(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// A YAML front-matter block at the very top. Rendered through the markdown path
// its closing `---` would read as a heading underline or rule, so it prints as
// the metadata it is.
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let body = markdown.replace(/\r\n/g, '\n');
  const front = FRONT_MATTER.exec(body);
  if (front) {
    out.push(`<pre class="front-matter">${escapeHtml(front[1] ?? '')}</pre>`);
    body = body.slice(front[0].length);
  }
  for (const block of splitRichText(body)) {
    if (block.type === 'code') {
      out.push(`<pre><code>${escapeHtml(block.content)}</code></pre>`);
      continue;
    }
    for (const md of parseMarkdownBlocks(block.content)) {
      out.push(md.type === 'table' ? tableHtml(md.header, md.rows) : linesHtml(md.lines));
    }
  }
  return out.join('\n');
}

const STYLE = `
@page { margin: 18mm; }
body { font-family: -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; margin: 0; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.4em; page-break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11pt; }
p, ul, ol, blockquote, table, pre { margin: 0 0 0.8em; }
ul, ol { padding-left: 1.4em; }
li.task { list-style: none; margin-left: -1.2em; }
blockquote { border-left: 3px solid #ccc; padding-left: 0.8em; color: #444; }
code, pre { font-family: Menlo, "SF Mono", "Roboto Mono", monospace; font-size: 9.5pt; }
code { background: #f1f1f1; padding: 0 0.2em; border-radius: 3px; }
pre { background: #f6f6f6; padding: 0.6em 0.8em; border-radius: 4px; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
pre.plain { background: none; padding: 0; }
pre.front-matter { color: #555; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
th { background: #f1f1f1; }
tr { page-break-inside: avoid; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.2em 0; }
a { color: #0645ad; }
`;

/** The complete HTML document to print or export for one previewed file. */
export function printableFileHtml(path: string, content: string): string {
  const title = path.split('/').filter(Boolean).pop() ?? path;
  const body = isMarkdownPath(path)
    ? markdownToHtml(content)
    : `<pre class="plain">${escapeHtml(content)}</pre>`;
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    `</head><body>\n${body}\n</body></html>`,
  ].join('\n');
}
