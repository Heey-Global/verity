// Which paths of a knowledge scope — a project's knowledge folder or Shared —
// the app may change through the knowledge file routes. Both scopes share one
// layout (`insights/` is the Wiki, `sources/` the Sources) and therefore one set
// of rules; the filesystem guards behind the routes (no escape, no symlinked
// parent, no `.text/` mirror) still apply on top of these.
import { EXTRACTED_TEXT_DIR, KNOWLEDGE_INSIGHTS_DIR } from './knowledge-folder.js';
import { FILE_HISTORY_DIR } from './session-file-history.js';

export type KnowledgeArea = 'insights' | 'sources';

/** A checked path: its area and the remainder inside it (`''` for the area itself). */
export interface KnowledgeAreaPath {
  area: KnowledgeArea;
  /** Relative to the area folder, e.g. `topic/page.md` for `insights/topic/page.md`. */
  rel: string;
  /** The full scope path, normalised to forward slashes. */
  path: string;
}

/**
 * The Sources folders Verity's own entry points write into (document imports,
 * meeting transcripts, Matrix rooms). Renamed, moved or deleted, the next import
 * would recreate them empty beside the old one; what they contain is ordinary.
 */
export const SOURCE_IMPORT_FOLDERS: ReadonlySet<string> = new Set([
  'documents',
  'meetings',
  'matrix',
]);

/** Wiki folder holding recorded decisions, whose provenance must stay untouched. */
const DECISIONS_FOLDER = 'decisions';

export class KnowledgePathRefusedError extends Error {}

function areaPath(path: string): KnowledgeAreaPath {
  const parts = path.replaceAll('\\', '/').split('/');
  const area = parts[0];
  if (area !== KNOWLEDGE_INSIGHTS_DIR && area !== 'sources')
    throw new KnowledgePathRefusedError('Only Wiki and Sources entries can be changed here.');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..')
      throw new KnowledgePathRefusedError('This path is not a plain path inside the library.');
    // `:` opens the app's own route segments; `.text` is the derived text mirror.
    if (part.startsWith(':') || part === EXTRACTED_TEXT_DIR || part === FILE_HISTORY_DIR)
      throw new KnowledgePathRefusedError('This path is managed by Verity.');
  }
  const rest = parts.slice(1);
  if (area === KNOWLEDGE_INSIGHTS_DIR && rest[0] === DECISIONS_FOLDER)
    throw new KnowledgePathRefusedError('Recorded decisions cannot be changed here.');
  return { area, rel: rest.join('/'), path: parts.join('/') };
}

/**
 * A folder something is created in or moved into: an area itself (`insights`,
 * `sources`) or any ordinary folder inside one, never the decisions.
 */
export function knowledgeContainer(path: string): KnowledgeAreaPath {
  return areaPath(path);
}

/**
 * An existing entry to rename, move or delete — or the name a new entry is
 * created under. Neither a library root nor a Sources import folder itself.
 */
export function knowledgeEntry(path: string): KnowledgeAreaPath {
  const checked = areaPath(path);
  if (checked.rel === '')
    throw new KnowledgePathRefusedError('The Wiki and Sources folders themselves stay in place.');
  if (checked.area === 'sources' && SOURCE_IMPORT_FOLDERS.has(checked.rel))
    throw new KnowledgePathRefusedError(
      "Verity imports into this folder; it can't be renamed, moved or deleted.",
    );
  return checked;
}

/** `name` placed in `parent`, checked as a new entry would be. */
export function knowledgeChild(parent: KnowledgeAreaPath, name: string): KnowledgeAreaPath {
  return knowledgeEntry(`${parent.path}/${name}`);
}

/**
 * Where moving `entry` into `folder` lands. A move stays in its area — a Wiki
 * page linked from other pages is no Source, nor the reverse — and a folder
 * never moves into itself.
 */
export function knowledgeMoveTarget(entry: KnowledgeAreaPath, folder: string): KnowledgeAreaPath {
  const destination = knowledgeContainer(folder);
  if (destination.area !== entry.area)
    throw new KnowledgePathRefusedError('Entries move within the Wiki or within the Sources.');
  if (destination.path === entry.path || destination.path.startsWith(`${entry.path}/`))
    throw new KnowledgePathRefusedError('A folder cannot be moved into itself.');
  return knowledgeChild(destination, entry.path.slice(entry.path.lastIndexOf('/') + 1));
}
