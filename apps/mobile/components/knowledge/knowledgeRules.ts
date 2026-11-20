/**
 * What may change in a knowledge library — Shared or a project's — the same
 * rules the server applies, said here so the app never offers what it would
 * refuse. Decisions carry provenance, the Sources folders Verity imports into
 * would be recreated empty, and the libraries' own top folders hold them.
 */
const IMPORT_FOLDERS = new Set(['sources/documents', 'sources/meetings', 'sources/matrix']);

export type KnowledgeArea = 'insights' | 'sources';

export function knowledgeArea(path: string): KnowledgeArea | null {
  const first = path.split('/')[0];
  return first === 'insights' || first === 'sources' ? first : null;
}

function ordinary(path: string): boolean {
  return !path
    .split('/')
    .some(
      (part) =>
        part === '' || part === '.' || part === '..' || part === '.text' || part.startsWith(':'),
    );
}

const inDecisions = (path: string) =>
  path === 'insights/decisions' || path.startsWith('insights/decisions/');

/** Rename, Move and Delete: an ordinary entry below a library's top folder. */
export function canChangeKnowledgeEntry(path: string): boolean {
  return (
    knowledgeArea(path) !== null &&
    path.includes('/') &&
    ordinary(path) &&
    !inDecisions(path) &&
    !IMPORT_FOLDERS.has(path)
  );
}

/** Upload, New page and New folder: into a folder of an area, never Decisions. */
export function canAddToKnowledgeFolder(folder: string): boolean {
  return knowledgeArea(folder) !== null && ordinary(folder) && !inDecisions(folder);
}

/** A Wiki page: links to it are rewritten when it moves. */
export function isWikiPage(path: string): boolean {
  return knowledgeArea(path) === 'insights' && /\.md$/i.test(path);
}

/** A folder an entry may move into: its own area, outside Decisions and itself. */
export function canMoveInto(folder: string, moving: readonly string[]): boolean {
  return (
    canAddToKnowledgeFolder(folder) &&
    moving.every(
      (path) =>
        knowledgeArea(path) === knowledgeArea(folder) &&
        folder !== path &&
        !folder.startsWith(`${path}/`),
    )
  );
}
