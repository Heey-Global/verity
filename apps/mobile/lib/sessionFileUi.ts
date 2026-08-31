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
