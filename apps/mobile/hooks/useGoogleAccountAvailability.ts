import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { VerityClient } from '@verity/mobile';
import { hasConnectedGoogleAccount } from '../lib/sessionGoogleAccess';

/** Account discovery belongs to the open menu, never chat mount or project changes. */
export function useGoogleAccountAvailability(
  client: VerityClient,
  sessionId: string,
  open: boolean,
) {
  const [state, setState] = useState({
    connected: false,
    loading: false,
    error: null as string | null,
  });
  const [identity, setIdentity] = useState({ client, sessionId });
  if (identity.client !== client || identity.sessionId !== sessionId) {
    setIdentity({ client, sessionId });
    setState({ connected: false, loading: false, error: null });
  }
  useFocusEffect(
    useCallback(() => {
      if (!open) return;
      const controller = new AbortController();
      setState({ connected: false, loading: true, error: null });
      void hasConnectedGoogleAccount(client, sessionId, controller.signal)
        .then((connected) => {
          if (!controller.signal.aborted) setState({ connected, loading: false, error: null });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setState({
              connected: false,
              loading: false,
              error: 'Could not load Google accounts. Close and reopen to retry.',
            });
        });
      return () => controller.abort();
    }, [client, sessionId, open]),
  );
  return state;
}
