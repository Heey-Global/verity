import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import type { VerityClient } from '@verity/mobile';
import { subscribeLiveRefresh } from '../lib/liveConnection';

/** One focused owner, with cancellation and serialized live refreshes. */
export function useFocusedSessionRead(
  client: VerityClient,
  sessionId: string,
  resource: string,
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<void>,
): void {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const controller = new AbortController();
      const path = `/sessions/${encodeURIComponent(sessionId)}/${resource}`;
      const detach = subscribeLiveRefresh(
        client,
        () => read(controller.signal),
        (observed) => observed === path,
        [{ path }],
        { initial: true },
      );
      return () => {
        controller.abort();
        detach();
      };
    }, [client, sessionId, resource, enabled, read]),
  );
}
