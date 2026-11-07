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
  status: z.enum(['current', 'superseded', 'unresolved']),
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
  review: z.array(wikiReviewItemSchema),
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
