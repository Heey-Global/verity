import { type ProjectEgressPolicy, type VerityClient, VerityApiError } from '@verity/mobile';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { Button, Card, CardHead, Text } from './ui';
import { usePermissionHaptic } from './usePermissionHaptic';

/** DNS is attributed to the project, so these cards deliberately describe project scope. */
export function NetworkApprovalPrompt({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [snapshot, setSnapshot] = useState<{
    projectId: string;
    policy: ProjectEgressPolicy;
  }>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const refresh = useRef<(() => Promise<void>) | undefined>(undefined);
  const busy = useRef(false);
  const generation = useRef(0);
  const policyVersion = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    let stopped = false;
    let fetching = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(undefined);
    setError(undefined);
    setWorking(false);
    busy.current = false;
    const load = async (): Promise<void> => {
      if (stopped || fetching || busy.current || AppState.currentState === 'background') return;
      fetching = true;
      const version = policyVersion.current;
      try {
        const policy = await client.getProjectEgress(projectId);
        if (!stopped && policyVersion.current === version) setSnapshot({ projectId, policy });
      } catch (caught) {
        // A failed refresh must not leave stale approval buttons actionable.
        if (!stopped && policyVersion.current === version) {
          setSnapshot(undefined);
          if (!(caught instanceof VerityApiError && [403, 404].includes(caught.status)))
            setError('Could not refresh network requests. Try again.');
        }
      } finally {
        fetching = false;
      }
    };
    refresh.current = load;
    const poll = async (): Promise<void> => {
      await load();
      if (!stopped) timer = setTimeout(() => void poll(), 5000);
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
  }, [client, projectId]);

  const policy = snapshot?.projectId === projectId ? snapshot.policy : undefined;
  const pending = Object.values(policy?.requests ?? {})
    .filter((request) => request.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
  const request = pending[0];
  usePermissionHaptic(true, request?.id);

  const decide = async (allow: boolean | 'review'): Promise<void> => {
    if (!request || !policy || busy.current) return;
    const current = generation.current;
    busy.current = true;
    policyVersion.current++;
    setWorking(true);
    setError(undefined);
    try {
      if (allow === 'review') {
        await client.reopenProjectEgress(projectId, {
          target: request.target,
          revision: policy.revision,
        });
      } else {
        await client.decideProjectEgress(projectId, {
          requestId: request.id,
          revision: policy.revision,
          allow,
        });
      }
      if (generation.current === current) setSnapshot(undefined);
    } catch (caught) {
      if (generation.current === current) {
        setSnapshot(undefined);
        setError(
          caught instanceof VerityApiError && caught.status === 403
            ? 'Managing network requests requires project management permission.'
            : caught instanceof VerityApiError && caught.status === 409
              ? 'Network rules changed. Review the refreshed request before deciding.'
              : 'Could not save your network decision. Try again.',
        );
      }
    } finally {
      if (generation.current === current) {
        busy.current = false;
        setWorking(false);
        await refresh.current?.();
      }
    }
  };

  if (!request && !error) return null;
  const stale = request !== undefined && request.revision !== policy?.revision;
  return (
    <Card attention stacked>
      <CardHead title="Network access needs your approval" />
      {request ? (
        <>
          <Text>{`${request.target.host} · ${request.target.protocol.toUpperCase()} ${request.target.port}`}</Text>
          <Text tone="muted">
            A process in this project requested access. Allowing it lets every session and
            background process in this project send data to this destination for one hour. This does
            not grant access to secrets. Retry the blocked action after approval.
          </Text>
          {pending.length > 1 ? (
            <Text>{`${pending.length} network requests awaiting a decision`}</Text>
          ) : null}
          {stale ? (
            <>
              <Text tone="attention">
                Network rules changed. Review this request again before approving it.
              </Text>
              <Button
                label="Review current request"
                variant="secondary"
                disabled={working}
                onPress={() => void decide('review')}
              />
            </>
          ) : (
            <>
              <Button
                label="Allow for one hour"
                disabled={working}
                onPress={() => void decide(true)}
              />
              <Button
                label="Deny"
                variant="secondary"
                disabled={working}
                onPress={() => void decide(false)}
              />
            </>
          )}
        </>
      ) : null}
      {error ? <Text tone="attention">{error}</Text> : null}
      {error ? (
        <Button
          label="Refresh network requests"
          variant="secondary"
          onPress={() => void refresh.current?.()}
        />
      ) : null}
    </Card>
  );
}
