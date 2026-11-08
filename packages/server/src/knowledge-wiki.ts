// The catalog behind the app's project Wiki: every page's title, first
// paragraph, links and age, the topics of the start page Verity maintains,
// decisions with their computed status, and what needs a look. Read with the
// same symlink-refusing primitives as every other knowledge read, and bounded,
// so a large or hostile Wiki costs a partial catalog rather than the server.
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';
import {
  markdownLinks,
  parseWikiLog,
  resolveKnowledgeLink,
  WIKI_CONVENTIONS,
  WIKI_INDEX,
  WIKI_LOG,
  type KnowledgePath,
  type WikiCatalog,
  type WikiPage,
  type WikiReviewItem,
  type WikiLogEntry,
  type WikiTopic,
} from '@verity/events';
import { openDocumentDirectory, readDocument } from './document-workspace.js';
import { projectDecisionSummaries } from './knowledge-decisions.js';

const MAX_PAGES = 1000;
const MAX_DEPTH = 6;
const MAX_PAGE_BYTES = 512 * 1024;
/** log.md only grows; past this its newest part is read, from the first whole line on. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_CONFLICTS = 50;
/** Linked files the scan did not read, looked up on disk per request. */
const MAX_DISK_CHECKS = 200;
const MAX_SUMMARY = 240;
/** Links kept per page; a page past it is cut, and the catalog says so. */
const MAX_LINKS_PER_PAGE = 200;
/** Not pages: decision records have their own list, conflicts their own item. */
const OWN_FOLDERS = new Set(['decisions', 'Conflicts']);

/** What the catalog keeps of a page once read: never its whole text. */
interface ReadPage {
  path: string;
  modifiedAt: string;
  title: string;
  summary: string;
  links: KnowledgePath[];
  index?: { overview: string; topics: WikiTopic[] };
  log?: WikiLogEntry[];
}

/** Inline Markdown as plain text: link texts, no emphasis or code marks. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string): string {
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/** A file name as a title, for a page without a heading. */
function nameTitle(path: string): string {
  const name = (path.split('/').at(-1) ?? path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The page's first top-level heading and the first paragraph of prose after it. */
export function pageHeadline(path: string, markdown: string): { title: string; summary: string } {
  let title: string | undefined;
  let summary: string | undefined;
  let paragraph: string[] = [];
  let fenced = false;
  let comment = false;
  const finish = () => {
    if (summary === undefined && paragraph.length) summary = clip(plain(paragraph.join(' ')));
    paragraph = [];
  };
  const lines = markdown.split('\n');
  // Frontmatter is metadata, not the page's first paragraph.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) lines.splice(0, end + 1);
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (comment || line.startsWith('<!--')) {
      finish();
      comment = !line.includes('-->');
      continue;
    }
    if (/^(```|~~~)/.test(line)) {
      finish();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      finish();
      if (title === undefined && heading[1]!.length === 1) title = plain(heading[2]!);
      continue;
    }
    if (
      line === '' ||
      line.startsWith('|') ||
      line.startsWith('>') ||
      /^([-*+]|\d+[.)])\s/.test(line) ||
      /^([-*_])(\s*\1){2,}$/.test(line)
    ) {
      finish();
      continue;
    }
    paragraph.push(line);
    if (title !== undefined && summary !== undefined) break;
  }
  finish();
  return { title: title || nameTitle(path), summary: summary ?? '' };
}

/**
 * The start page's overview and topics. The overview is the prose between the
 * page's title and its first second-level heading; every `## Heading` after it
 * is a topic, its first paragraph the description and its links the pages.
 */
export function parseWikiIndex(markdown: string): { overview: string; topics: WikiTopic[] } {
  const overview: string[] = [];
  const topics: WikiTopic[] = [];
  let topic: { title: string; description: string[]; body: string[] } | undefined;
  const close = () => {
    if (!topic) return;
    const pages = [
      ...new Set(
        markdownLinks(topic.body.join('\n'))
          .map((link) => resolveKnowledgeLink(WIKI_INDEX, link.href))
          .filter((path): path is `insights/${string}` => path?.startsWith('insights/') === true),
      ),
    ];
    const description = plain(topic.description.join(' '));
    // A heading used twice is one topic: the app opens topics by their title.
    const same = topics.find((other) => other.title === topic!.title);
    if (same) {
      same.pages = [...new Set([...same.pages, ...pages])];
      same.description ||= description;
    } else topics.push({ title: topic.title, description, pages });
  };
  let descriptionDone = false;
  let fenced = false;
  let comment = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    // A comment is the start page's own metadata, not part of the overview.
    if (comment || line.startsWith('<!--')) {
      comment = !line.includes('-->');
      continue;
    }
    // Inside a code block a heading is an example, not a topic.
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,2})\s+(.*)$/.exec(line);
    if (heading?.[1] === '#' && !topic) continue;
    if (heading?.[1] === '##') {
      close();
      topic = { title: plain(heading[2]!), description: [], body: [] };
      descriptionDone = false;
      continue;
    }
    if (!topic) {
      overview.push(raw);
      continue;
    }
    topic.body.push(raw);
    if (descriptionDone) continue;
    if (line === '' || /^([-*+]|\d+[.)])\s/.test(line) || line.startsWith('#')) {
      if (topic.description.length) descriptionDone = true;
      continue;
    }
    topic.description.push(line);
  }
  close();
  return { overview: overview.join('\n').trim(), topics };
}

/**
 * The last `maxBytes` of a file, starting at its first whole line. The change
 * log is append-only, so its newest entries are the ones a page's origin needs;
 * a log that outgrew any limit must not take every origin with it.
 */
async function readTail(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    if (start === 0) return data;
    const newline = data.indexOf(10);
    return newline < 0 ? Buffer.alloc(0) : data.subarray(newline + 1);
  } finally {
    await file.close();
  }
}

