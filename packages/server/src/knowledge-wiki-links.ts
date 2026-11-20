// Keeps the Wiki's relative Markdown links pointing at the right files when a
// Wiki page, a Wiki folder or a Source is renamed or moved: pages that linked
// to the old place are rewritten to the new one, and a moved page's own links
// are rewritten so they still reach what they reached before. Paths here are
// scope paths — `insights/topic/page.md`, `sources/documents/a.pdf` — relative
// to one knowledge scope (a project's knowledge folder or Shared). Links leave
// a scope only through absolute paths, which are never rewritten.
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { posix } from 'node:path';

import { extractKnowledgeFile } from './knowledge-file-ingest.js';
import { EXTRACTED_TEXT_DIR, KNOWLEDGE_INSIGHTS_DIR } from './knowledge-folder.js';
import { FILE_HISTORY_DIR } from './session-file-history.js';
import { fileVersion, writeSessionText } from './session-file-write.js';
import { openKnowledgeFileSlot } from './session-files.js';

/** A page whose links changed, or that links to an entry, with how many links. */
export interface WikiLinkCount {
  path: string;
  links: number;
}

/** One entry's old and new scope path. A folder carries everything inside it. */
export interface KnowledgeRelocation {
  from: string;
  to: string;
}

const MAX_PAGES = 5_000;
const MAX_DEPTH = 16;
/** The Wiki editor's own limit: a larger page could not be saved back anyway. */
const MAX_PAGE_BYTES = 1_000_000;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Recorded decisions are kept as recorded; their links are not rewritten. */
const SKIPPED_TOP_FOLDERS = new Set(['decisions']);

/** `path` resolved against folder `dir`, both scope paths; null when it climbs out. */
function resolveIn(dir: string, path: string): string | null {
  const resolved: string[] = [];
  for (const segment of [...dir.split('/'), ...path.split('/')]) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return null;
      resolved.pop();
    } else resolved.push(segment);
  }
  return resolved.join('/');
}

/** Whether `path` is `entry` itself or, for a folder, inside it. */
function isWithin(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/** Where `path` is after `move`, or undefined when the move did not touch it. */
export function relocatedPath(path: string, move: KnowledgeRelocation): string | undefined {
  return isWithin(path, move.from) ? `${move.to}${path.slice(move.from.length)}` : undefined;
}

/** A link destination split into what can be rewritten and what is kept. */
interface ParsedHref {
  path: string;
  /** `#anchor` and/or `?query`, kept verbatim. */
  suffix: string;
  angle: boolean;
  encoded: boolean;
}

function parseHref(href: string): ParsedHref | undefined {
  let raw = href;
  const angle = raw.startsWith('<') && raw.endsWith('>');
  if (angle) raw = raw.slice(1, -1);
  // Absolute paths and URLs point outside the scope's relative layout.
  if (raw === '' || SCHEME.test(raw) || raw.startsWith('/') || raw.startsWith('#')) return;
  const cut = raw.search(/[#?]/);
  const encodedPath = cut === -1 ? raw : raw.slice(0, cut);
  if (encodedPath === '') return;
  let path: string;
  try {
    path = decodeURI(encodedPath);
  } catch {
    return;
  }
  if (path.includes('\\') || path.includes('\0')) return;
  return {
    path,
    suffix: cut === -1 ? '' : raw.slice(cut),
    angle,
    encoded: path !== encodedPath,
  };
}

function formatHref(parsed: ParsedHref, path: string): string {
  let written = path;
  // A space or parenthesis would end a bare destination early.
  if (parsed.encoded || (!parsed.angle && /[\s()<>]/.test(path)))
    written = encodeURI(path).replaceAll('(', '%28').replaceAll(')', '%29');
  written += parsed.suffix;
  return parsed.angle ? `<${written}>` : written;
}

/**
 * The scope path a link written in `page` reaches, or undefined when it leaves
 * the scope's relative layout (URLs, absolute paths, same-page anchors).
 */
export function linkTarget(page: string, href: string): string | undefined {
  const parsed = parseHref(href);
  if (!parsed) return undefined;
  return resolveIn(posix.dirname(page), parsed.path) ?? undefined;
}

/**
 * The destination to write in place of `href` for a page that was at `oldPage`
 * and is now at `newPage`, or undefined when the link still reaches its target.
 */
function rewrittenHref(
  href: string,
  oldPage: string,
  newPage: string,
  move: KnowledgeRelocation,
): string | undefined {
  const parsed = parseHref(href);
  if (!parsed) return undefined;
  const before = resolveIn(posix.dirname(oldPage), parsed.path);
  if (before === null) return undefined;
  const target = relocatedPath(before, move) ?? before;
  if (resolveIn(posix.dirname(newPage), parsed.path) === target) return undefined;
  let path = posix.relative(posix.dirname(newPage), target) || '.';
  if (parsed.path.endsWith('/') && !path.endsWith('/')) path += '/';
  return formatHref(parsed, path);
}

const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/dg;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*(<[^>]*>|\S+)/d;
const FENCE = /^\s*(```|~~~)/;

/**
 * Calls `visit` with each link destination of a Markdown page — inline links,
 * images and reference definitions — outside fenced code and code spans, and
 * replaces it with what `visit` returns. Returns the new text and how many
 * destinations changed.
 */
function mapLinks(
  markdown: string,
  visit: (href: string) => string | undefined,
): { content: string; links: number } {
  let fenced = false;
  let links = 0;
  const lines = markdown.split('\n').map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const code = [...line.matchAll(/`[^`]*`/g)].map(
      (match) => [match.index, match.index + match[0].length] as const,
    );
    const inCode = (at: number) => code.some(([start, end]) => at >= start && at < end);
    const spans: Array<readonly [number, number]> = [];
    for (const match of line.matchAll(INLINE_LINK))
      if (!inCode(match.index)) spans.push(match.indices![1]!);
    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition && !inCode(definition.index)) spans.push(definition.indices![1]!);
    let result = line;
    // Back to front, so earlier offsets stay valid.
    for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
      const replacement = visit(line.slice(start, end));
      if (replacement === undefined) continue;
      result = result.slice(0, start) + replacement + result.slice(end);
      links++;
    }
    return result;
  });
  return { content: lines.join('\n'), links };
}

