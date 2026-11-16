import { isUtf8 } from 'node:buffer';
import { opendir } from 'node:fs/promises';
import type { z } from 'zod';
import type { knowledgeToolRequestSchema } from '@verity/events';
import { openDocumentDirectory, readDocument } from './document-workspace.js';
import { projectKnowledgeDir, sharedKnowledgeDir } from './knowledge-folder.js';

type Request = Extract<z.infer<typeof knowledgeToolRequestSchema>, { operation: 'read_wiki_page' }>;
const PAGE_CHARS = 40_000;
const MAX_FILE_BYTES = 4_000_000;
const MAX_DIRECTORY_ENTRIES = 10_000;
const DIRECTORY_PAGE = 200;

/** Read only knowledge, through pinned no-follow descriptors, never a worktree or runtime home. */
export async function readWikiPage(dataRoot: string, projectId: string, request: Request) {
  const parts = request.path.split('/');
  if (
    parts.some(
      (part, index) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[\\\p{Cc}]/u.test(part) ||
        (part.startsWith('.') &&
          !(part === '.text' && (index === 0 || (index === 1 && parts[0] === 'shared')))),
    )
  )
    throw new Error('Invalid knowledge path');
  const shared = parts[0] === 'shared';
  if (shared) parts.shift();
  if (!['insights', 'sources', '.text'].includes(parts[0] ?? ''))
    throw new Error('Only Wiki pages and sources can be read');
  const root = shared ? sharedKnowledgeDir(dataRoot) : projectKnowledgeDir(dataRoot, projectId);
  const path = parts.join('/');
  const offset = request.offset ?? 0;
  if (request.list) {
    const directory = await openDocumentDirectory(root, path);
    try {
      const stream = await opendir(`/proc/self/fd/${directory.fd}`);
      const entries: { name: string; kind: 'directory' | 'file' }[] = [];
      let scanned = 0;
      let truncated = false;
      for await (const entry of stream) {
        if (++scanned > MAX_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (entry.isFile() || entry.isDirectory())
          entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const end = Math.min(entries.length, offset + DIRECTORY_PAGE);
      return {
        path: request.path,
        entries: entries.slice(offset, end),
        truncated,
        ...(end < entries.length ? { nextOffset: end } : {}),
      };
    } finally {
      await directory.close();
    }
  }
  const bytes = await readDocument(root, path, false, MAX_FILE_BYTES);
  if (!bytes) throw new Error('Knowledge file not found');
  if (!isUtf8(bytes) || bytes.includes(0))
    throw new Error('Knowledge file is not text; read its .text counterpart');
  const text = bytes.toString('utf8');
  const end = Math.min(text.length, offset + PAGE_CHARS);
  return {
    path: request.path,
    text: text.slice(offset, end),
    textLength: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
  };
}