/** Markdown pages under `insights`, depth-first, refusing links and bounded. */
async function readPages(insights: string): Promise<{ pages: ReadPage[]; truncated: boolean }> {
  const pages: ReadPage[] = [];
  let truncated = false;
  let bytes = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    let handle;
    try {
      handle = path
        ? await openDocumentDirectory(insights, path)
        : await open(insights, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      // A project that has written no Wiki yet has an empty one, not a broken one.
      if (!path && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const entries = (await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (pages.length >= MAX_PAGES || bytes >= MAX_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!path && OWN_FOLDERS.has(entry.name)) continue;
          await walk(rel, depth + 1).catch(() => {
            truncated = true;
          });
          continue;
        }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        try {
          const stat = await lstat(`/proc/self/fd/${handle.fd}/${entry.name}`);
          const content =
            `insights/${rel}` === WIKI_LOG
              ? await readTail(`/proc/self/fd/${handle.fd}/${entry.name}`, MAX_LOG_BYTES)
              : await readDocument(insights, rel, false, MAX_PAGE_BYTES);
          if (!content || !isUtf8(content) || content.includes(0)) continue;
          bytes += content.length;
          const markdown = content.toString('utf8');
          const page = `insights/${rel}`;
          pages.push({
            path: page,
            modifiedAt: stat.mtime.toISOString(),
            ...pageHeadline(page, markdown),
            links: (() => {
              const links = [
                ...new Set(
                  markdownLinks(markdown)
                    .map((link) => resolveKnowledgeLink(page, link.href))
                    .filter((target): target is KnowledgePath => target !== null),
                ),
              ];
              if (links.length <= MAX_LINKS_PER_PAGE) return links;
              truncated = true;
              return links.slice(0, MAX_LINKS_PER_PAGE);
            })(),
            ...(page === WIKI_INDEX ? { index: parseWikiIndex(markdown) } : {}),
            ...(page === WIKI_LOG ? { log: parseWikiLog(markdown) } : {}),
          });
        } catch {
          // Oversized, replaced while read, or not a plain file: left out, and said so.
          truncated = true;
        }
      }
    } finally {
      await handle.close();
    }
  };
  await walk('', 0);
  return { pages, truncated };
}

/** Pages whose edits collided with a newer version, from the Wiki's `Conflicts`. */
async function readConflicts(
  insights: string,
): Promise<{ items: WikiReviewItem[]; truncated: boolean }> {
  let handle;
  try {
    handle = await openDocumentDirectory(insights, 'Conflicts');
  } catch (error) {
    // No conflicts is the usual case; a folder that cannot be read hides some.
    const code = (error as NodeJS.ErrnoException).code;
    return { items: [], truncated: code !== 'ENOENT' };
  }
  const items: WikiReviewItem[] = [];
  let truncated: boolean;
  try {
    const entries = (await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));
    truncated = entries.length > MAX_CONFLICTS;
    for (const entry of entries.slice(0, MAX_CONFLICTS)) {
      try {
        const raw = await readDocument(
          insights,
          `Conflicts/${entry.name}/conflict.json`,
          false,
          16_384,
        );
        if (!raw) continue;
        const record = JSON.parse(raw.toString('utf8')) as { path?: unknown };
        if (typeof record.path !== 'string') continue;
        const page = resolveKnowledgeLink('insights/x.md', record.path);
        if (!page?.startsWith('insights/')) continue;
        items.push({
          kind: 'edit_conflict',
          path: page,
          conflict: `insights/Conflicts/${entry.name}`,
        });
      } catch {
        continue;
      }
    }
  } finally {
    await handle.close();
  }
  return { items, truncated };
}

