import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { projectKnowledgeDir } from './knowledge-folder.js';

export interface MeetingKnowledgeExcerpt {
  path: string;
  text: string;
}

const MAX_FILES = 64;
const MAX_FILE_BYTES = 64_000;
const MAX_EXCERPTS = 4;
const MAX_EXCERPT_CHARS = 1_000;
const MAX_DEPTH = 3;

function terms(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(
      (word) =>
        !['this', 'that', 'with', 'from', 'dass', 'eine', 'einer', 'nicht', 'haben'].includes(word),
    ),
  );
}

/** Small, bounded fallback until Project Knowledge has a retrieval index. */
export async function meetingKnowledgeExcerpts(
  dataRoot: string,
  projectId: string,
  transcript: string,
): Promise<MeetingKnowledgeExcerpt[]> {
  const root = projectKnowledgeDir(dataRoot, projectId);
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return [];
  const realRoot = await realpath(root);
  const paths: string[] = [];
  let inspected = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || paths.length >= MAX_FILES || inspected >= 256) return;
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    const resolved = await realpath(dir).catch(() => undefined);
    if (
      !resolved ||
      isAbsolute(relative(realRoot, resolved)) ||
      relative(realRoot, resolved).startsWith('..')
    )
      return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        if (paths.length >= MAX_FILES || ++inspected > 256) break;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) paths.push(path);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  for (const part of ['overview.md', 'insights', 'sources', '.text']) {
    const path = join(root, part);
    if (part === 'overview.md') paths.push(path);
    else await visit(path, 0);
  }
  const query = terms(transcript.slice(-6_000));
  const ranked: Array<MeetingKnowledgeExcerpt & { score: number }> = [];
  for (const path of paths.slice(0, MAX_FILES)) {
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        content = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close();
      }
      const chunks = content.match(/[^\n]{1,1000}/g) ?? [];
      let best = { score: 0, text: '' };
      for (const chunk of chunks) {
        const score = [...terms(chunk)].filter((word) => query.has(word)).length;
        if (score > best.score) best = { score, text: chunk.trim().slice(0, MAX_EXCERPT_CHARS) };
      }
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const sourcePath = relativePath.startsWith('.text/sources/')
        ? relativePath.slice('.text/'.length).replace(/\.md$/, '')
        : relativePath;
      if (best.score > 0)
        ranked.push({
          path: sourcePath,
          text: best.text,
          score: best.score,
        });
    } catch {
      // A source may disappear during ingestion; never fail transcript analysis.
    }
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_EXCERPTS)
    .map(({ path, text }) => ({ path, text }));
}
