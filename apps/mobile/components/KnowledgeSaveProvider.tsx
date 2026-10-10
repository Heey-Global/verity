import type { VerityClient } from '@verity/mobile';
import { createContext, useMemo, type ReactNode } from 'react';

export const KnowledgeSaveContext = createContext<{
  save(messageId: string, text: string): Promise<void>;
} | null>(null);

export function KnowledgeSaveProvider({
  client,
  sessionId,
  projectId,
  children,
}: {
  client: Pick<VerityClient, 'saveSessionKnowledge'>;
  sessionId: string;
  projectId: string | null | undefined;
  children: ReactNode;
}) {
  // Context changes bypass memoized transcript rows. Unrelated chat updates must
  // not rebuild every mounted Markdown message before showing input feedback.
  const value = useMemo(
    () =>
      projectId
        ? {
            save: async (messageId: string, text: string) => {
              await client.saveSessionKnowledge(sessionId, { messageId, text });
            },
          }
        : null,
    [client, projectId, sessionId],
  );
  return <KnowledgeSaveContext.Provider value={value}>{children}</KnowledgeSaveContext.Provider>;
}