/** Rewrites one page's links after `move`; `oldPage` is where the page was before it. */
export function rewritePageLinks(
  markdown: string,
  oldPage: string,
  newPage: string,
  move: KnowledgeRelocation,
): { content: string; links: number } {
  return mapLinks(markdown, (href) => rewrittenHref(href, oldPage, newPage, move));
}

/** How many links in `page` reach `target` or, for a folder, anything inside it. */
export function countLinksTo(markdown: string, page: string, target: string): number {
  let links = 0;
  mapLinks(markdown, (href) => {
    const reached = linkTarget(page, href);
    if (reached !== undefined && isWithin(reached, target)) links++;
    return undefined;
  });
  return links;
}

/** Every Markdown page of the scope's Wiki, as scope paths, sorted. */
async function wikiPages(scopeDir: string): Promise<string[]> {
  const pages: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || pages.length >= MAX_PAGES) return;
    const entries = await readdir(posix.join(scopeDir, rel), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (pages.length >= MAX_PAGES) return;
      if (entry.name === EXTRACTED_TEXT_DIR || entry.name === FILE_HISTORY_DIR) continue;
      if (depth === 0 && SKIPPED_TOP_FOLDERS.has(entry.name)) continue;
      const child = `${rel}/${entry.name}`;
      // Dirents report symlinks as such, so an alias never pulls in pages from elsewhere.
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) pages.push(child);
    }
  };
  await walk(KNOWLEDGE_INSIGHTS_DIR, 0);
  return pages.sort();
}

/** A page's bytes, refusing symlinks and anything too large or not UTF-8 to edit. */
async function readPage(scopeDir: string, page: string): Promise<Buffer | undefined> {
  const handle = await open(
    posix.join(scopeDir, page),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_PAGE_BYTES) return undefined;
    const bytes = await handle.readFile();
    return isUtf8(bytes) ? bytes : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * The Wiki pages of a scope that link to `target` (a page, folder or Source),
 * apart from pages inside `target` itself. What the app shows before a move or
 * rename, so nobody is surprised by pages changing elsewhere.
 */
export async function knowledgeBacklinks(
  scopeDir: string,
  target: string,
): Promise<WikiLinkCount[]> {
  const found: WikiLinkCount[] = [];
  for (const page of await wikiPages(scopeDir)) {
    if (isWithin(page, target)) continue;
    const bytes = await readPage(scopeDir, page);
    if (!bytes) continue;
    const links = countLinksTo(bytes.toString('utf8'), page, target);
    if (links) found.push({ path: page, links });
  }
  return found;
}

/**
 * Rewrites the scope's Wiki after `move` has happened on disk. The caller holds
 * the scope's knowledge mutation lock. Each page is saved through the editor's
 * write path — against the version just read, with file history — so a page an
 * agent changes meanwhile is left alone and reported instead of overwritten.
 */
export async function rewriteWikiLinksAfterMove(
  scopeDir: string,
  move: KnowledgeRelocation,
): Promise<{ linksUpdated: WikiLinkCount[]; warning?: string }> {
  const linksUpdated: WikiLinkCount[] = [];
  const skipped: string[] = [];
  const wiki = {
    root: 'documents' as const,
    dir: posix.join(scopeDir, KNOWLEDGE_INSIGHTS_DIR),
    protectedPaths: [...SKIPPED_TOP_FOLDERS],
  };
  for (const page of await wikiPages(scopeDir)) {
    const inverse = relocatedPath(page, { from: move.to, to: move.from });
    const bytes = await readPage(scopeDir, page);
    if (!bytes) continue;
    const { content, links } = rewritePageLinks(
      bytes.toString('utf8'),
      inverse ?? page,
      page,
      move,
    );
    if (!links) continue;
    const rel = page.slice(KNOWLEDGE_INSIGHTS_DIR.length + 1);
    try {
      const slot = await openKnowledgeFileSlot(wiki, rel);
      try {
        await writeSessionText(slot, content, fileVersion(bytes));
      } finally {
        await slot.close();
      }
    } catch {
      // Changed meanwhile (409) or no longer an ordinary page: reported, not forced.
      skipped.push(page);
      continue;
    }
    linksUpdated.push({ path: page, links });
    // The page is saved; stale search text is a lesser fault than a failed rename.
    await extractKnowledgeFile(scopeDir, page).catch(() => undefined);
  }
  return skipped.length
    ? {
        linksUpdated,
        warning: `Links in ${skipped.join(', ')} could not be updated; check them by hand.`,
      }
    : { linksUpdated };
}
