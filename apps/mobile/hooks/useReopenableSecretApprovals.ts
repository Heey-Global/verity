import { type VerityClient, VerityApiError } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

type Requests = Awaited<ReturnType<VerityClient['secretApprovals']['list']>>;
const POLL_INTERVAL_MS = 10_000;
const REFRESH_INTERVAL_MS = 1_000;

function canReadHistory(): boolean {
  if (Platform.OS === 'web' && typeof document !== 'undefined')
    return document.visibilityState === 'visible';
  return AppState.currentState !== 'background';
}

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
  const historyVersion = useRef(0);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const previousRefreshKey = useRef(refreshKey);
  const refreshPending = useRef(false);
  const activeReads = useRef(new WeakMap<VerityClient, Set<string>>());
  const onReadFinished = useRef<(() => void) | undefined>(undefined);
  const lastRead = useRef<
    { client: VerityClient; sessionId: string; at: number; finishedAt?: number } | undefined
  >(undefined);

  useEffect(() => {
    ++generation.current;
    busy.current = false;
    refreshPending.current = false;
    setReopening(undefined);
    setError(undefined);
    setSnapshot(undefined);
  }, [client, sessionId, enabled]);

  // Polls only while this session's screen is focused. Session screens stay
  // mounted beneath the ones pushed over them, so an unscoped timer keeps one
  // poll per screen ever opened running for as long as the app does.
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      const current = generation.current;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reads = activeReads.current.get(client);
      if (!reads) {
        reads = new Set<string>();
        activeReads.current.set(client, reads);
      }
      const pending = reads;
      const isLoading = () => pending.has(sessionId);
      const schedule = (): void => {
        clearTimeout(timer);
        if (stopped || isLoading() || busy.current || !canReadHistory()) return;
        const previous = lastRead.current;
        const interval = refreshPending.current ? REFRESH_INTERVAL_MS : POLL_INTERVAL_MS;
        const remaining =
          previous?.client === client && previous.sessionId === sessionId
            ? Math.max(
                0,
                (refreshPending.current ? previous.at : (previous.finishedAt ?? previous.at)) +
                  interval -
                  Date.now(),
              )
            : 0;
        timer = setTimeout(() => void load(), remaining);
      };
      const load = async (): Promise<void> => {
        if (stopped || isLoading() || busy.current || !canReadHistory()) return;
        refreshPending.current = false;
        const timing: NonNullable<typeof lastRead.current> = { client, sessionId, at: Date.now() };
        lastRead.current = timing;
        const readVersion = historyVersion.current;
        pending.add(sessionId);
        try {
          const requests = await client.secretApprovals.list(sessionId);
          if (!stopped && readVersion === historyVersion.current)
            setSnapshot({ sessionId, requests });
        } catch {
          timing.at = Date.now();
          // Older servers have no history endpoint. Never offer an unverified reopen action.
          if (!stopped && readVersion === historyVersion.current) setSnapshot(undefined);
        } finally {
          timing.finishedAt = Date.now();
          pending.delete(sessionId);
          onReadFinished.current?.();
        }
      };
      const requestRefresh = () => {
        refreshPending.current = true;
        schedule();
      };
      refresh.current = requestRefresh;
      onReadFinished.current = schedule;
      requestRefresh();
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') requestRefresh();
      });
      const webDocument =
        Platform.OS === 'web' && typeof document !== 'undefined' ? document : undefined;
      const refreshWhenVisible = () => requestRefresh();
      webDocument?.addEventListener('visibilitychange', refreshWhenVisible);
      return () => {
        stopped = true;
        if (generation.current === current) refresh.current = undefined;
        if (onReadFinished.current === schedule) onReadFinished.current = undefined;
        clearTimeout(timer);
        subscription.remove();
        webDocument?.removeEventListener('visibilitychange', refreshWhenVisible);
      };
    }, [client, sessionId, enabled]),
  );

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    historyVersion.current += 1;
    setSnapshot(undefined);
    refreshPending.current = true;
    refresh.current?.();
  }, [refreshKey]);

  const reopen = useCallback(
    (id: string): void => {
      if (busy.current) return;
      busy.current = true;
      historyVersion.current += 1;
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
            refresh.current?.();
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
  return useMemo(
    () => ({ statuses, reopening, error, reopen }),
    [statuses, reopening, error, reopen],
  );
}
