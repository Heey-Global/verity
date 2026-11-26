import { type VerityClient, VerityApiError } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { Button, Card, Text } from './ui';
import { Disclosure } from './ui/Disclosure';

type Requests = Awaited<ReturnType<VerityClient['secretApprovals']['list']>>;
const POLL_INTERVAL_MS = 10_000;
const REFRESH_INTERVAL_MS = 1_000;

function canReadHistory(): boolean {
  if (Platform.OS === 'web' && typeof document !== 'undefined')
    return document.visibilityState === 'visible';
  return AppState.currentState !== 'background';
}

/** Reconsideration is an explicit user action, never an agent's automatic retry. */
export function SecretApprovalHistory({
  client,
  sessionId,
  refreshKey,
}: {
  client: VerityClient;
  sessionId: string;
  refreshKey?: string | undefined;
}) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; requests: Requests }>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const [index, setIndex] = useState(0);
  const busy = useRef(false);
  const historyVersion = useRef(0);
  const generation = useRef(0);
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
    setWorking(false);
    setIndex(0);
    setError(undefined);
    setSnapshot(undefined);
  }, [client, sessionId]);

  // Polls only while this session's screen is focused. Session screens stay
  // mounted beneath the ones pushed over them, so an unscoped timer keeps one
  // poll per screen ever opened running for as long as the app does.
  useFocusEffect(
    useCallback(() => {
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
    }, [client, sessionId]),
  );

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    historyVersion.current += 1;
    refreshPending.current = true;
    refresh.current?.();
  }, [refreshKey]);

  const reopen = async (id: string): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    historyVersion.current += 1;
    const current = generation.current;
    setWorking(true);
    setError(undefined);
    try {
      await client.secretApprovals.reopen(sessionId, id);
      if (generation.current === current) {
        setSnapshot(
          (old) => old && { ...old, requests: old.requests.filter((request) => request.id !== id) },
        );
      }
    } catch (caught) {
      if (generation.current === current)
        setError(
          caught instanceof VerityApiError && caught.status === 403
            ? 'You do not have permission to reopen this request.'
            : 'Could not reopen this request. Refresh and try again.',
        );
    } finally {
      if (generation.current === current) {
        busy.current = false;
        setWorking(false);
        refresh.current?.();
      }
    }
  };

  const requests = snapshot?.sessionId === sessionId ? snapshot.requests : [];
  const selectedIndex = Math.min(index, Math.max(0, requests.length - 1));
  if (requests.length === 0 && !error) return null;
  return (
    <Card flush>
      <Disclosure title="Previous secret requests" subtitle="Reopen a request to review it again">
        <Text tone="muted">Reopening asks for fresh approval. It does not run the action.</Text>
        {requests.slice(selectedIndex, selectedIndex + 1).map((request) => (
          <Card stacked key={request.id}>
            <Text variant="subtitle">
              {request.summary ??
                (request.toolName === 'verity_http_request'
                  ? 'Secret HTTP request'
                  : 'Secret command')}
            </Text>
            <Text tone="muted">
              {request.status === 'denied' ? 'Denied' : 'Approval was not used in time'}
            </Text>
            <Button
              label="Review request again"
              accessibilityLabel={`Review secret request ${request.id} again`}
              disabled={working}
              onPress={() => void reopen(request.id)}
            />
          </Card>
        ))}
        {requests.length > 1 ? (
          <Button
            label={`Next request (${selectedIndex + 1} of ${requests.length})`}
            variant="text"
            onPress={() => setIndex((selectedIndex + 1) % requests.length)}
          />
        ) : null}
        {error ? <Text tone="attention">{error}</Text> : null}
      </Disclosure>
    </Card>
  );
}
