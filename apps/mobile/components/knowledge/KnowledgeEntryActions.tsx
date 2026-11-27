import { createContext, useContext, type ReactNode } from 'react';

import { FileRowActions } from '../files/FileRowActions';
import { canChangeKnowledgeEntry } from './knowledgeRules';

/** What the folder around a catalog row lets the operator do with it; an
 *  action that is absent is not offered, as while another one is running. */
export interface KnowledgeEntryHandlers {
  menu?: ((path: string, label: string) => void) | undefined;
  remove?: ((path: string) => void) | undefined;
}

export const KnowledgeEntryContext = createContext<KnowledgeEntryHandlers>({});

/**
 * A row of a Wiki catalog view (a topic's pages): the same swipe to More and
 * Delete as an explorer row, More opening the same menu. Decisions and other
 * protected entries offer the menu only.
 */
export function KnowledgeEntryActions({
  path,
  label,
  children,
}: {
  path: string;
  label: string;
  children: ReactNode;
}) {
  const { menu, remove } = useContext(KnowledgeEntryContext);
  const onMenu = menu ? () => menu(path, label) : undefined;
  const onDelete = remove && canChangeKnowledgeEntry(path) ? () => remove(path) : undefined;
  if (!onMenu && !onDelete) return children;
  return (
    <FileRowActions label={label} menuLabel="More" onMenu={onMenu} onDelete={onDelete}>
      {children}
    </FileRowActions>
  );
}
