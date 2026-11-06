import { createContext, useContext } from 'react';

import type { KnowledgeScope } from './knowledgeScope';

/**
 * The wide layout's right column, offered to knowledge browsers in its left
 * column: a file opens there for reading while the folder list stays where it
 * is. Absent on a phone and on full-width screens, where a file is its own
 * screen instead.
 */
export interface KnowledgePane {
  openFile: (scope: KnowledgeScope, file: string) => void;
}

export const KnowledgePaneContext = createContext<KnowledgePane | null>(null);

export function useKnowledgePane(): KnowledgePane | null {
  return useContext(KnowledgePaneContext);
}
