// The project Wiki as the app reads it: one catalog of its pages, topics,
// decisions and what needs a look, and the rule that turns a link inside a
// page into the knowledge file it opens. Server and app share both, so a link
// the catalog counts as broken is exactly a link the app cannot open.
import { z } from 'zod';

/** A knowledge path the app can open: under the Wiki or the Sources. */
export type KnowledgePath = `insights/${string}` | `sources/${string}`;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The knowledge file a link in `from` (itself a knowledge path such as
 * `insights/topic/page.md`) points at, or null when it leaves the project's
 * knowledge: web and mail links, anchors on the same page, and paths that climb
 * out of it. Absolute `/knowledge/insights/…` and `/knowledge/sources/…` links,
 * which agents write, open the same files as their relative forms.
 */
export function resolveKnowledgeLink(from: string, href: string): KnowledgePath | null {
  let target = href.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  target = target.split('#', 1)[0]!.split('?', 1)[0]!;
  if (target === '' || SCHEME.test(target) || target.startsWith('//')) return null;
  try {
    target = decodeURI(target);
  } catch {
    return null;
  }
  if (target.includes('\\') || target.includes('\0')) return null;
  let segments: string[];
  if (target.startsWith('/')) {
    if (!target.startsWith('/knowledge/')) return null;
    segments = target.slice('/knowledge/'.length).split('/');
  } else {
    segments = [...from.split('/').slice(0, -1), ...target.split('/')];
  }
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return null;
      resolved.pop();
    } else resolved.push(segment);
  }
  if (resolved.length < 2 || (resolved[0] !== 'insights' && resolved[0] !== 'sources')) return null;
  return resolved.join('/') as KnowledgePath;
}

/** `[text](target)` links of a Markdown page, outside code; images are not links. */
export function markdownLinks(markdown: string): { text: string; href: string }[] {
  const links: { text: string; href: string }[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const prose = line.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(
      /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    ))
      if (match[1] !== '!') links.push({ text: match[2]!, href: match[3]! });
  }
  return links;
}

const pathSchema = z.string().min(1).max(1024);

const wikiPageSchema = z.object({
  path: pathSchema,
  title: z.string(),
  summary: z.string(),
  modifiedAt: z.string(),
  /** Knowledge files this page links to, resolved. */
  links: z.array(pathSchema),
  /** Wiki pages that link to this one. */
  linkedFrom: z.array(pathSchema),
  /** The latest log.md entry that names this page: when, what kind, from what. */
  lastChange: z.object({ at: z.string(), kind: z.string(), title: z.string() }).optional(),
});

const wikiTopicSchema = z.object({
  title: z.string(),
  description: z.string(),
  pages: z.array(pathSchema),
});

const wikiDecisionSchema = z.object({
  id: z.string(),
  path: pathSchema,
  title: z.string(),
  createdAt: z.string(),
  // A status this app does not know yet is one it cannot vouch for.
  status: z
    .string()
    .transform((value): 'current' | 'superseded' | 'unresolved' =>
      value === 'current' || value === 'superseded' ? value : 'unresolved',
    ),
  predecessor: z.string().optional(),
  successor: z.string().optional(),
});

const wikiReviewItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('broken_links'), path: pathSchema, targets: z.array(z.string()) }),
  z.object({ kind: z.literal('edit_conflict'), path: pathSchema, conflict: pathSchema }),
]);

export const wikiCatalogSchema = z.object({
  pages: z.array(wikiPageSchema),
  /** The start page Verity maintains, when the Wiki has one. */
  index: z
    .object({
      path: pathSchema,
      modifiedAt: z.string(),
      overview: z.string(),
      topics: z.array(wikiTopicSchema),
    })
    .nullable(),
  decisions: z.array(wikiDecisionSchema),
  /** The change log Verity appends to, when the Wiki has one. Older servers omit it. */
  log: z.object({ path: pathSchema, modifiedAt: z.string() }).nullable().optional(),
  // Kinds of review items added later are left out rather than failing the whole
  // catalog, which would cost an older app its Wiki.
  review: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = wikiReviewItemSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  /** A limit cut the scan short; counts and lists are then partial. */
  truncated: z.boolean(),
});

export type WikiPage = z.infer<typeof wikiPageSchema>;
export type WikiTopic = z.infer<typeof wikiTopicSchema>;
export type WikiDecision = z.infer<typeof wikiDecisionSchema>;
export type WikiReviewItem = z.infer<typeof wikiReviewItemSchema>;
export type WikiCatalog = z.infer<typeof wikiCatalogSchema>;

/** The start page and the change log are the Wiki's own pages, not topics' pages. */
export const WIKI_INDEX = 'insights/index.md';
export const WIKI_LOG = 'insights/log.md';
/** The project's own Wiki rules (the "schema"), written at setup and changed with Verity. */
export const WIKI_CONVENTIONS = 'insights/wiki-conventions.md';

/** The kinds of change log.md records, in its `## [YYYY-MM-DD] kind | Title` headings. */
export const WIKI_LOG_KINDS = ['setup', 'ingest', 'chat', 'merge', 'lint'] as const;

export interface WikiLogEntry {
  /** The entry's day, `YYYY-MM-DD`. */
  at: string;
  kind: string;
  title: string;
  /** The knowledge files the entry links to: the pages it changed and its sources. */
  links: KnowledgePath[];
}

/**
 * The entries of log.md in file order. An entry is a `## [YYYY-MM-DD] kind |
 * Title` heading and the lines up to the next heading; other headings and text
 * are kept by the file but are no entries. Links resolve from log.md itself.
 */
export function parseWikiLog(markdown: string): WikiLogEntry[] {
  const entries: WikiLogEntry[] = [];
  let current: WikiLogEntry | null = null;
  for (const line of markdown.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      const match = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s+([a-z][a-z-]*)\s*\|\s*(.+?)\s*$/.exec(line);
      current = match ? { at: match[1]!, kind: match[2]!, title: match[3]!, links: [] } : null;
      if (current) entries.push(current);
      continue;
    }
    if (!current) continue;
    for (const link of markdownLinks(line)) {
      const target = resolveKnowledgeLink(WIKI_LOG, link.href);
      if (target && !current.links.includes(target)) current.links.push(target);
    }
  }
  return entries;
}
