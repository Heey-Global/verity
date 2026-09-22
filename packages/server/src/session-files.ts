import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { EXTRACTED_TEXT_DIR, SHARED_KNOWLEDGE_DIR } from './knowledge-folder.js';

type SessionFileKind = 'directory' | 'file' | 'symlink' | 'other';

/**
 * The directories the session explorer can browse (ADR 0022 D2): the session's
 * worktree, the project's knowledge folder, and the shared knowledge folder.
 *
 * The root is a separate parameter rather than a reserved first path segment,
 * because a worktree may legitimately contain a top-level `knowledge/` or
 * `shared/` directory of its own and reserving those names would hide it.
 */
export const SESSION_FILE_ROOTS = ['worktree', 'knowledge', 'shared'] as const;

export type SessionFileRootName = (typeof SESSION_FILE_ROOTS)[number];

/** The two knowledge roots, which share every rule the worktree does not. */
export function isKnowledgeRoot(root: SessionFileRootName): boolean {
  return root === 'knowledge' || root === 'shared';
}

/**
 * Names omitted from a listing of `root` at `rel`. Hidden, not forbidden: a
 * hidden path can still be read, which is what lets the file preview show a
 * PDF's extracted text from `.text/`.
 */
export function hiddenSessionFileNames(root: SessionFileRootName, rel: string): readonly string[] {
  if (root === 'worktree') return ['.git'];
  // `.text/` mirrors every file, and a project folder carries an empty `shared/`
  // as the mount point for the shared folder (which has an explorer root of its
  // own). Listing either would show the same material twice.
  if (root === 'knowledge' && rel === '') return [EXTRACTED_TEXT_DIR, SHARED_KNOWLEDGE_DIR];
  return [EXTRACTED_TEXT_DIR];
}

/**
 * Paths inside a knowledge root the operator may browse but not change: the
 * root itself, the derived `.text/` mirror (it follows its file, and deleting
 * it on its own would leave the file unreadable to an agent with no way to
 * notice), and the empty `shared/` mount point, whose real contents live under
 * the Shared root.
 */
export function isManagedKnowledgePath(root: SessionFileRootName, rel: string): boolean {
  if (rel === '') return true;
  const first = rel.split('/')[0];
  if (first === EXTRACTED_TEXT_DIR) return true;
  return root === 'knowledge' && first === SHARED_KNOWLEDGE_DIR;
}

export interface SessionFileEntry {
  name: string;
  path: string;
  kind: SessionFileKind;
  size: number | null;
  modifiedAt: string | null;
}

function isHiddenGitPath(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === '.git');
}

export function normalizeSessionRelativePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0)
    .join('/');
}

export function sessionFilePath(
  worktree: string,
  requestedPath: string,
): { abs: string; rel: string } {
  if (isAbsolute(requestedPath) || isHiddenGitPath(requestedPath)) throw new Error('invalid path');
  const root = resolve(worktree);
  const abs = resolve(root, requestedPath);
  const relToRoot = relative(root, abs);
  if (relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
    throw new Error('invalid path');
  }
  const rel = normalizeSessionRelativePath(relToRoot);
  if (isHiddenGitPath(rel)) throw new Error('invalid path');
  return { abs, rel };
}

export async function assertSessionRealPath(worktree: string, abs: string): Promise<void> {
  const rootReal = await realpath(worktree);
  const absReal = await realpath(abs);
  const rel = relative(rootReal, absReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('invalid path');
  }
}

/** A file inside a knowledge root, addressed through an open descriptor on its
 *  parent directory so the write below cannot be redirected after validation. */
export interface KnowledgeFileSlot {
  /** `/proc/self/fd/<n>` of the validated parent directory. */
  directoryPath: string;
  /** The file's own name within that directory. */
  name: string;
  /** The file's path relative to the knowledge root. */
  rel: string;
  close: () => Promise<void>;
}

/** Thrown for a path the operator may browse but not change. */
export class ManagedKnowledgePathError extends Error {}

/**
 * Validate `path` inside a knowledge root and open its parent directory.
 *
 * Same guards as the worktree routes — no escape, no `.git`, realpath inside the
 * root — plus {@link isManagedKnowledgePath}. Resolving through the descriptor
 * afterwards is what makes a delete or move act on the inode that was checked,
 * not on whatever the path names by the time the syscall runs. The caller owns
 * {@link KnowledgeFileSlot.close}.
 */
export async function openKnowledgeFileSlot(
  target: { root: SessionFileRootName; dir: string },
  path: string,
): Promise<KnowledgeFileSlot> {
  const { rel } = sessionFilePath(target.dir, path);
  if (isManagedKnowledgePath(target.root, rel)) {
    throw new ManagedKnowledgePathError('this path is managed by Verity');
  }
  const name = basename(rel);
  const parent = sessionFilePath(target.dir, rel.slice(0, Math.max(0, rel.length - name.length)));
  const handle = await open(
    parent.abs,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  const directoryPath = `/proc/self/fd/${String(handle.fd)}`;
  const close = async (): Promise<void> => {
    await handle.close().catch(() => undefined);
  };
  try {
    await assertSessionRealPath(target.dir, await realpath(directoryPath));
  } catch (error) {
    await close();
    throw error;
  }
  return { directoryPath, name, rel, close };
}

function sessionFileKind(stats: Awaited<ReturnType<typeof lstat>>): SessionFileKind {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function toSessionFileEntry(
  path: string,
  name: string,
  stats: Awaited<ReturnType<typeof lstat>>,
): SessionFileEntry {
  const kind = sessionFileKind(stats);
  return {
    name,
    path,
    kind,
    size: kind === 'file' ? Number(stats.size) : null,
    modifiedAt: Number.isFinite(stats.mtimeMs) ? stats.mtime.toISOString() : null,
  };
}

export function isProbablyText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return !bytes.toString('utf8').includes('\uFFFD');
}

export function contentTypeForDownload(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.txt':
    case '.md':
    case '.json':
    case '.jsonl':
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.css':
    case '.html':
    case '.xml':
    case '.yml':
    case '.yaml':
      return 'text/plain; charset=utf-8';
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/** RFC 6266/5987 Content-Disposition with an ASCII fallback for Node headers. */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
