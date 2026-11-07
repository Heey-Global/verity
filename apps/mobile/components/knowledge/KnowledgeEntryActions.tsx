import { createContext, useContext, type ReactNode } from 'react';

import { FileRowActions } from '../files/FileRowActions';

export const KnowledgeDeleteContext = createContext<
  ((path: string, directory: boolean) => void) | undefined
>(undefined);

/** Virtual sections and provenance-bearing decisions are not ordinary files. */
function canDeleteKnowledgeEntry(path: string): boolean {
  return (
    (path.startsWith('insights/') || path.startsWith('sources/')) &&
    !path.startsWith('insights/decisions/') &&
    path !== 'insights/decisions' &&
    !path
      .split('/')
      .some((part) => part === '.' || part === '..' || part === '' || part.startsWith(':'))
  );
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
  const remove = useContext(KnowledgeDeleteContext);
  if (!remove || !canDeleteKnowledgeEntry(path)) return children;
  return (
    <FileRowActions label={label} onDelete={() => remove(path, directory)}>
      {children}
    </FileRowActions>
  );
}
