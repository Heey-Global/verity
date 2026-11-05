import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Where a Shared knowledge file lives, as the app names the three areas. */
type SharedKnowledgeArea = 'decisions' | 'wiki' | 'sources';

export type RecentSharedKnowledgeEntry = {
  /** Relative to the Shared root, with `/` separators. */
  path: string;
  title: string;
  area: SharedKnowledgeArea;
  modifiedAt: string;
  /** For a confirmed decision: the session and time its header records. */
  decision?: { sessionId: string; confirmedAt: string };
};

export const RECENT_SHARED_LIMIT_MAX = 20;
/** The walk stops after this many files, so a large library cannot stall the page. */
const RECENT_SHARED_SCAN_MAX = 2_000;
/** Enough of a file for its header and first heading. */
const HEAD_BYTES = 4_096;

function areaOf(path: string): SharedKnowledgeArea | undefined {
  if (path.startsWith('insights/decisions/')) return 'decisions';
  if (path.startsWith('insights/')) return 'wiki';
  if (path.startsWith('sources/')) return 'sources';
  return undefined;
}

const DECISION_HEADER = /<!--\s*verity-decision:v1\s+(\{.*?\})\s*-->/s;

/** The title and decision provenance a file's first bytes carry. */
export function describeHead(
  path: string,
  head: string,
): Pick<RecentSharedKnowledgeEntry, 'title' | 'decision'> {
  let decision: RecentSharedKnowledgeEntry['decision'];
  const header = DECISION_HEADER.exec(head);
  if (header) {
    try {
      const value = JSON.parse(header[1]!) as { sessionId?: unknown; createdAt?: unknown };
      if (typeof value.sessionId === 'string' && typeof value.createdAt === 'string')
        decision = { sessionId: value.sessionId, confirmedAt: value.createdAt };
    } catch {
      // A damaged header leaves the file listed, just without provenance.
    }
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(head.replace(DECISION_HEADER, ''));
  const title = heading?.[1] ?? basename(path).replace(/\.[^.]+$/, '');
  return decision ? { title, decision } : { title };
}

async function readHead(file: string): Promise<string> {
  // A file swapped for a link after the walk must not be read through it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The most recently changed files of the Shared library, newest first. Only the
 * three areas the app shows are walked; hidden entries, derived text and symbolic
 * links are skipped, so nothing outside the root is ever read.
 */
export async function recentSharedKnowledge(
  root: string,
  limit: number,
  scanMax = RECENT_SHARED_SCAN_MAX,
): Promise<{
  entries: RecentSharedKnowledgeEntry[];
  /** The library holds more files than were scanned; newer ones may be missing. */
  truncated: boolean;
}> {
  const files: { path: string; mtime: number }[] = [];
  // readdir follows a link given as its own path, so the two starting folders
  // are checked here; inside the walk Dirent types already exclude links.
  const queue: string[] = [];
  for (const top of ['insights', 'sources']) {
    const info = await lstat(join(root, top)).catch(() => undefined);
    if (info?.isDirectory()) queue.push(top);
  }
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    const relative = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= scanMax) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) {
        const info = await stat(join(root, path)).catch(() => undefined);
        if (info) files.push({ path, mtime: info.mtimeMs });
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const recent: RecentSharedKnowledgeEntry[] = [];
  for (const file of files) {
    if (recent.length >= limit) break;
    const area = areaOf(file.path);
    if (!area) continue;
    const text = /\.(md|markdown|txt)$/i.test(file.path)
      ? await readHead(join(root, file.path)).catch(() => '')
      : '';
    recent.push({
      path: file.path,
      area,
      modifiedAt: new Date(file.mtime).toISOString(),
      ...describeHead(file.path, text),
    });
  }
  return { entries: recent, truncated };
}
