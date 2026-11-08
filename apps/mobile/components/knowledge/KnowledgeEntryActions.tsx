import { createContext, useContext, type ReactNode } from 'react';

import { FileRowActions } from '../files/FileRowActions';

/** What the folder around an entry lets the operator do with it; an action
 *  that is absent is not offered, as while another one is still running. */
export interface KnowledgeEntryHandlers {
  remove?: ((path: string, directory: boolean) => void) | undefined;
  rename?: ((path: string, directory: boolean) => void) | undefined;
}

export const KnowledgeEntryContext = createContext<KnowledgeEntryHandlers>({});

/** The Sources folders Verity's entry points write into; the server refuses to
 *  rename them, since the next import would recreate them empty. */
const SOURCE_ENTRY_FOLDERS = new Set(['sources/documents', 'sources/meetings', 'sources/matrix']);

function ordinaryPath(path: string): boolean {
  return !path
    .split('/')
    .some((part) => part === '.' || part === '..' || part === '' || part.startsWith(':'));
}

/** Virtual sections and provenance-bearing decisions are not ordinary files. */
function canDeleteKnowledgeEntry(path: string): boolean {
  return (
    (path.startsWith('insights/') || path.startsWith('sources/')) &&
    !path.startsWith('insights/decisions/') &&
    path !== 'insights/decisions' &&
    ordinaryPath(path)
  );
}

/** Only Sources: a renamed Wiki page would break every link to it. */
function canRenameKnowledgeEntry(path: string): boolean {
  return path.startsWith('sources/') && !SOURCE_ENTRY_FOLDERS.has(path) && ordinaryPath(path);
}

export function KnowledgeEntryActions({
  path,
  label,
  directory = false,
  children,
}: {
  path: string;
  label: string;
  directory?: boolean;
  children: ReactNode;
}) {
  const { remove, rename } = useContext(KnowledgeEntryContext);
  const onDelete =
    remove && canDeleteKnowledgeEntry(path) ? () => remove(path, directory) : undefined;
  const onRename =
    rename && canRenameKnowledgeEntry(path) ? () => rename(path, directory) : undefined;
  if (!onDelete && !onRename) return children;
  return (
    <FileRowActions label={label} onDelete={onDelete} onRename={onRename}>
      {children}
    </FileRowActions>
  );
}