/** Whether a knowledge file exists, without following links out of the root. A
 *  folder is no file: the app cannot open a link to one, so it counts as broken. */
async function fileExists(knowledgeRoot: string, path: string): Promise<boolean> {
  try {
    const parts = path.split('/');
    const directory = await openDocumentDirectory(knowledgeRoot, parts.slice(0, -1).join('/'));
    try {
      const stat = await lstat(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`);
      return stat.isFile();
    } finally {
      await directory.close();
    }
  } catch {
    return false;
  }
}

/** The project Wiki under `knowledgeRoot` as the app's start page reads it. */
export async function projectWikiCatalog(knowledgeRoot: string): Promise<WikiCatalog> {
  const insights = join(knowledgeRoot, 'insights');
  const [{ pages: read, truncated: pagesCut }, decisionState, conflicts] = await Promise.all([
    readPages(insights).catch(() => ({ pages: [] as ReadPage[], truncated: true })),
    // Without decisions the Wiki still reads; the catalog says it is partial.
    projectDecisionSummaries(knowledgeRoot).catch(() => ({ decisions: [], incomplete: true })),
    readConflicts(insights).catch(() => ({ items: [] as WikiReviewItem[], truncated: true })),
  ]);
  let truncated = pagesCut || decisionState.incomplete || conflicts.truncated;
  const decisionPaths = new Set(decisionState.decisions.map((decision) => decision.path));
  const known = new Set([...read.map((page) => page.path), ...decisionPaths]);
  const linkedFrom = new Map<string, Set<string>>();
  const review: WikiReviewItem[] = [];
  const diskChecks = new Map<string, Promise<boolean>>();
  const pages: WikiPage[] = [];
  let index: WikiCatalog['index'] = null;
  let log: WikiCatalog['log'] = null;
  let conventions: WikiCatalog['conventions'] = null;
  // The latest log entry per page. Entries are appended in order, so a later one
  // of the same day wins; a page the log never names keeps its file age alone.
  const lastChange = new Map<string, NonNullable<WikiPage['lastChange']>>();
  for (const entry of read.find((page) => page.path === WIKI_LOG)?.log ?? [])
    for (const target of entry.links) {
      const previous = lastChange.get(target);
      if (!previous || previous.at <= entry.at)
        lastChange.set(target, { at: entry.at, kind: entry.kind, title: entry.title });
    }
  for (const page of read) {
    const links = page.links;
    const broken: string[] = [];
    for (const target of links) {
      // A page the scan read or a decision is known; anything else the app could
      // open (a source, an image, a page past the limits) is looked up on disk,
      // so a link counts as broken only when there is nothing to open.
      if (!known.has(target)) {
        // Past the limit a link is unchecked, not broken, and the catalog partial.
        if (!diskChecks.has(target) && diskChecks.size >= MAX_DISK_CHECKS) truncated = true;
        else {
          if (!diskChecks.has(target)) diskChecks.set(target, fileExists(knowledgeRoot, target));
          if (!(await diskChecks.get(target))) broken.push(target);
        }
      }
      // The start page, the log and the rules link everything; as backlinks they say nothing.
      if (
        target !== page.path &&
        page.path !== WIKI_INDEX &&
        page.path !== WIKI_LOG &&
        page.path !== WIKI_CONVENTIONS
      ) {
        const from = linkedFrom.get(target) ?? new Set<string>();
        from.add(page.path);
        linkedFrom.set(target, from);
      }
    }
    if (broken.length) review.push({ kind: 'broken_links', path: page.path, targets: broken });
    if (page.index) {
      index = { path: page.path, modifiedAt: page.modifiedAt, ...page.index };
      continue;
    }
    if (page.path === WIKI_LOG) {
      log = { path: page.path, modifiedAt: page.modifiedAt };
      continue;
    }
    if (page.path === WIKI_CONVENTIONS) {
      conventions = { path: page.path, modifiedAt: page.modifiedAt };
      continue;
    }
    const change = lastChange.get(page.path);
    pages.push({
      path: page.path,
      title: page.title,
      summary: page.summary,
      modifiedAt: page.modifiedAt,
      links,
      linkedFrom: [],
      ...(change ? { lastChange: change } : {}),
    });
  }
  for (const page of pages) page.linkedFrom = [...(linkedFrom.get(page.path) ?? [])].sort();
  return {
    pages,
    index,
    decisions: decisionState.decisions,
    log,
    conventions,
    review: [...conflicts.items, ...review],
    truncated,
  };
}
