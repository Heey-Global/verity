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
  const [loaded, setLoaded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    setSheetOpen(false);
  }, [client, sessionId]);
  const read = useCallback(
    async (signal: AbortSignal) => {
      const next = await client.sessionCollaboration.read(sessionId, signal);
      if (signal.aborted) return;
      setEntries(next);
      setLoaded(true);
    },
    [client, sessionId],
  );
  useFocusedSessionRead(client, sessionId, 'collaboration', ready, read);
  const openSheet = useCallback(() => setSheetOpen(true), []);
  return {
    entries,
    /** Spread onto CollaborationRow. */
    row: { entries, loaded, onOpenList: openSheet },
    sheetOpen,
    closeSheet: useCallback(() => setSheetOpen(false), []),
  };
}
