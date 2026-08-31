import { lstat, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

export type SessionFileKind = 'directory' | 'file' | 'symlink' | 'other';

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
