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
  /** A file or folder got a new path: the open file follows it there. */
  moved?: (scope: KnowledgeScope, from: string, to: string) => void;
}

export const KnowledgePaneContext = createContext<KnowledgePane | null>(null);

export function useKnowledgePane(): KnowledgePane | null {
  return useContext(KnowledgePaneContext);
}

/**
 * Where an open file is after `from` got the path `to` — itself, or a folder
 * around it. Anything else, including the same path in another library, stays.
 */
export function followMove<T extends { scope: KnowledgeScope; file: string }>(
  open: T | null,
  scope: KnowledgeScope,
  from: string,
  to: string,
): T | null {
  if (!open || !sameScope(open.scope, scope)) return open;
  if (open.file !== from && !open.file.startsWith(`${from}/`)) return open;
  return { ...open, file: `${to}${open.file.slice(from.length)}` };
}

function sameScope(a: KnowledgeScope, b: KnowledgeScope): boolean {
  return a.kind === 'project'
    ? b.kind === 'project' && a.projectId === b.projectId
    : b.kind === a.kind;
}
