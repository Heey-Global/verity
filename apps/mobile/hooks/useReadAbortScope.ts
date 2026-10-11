import { useCallback, useEffect, useRef } from 'react';

/** A screen identity owns its reads, including replacements from live refresh. */
export function useReadAbortScope(client: object, sessionId: string): () => AbortController {
  const current = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      current.current?.abort();
      current.current = null;
    },
    [client, sessionId],
  );
  return useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller;
  }, [client, sessionId]);
}
