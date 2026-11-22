import type { CollaborationEntry, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';

import { useFocusedSessionRead } from './useFocusedSessionRead';

/**
 * The sessions this one works with, for the header row and its sheet. Read
 * while the session is focused and refreshed live; cleared on a session switch
 * so one session's peers never show under another's title.
 */
export function useSessionCollaboration(client: VerityClient, sessionId: string, ready: boolean) {
  const [entries, setEntries] = useState<CollaborationEntry[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    setEntries([]);
    setSheetOpen(false);
  }, [client, sessionId]);
  const read = useCallback(
    async (signal: AbortSignal) => {
      const next = await client.sessionCollaboration.read(sessionId, signal);
      if (!signal.aborted) setEntries(next);
    },
    [client, sessionId],
  );
  useFocusedSessionRead(client, sessionId, 'collaboration', ready, read);
  return {
    entries,
    sheetOpen,
    openSheet: useCallback(() => setSheetOpen(true), []),
    closeSheet: useCallback(() => setSheetOpen(false), []),
  };
}
