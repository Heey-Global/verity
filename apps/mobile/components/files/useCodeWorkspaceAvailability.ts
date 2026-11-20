import { useEffect, useRef } from 'react';
import type { SessionDirectory, VerityClient } from '@verity/mobile';

/** Refresh the listing when another turn or client restores an unavailable checkout. */
export function useCodeWorkspaceAvailability({
  client,
  sessionId,
  codeAvailable,
  onAvailable,
  onReload,
}: {
  client: Pick<VerityClient, 'listSessionFiles'>;
  sessionId: string;
  codeAvailable: boolean;
  onAvailable: (directory: SessionDirectory) => void;
  onReload: () => void;
}) {
  const callbacks = useRef({ onAvailable, onReload });
  callbacks.current = { onAvailable, onReload };
  useEffect(() => {
    if (codeAvailable) return;
    let active = true;
    const timer = setInterval(() => {
      void client
        .listSessionFiles(sessionId, '', 'worktree')
        .then((directory) => {
          if (!active || !directory.codeAvailable) return;
          active = false;
          clearInterval(timer);
          callbacks.current.onAvailable(directory);
          callbacks.current.onReload();
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, sessionId, codeAvailable]);
}
