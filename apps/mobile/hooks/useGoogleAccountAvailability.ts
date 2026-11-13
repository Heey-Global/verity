import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { VerityClient } from '@verity/mobile';
import { hasConnectedGoogleAccount } from '../lib/sessionGoogleAccess';

type Availability = { connected: boolean; loading: boolean; error: string | null };

// The last answer per client and session. Without it every opening of the menu
// starts from "unknown": the Connect section vanishes until the read returns and
// the menu grows under the finger. A remembered answer is shown at once and
// refreshed in the background, so only the very first opening waits.
const known = new WeakMap<VerityClient, Map<string, boolean>>();

function remembered(client: VerityClient, sessionId: string): boolean | undefined {
  return known.get(client)?.get(sessionId);
}

function remember(client: VerityClient, sessionId: string, connected: boolean) {
  let sessions = known.get(client);
  if (!sessions) known.set(client, (sessions = new Map()));
  sessions.set(sessionId, connected);
}

function initial(client: VerityClient, sessionId: string): Availability {
  return { connected: remembered(client, sessionId) ?? false, loading: false, error: null };
}

/** Account discovery belongs to the open menu, never chat mount or project changes. */
export function useGoogleAccountAvailability(
  client: VerityClient,
  sessionId: string,
  open: boolean,
): Availability {
  const [state, setState] = useState(() => initial(client, sessionId));
  const [identity, setIdentity] = useState({ client, sessionId });
  if (identity.client !== client || identity.sessionId !== sessionId) {
    setIdentity({ client, sessionId });
    setState(initial(client, sessionId));
  }
  useFocusEffect(
    useCallback(() => {
      if (!open) return;
      const controller = new AbortController();
      const last = remembered(client, sessionId);
      // `loading` only while nothing is known: a refresh keeps the last answer.
      setState({ connected: last ?? false, loading: last === undefined, error: null });
      void hasConnectedGoogleAccount(client, sessionId, controller.signal)
        .then((connected) => {
          if (controller.signal.aborted) return;
          remember(client, sessionId, connected);
          setState({ connected, loading: false, error: null });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // A failed refresh keeps the remembered answer; only a first read
          // that fails has nothing to show but the error.
          if (last !== undefined) {
            setState({ connected: last, loading: false, error: null });
            return;
          }
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
