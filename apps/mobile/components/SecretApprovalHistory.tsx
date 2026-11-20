import { type VerityClient, VerityApiError } from '@verity/mobile';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { Button, Card, Text } from './ui';
import { Disclosure } from './ui/Disclosure';

type Requests = Awaited<ReturnType<VerityClient['secretApprovals']['list']>>;

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
  const generation = useRef(0);
  const refresh = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    const current = ++generation.current;
    let stopped = false;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    busy.current = false;
    setWorking(false);
    setIndex(0);
    setError(undefined);
    setSnapshot(undefined);
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
  }, [client, sessionId, refreshKey]);

  const reopen = async (id: string): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
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
        await refresh.current?.();
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
