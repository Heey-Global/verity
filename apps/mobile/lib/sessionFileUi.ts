import type { SessionFileEntry } from '@verity/mobile';
import { isTextPreviewCandidate } from './fileSelection';

export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function fileSizeLabel(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function modifiedAtLabel(modifiedAt: string | null): string {
  if (modifiedAt === null) return '';
  const date = new Date(modifiedAt);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function fileEntryMeta(entry: SessionFileEntry): string {
  const parts = [];
  if (entry.kind === 'file') {
    const size = fileSizeLabel(entry.size);
    if (size.length > 0) parts.push(size);
  }
  const modified = modifiedAtLabel(entry.modifiedAt);
  if (modified.length > 0) parts.push(modified);
  return parts.join(' · ');
}

export function fileIcon(entry: SessionFileEntry): 'folder' | 'file-text' | 'file' | 'link' {
  if (entry.kind === 'directory') return 'folder';
  if (entry.kind === 'symlink') return 'link';
  if (entry.kind === 'file' && isTextPreviewCandidate(entry.path)) return 'file-text';
  return 'file';
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 33) ^ input.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

export function cacheDirectoryName(sessionId: string, path: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `verity-share-${safeSession}-${hashString(path)}`;
}

export async function loadSharingModule(): Promise<typeof import('expo-sharing') | undefined> {
  try {
    return await import('expo-sharing');
  } catch {
    return undefined;
  }
}

/** Like {@link loadSharingModule}: a build without the native print module (an
 * older dev client, Jest) reports printing as unavailable instead of crashing. */
export async function loadPrintModule(): Promise<typeof import('expo-print') | undefined> {
  try {
    return await import('expo-print');
  } catch {
    return undefined;
  }
}

/** The name a file's PDF export is shared under: `notes/a.md` → `a.pdf`. */
export function pdfFileName(path: string): string {
  const name = path.split('/').filter(Boolean).pop() ?? 'document';
  const stem = name.replace(/\.[^.]+$/, '');
  return `${stem.length > 0 ? stem : name}.pdf`;
}

/** The folders a breadcrumb walks through to reach `path`, each with the path a
 * tap on it navigates to: `a/b` → `[{ a, 'a' }, { b, 'a/b' }]`. The root itself is
 * not a segment; the breadcrumb draws it as the active tab's icon. */
export function breadcrumbSegments(path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

/** Why `name` cannot replace `currentName` in a folder holding `siblings`, or
 * `null` when it can. Mirrors the server's file-name rule so the dialog can say
 * what is wrong before a round trip; the server still has the final word, since
 * the agent may take the name between the check and the request. */
export function renameProblem(
  name: string,
  currentName: string,
  siblings: readonly string[],
): string | null {
  if (name.trim().length === 0) return 'Enter a name.';
  if (name !== name.trim()) return 'Names cannot start or end with a space.';
  if (name === '.' || name === '..') return 'This name is reserved.';
  if (/[\0\\/]/.test(name)) return 'Names cannot contain / or \\.';
  if (new TextEncoder().encode(name).length > 255) return 'This name is too long.';
  if (name !== currentName && siblings.includes(name)) return `"${name}" already exists here.`;
  return null;
}
