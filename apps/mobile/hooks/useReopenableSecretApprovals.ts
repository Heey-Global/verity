import { type VerityClient, VerityApiError } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

type Requests = Awaited<ReturnType<VerityClient['secretApprovals']['list']>>;
export type ReopenableStatus = Requests[number]['status'];

export interface ReopenableSecretApprovals {
  /** What the server reports it can reopen, by approval id. The transcript card
   *  of a secret request carries the same id, so it looks itself up here. */
  statuses: ReadonlyMap<string, ReopenableStatus>;
  /** The approval being reopened right now. */
  reopening: string | undefined;
  error: { id: string; text: string } | undefined;
  /** Asks for a fresh decision. It neither approves nor runs anything. */
  reopen: (id: string) => void;
}

const NONE: ReadonlyMap<string, ReopenableStatus> = new Map();

/** Reconsideration is an explicit user action, never an agent's automatic retry. */
export function useReopenableSecretApprovals(
  client: VerityClient,
  sessionId: string,
  enabled: boolean,
  refreshKey?: string,
): ReopenableSecretApprovals {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; requests: Requests }>();
  const [error, setError] = useState<{ id: string; text: string }>();
  const [reopening, setReopening] = useState<string>();
  const busy = useRef(false);
  const generation = useRef(0);
  const refresh = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    ++generation.current;
    busy.current = false;
    setReopening(undefined);
    setError(undefined);
    setSnapshot(undefined);
  }, [client, sessionId, enabled, refreshKey]);

  // Polls only while this session's screen is focused. Session screens stay
  // mounted beneath the ones pushed over them, so an unscoped timer keeps one
  // poll per screen ever opened running for as long as the app does.
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      const current = generation.current;
      let stopped = false;
      let loading = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const load = async (): Promise<void> => {
        if (stopped || loading || busy.current || AppState.currentState === 'background') return;
        loading = true;
        try {
          const requests = await client.secretApprovals.list(sessionId);
          if (!stopped) setSnapshot({ sessionId, requests });
        } catch {
          // Older servers have no history endpoint. Never offer an unverified reopen action.
          if (!stopped) setSnapshot(undefined);
        } finally {
          loading = false;
        }
      };
      refresh.current = load;
      const poll = async (): Promise<void> => {
        await load();
        if (!stopped) timer = setTimeout(() => void poll(), 10000);
      };
      void poll();
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') void load();
      });
      return () => {
        stopped = true;
        if (generation.current === current) refresh.current = undefined;
        clearTimeout(timer);
        subscription.remove();
      };
    }, [client, sessionId, enabled, refreshKey]),
  );

  const reopen = useCallback(
    (id: string): void => {
      if (busy.current) return;
      busy.current = true;
      const current = generation.current;
      setReopening(id);
      setError(undefined);
      void (async () => {
        try {
          await client.secretApprovals.reopen(sessionId, id);
          if (generation.current === current)
            setSnapshot(
              (old) =>
                old && { ...old, requests: old.requests.filter((request) => request.id !== id) },
            );
        } catch (caught) {
          if (generation.current === current)
            setError({
              id,
              text:
                caught instanceof VerityApiError && caught.status === 403
                  ? 'You do not have permission to reopen this request.'
                  : 'Could not reopen this request. Refresh and try again.',
            });
        } finally {
          if (generation.current === current) {
            busy.current = false;
            setReopening(undefined);
            await refresh.current?.();
          }
        }
      })();
    },
    [client, sessionId],
  );

  const requests = snapshot?.sessionId === sessionId ? snapshot.requests : undefined;
  const statuses = useMemo(
    () =>
      requests === undefined
        ? NONE
        : new Map(requests.map((request) => [request.id, request.status] as const)),
    [requests],
  );
  return { statuses, reopening, error, reopen };
}
