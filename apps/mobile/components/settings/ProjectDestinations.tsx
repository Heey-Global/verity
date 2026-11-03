import { type ProjectEgressPolicy, type VerityClient, VerityApiError } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Text } from '../ui';
import { SettingsGroup, SettingsPanel } from './SettingsChrome';

/** Destination rules are project settings; saving one never activates the host fence. */
export function ProjectDestinations({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [policy, setPolicy] = useState<ProjectEgressPolicy>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const busy = useRef<false | symbol>(false);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await client.getProjectEgress(projectId);
      if (generation.current !== current) return;
      setPolicy(next);
      setNow(Date.now());
    } catch (caught) {
      if (generation.current !== current) return;
      setPolicy(undefined);
      setError(
        caught instanceof VerityApiError && caught.status === 403
          ? 'You do not have permission to view destination rules.'
          : caught instanceof VerityApiError && caught.status === 404
            ? 'Update your server to manage destination rules.'
            : 'Could not load destination rules. Try again.',
      );
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    setPolicy(undefined);
    setError(undefined);
    setForbidden(false);
    busy.current = false;
    setWorking(false);
    void load();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const change = async (operation: () => Promise<void>) => {
    if (busy.current || loading || forbidden) return;
    const operationId = Symbol();
    busy.current = operationId;
    setWorking(true);
    setError(undefined);
    const current = generation.current;
    try {
      await operation();
      if (generation.current !== current) return;
      await load();
    } catch (caught) {
      if (generation.current !== current) return;
      if (caught instanceof VerityApiError && caught.status === 403) {
        setForbidden(true);
        setError('Managing destination rules requires project management permission.');
      } else if (caught instanceof VerityApiError && caught.status === 409) {
        setError(
          'Destination rules changed or the request expired. Review the refreshed list before deciding again.',
        );
      } else {
        setError(
          'Could not save destination rules. Review the refreshed list before trying again.',
        );
      }
      // A dropped response can hide a successful write. Re-read without replaying it.
      await load();
    } finally {
      if (busy.current === operationId) {
        busy.current = false;
        setWorking(false);
      }
    }
  };

  const pending = Object.values(policy?.requests ?? {}).filter(
    (request) =>
      request.status === 'pending' &&
      request.expiresAt > now &&
      request.revision === policy?.revision,
  );
  const grants = (policy?.grants ?? []).filter(
    (grant) => grant.revokedAt === undefined && (grant.expiresAt === null || grant.expiresAt > now),
  );
  const previous = Object.values(policy?.requests ?? {}).filter(
    (request) =>
      !pending.includes(request) &&
      !grants.some(
        (grant) =>
          grant.target.host === request.target.host &&
          grant.target.protocol === request.target.protocol &&
          grant.target.port === request.target.port,
      ),
  );
  const disabled = loading || working || forbidden;
  return (
    <SettingsGroup title="Network destinations">
      <Text tone="muted">
        Allowing a destination lets every session and background process in this project send data
        to that exact host, protocol and port. Approval lasts one hour. These rules do not turn on
        network protection.
      </Text>
      {error ? (
        <Text tone="attention" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button
        label={loading ? 'Loading destinations…' : 'Refresh destinations'}
        variant="secondary"
        size="compact"
        disabled={loading || working}
        onPress={() => {
          setError(undefined);
          setForbidden(false);
          void load();
        }}
      />
      {policy ? (
        <>
          <Text variant="subtitle">Pending requests</Text>
          {pending.length === 0 ? (
            <Text tone="muted">No pending destination requests.</Text>
          ) : (
            pending.map((request) => {
              const target = `${request.target.host} · ${request.target.protocol.toUpperCase()} ${request.target.port}`;
              return (
                <SettingsPanel key={request.id}>
                  <Text>{target}</Text>
                  <Text tone="muted">
                    Request expires {new Date(request.expiresAt).toLocaleString()}
                  </Text>
                  <Button
                    label="Allow for one hour"
                    accessibilityLabel={`Allow ${target} for one hour`}
                    disabled={disabled}
                    onPress={() =>
                      void change(() =>
                        client.decideProjectEgress(projectId, {
                          requestId: request.id,
                          revision: policy.revision,
                          allow: true,
                        }),
                      )
                    }
                  />
                  <Button
                    label="Deny"
                    accessibilityLabel={`Deny ${target}`}
                    variant="secondary"
                    disabled={disabled}
                    onPress={() =>
                      void change(() =>
                        client.decideProjectEgress(projectId, {
                          requestId: request.id,
                          revision: policy.revision,
                          allow: false,
                        }),
                      )
                    }
                  />
                </SettingsPanel>
              );
            })
          )}
          {previous.length ? (
            <>
              <Text variant="subtitle">Requests needing review</Text>
              {previous.map((request) => {
                const target = `${request.target.host} · ${request.target.protocol.toUpperCase()} ${request.target.port}`;
                return (
                  <SettingsPanel key={request.id}>
                    <Text>{target}</Text>
                    <Text tone="muted">
                      {request.status === 'denied'
                        ? 'Previously denied'
                        : 'A fresh request is required before approval.'}
                    </Text>
                    <Button
                      label="Request approval again"
                      accessibilityLabel={`Request approval again for ${target}`}
                      variant="secondary"
                      disabled={disabled}
                      onPress={() =>
                        void change(() =>
                          client.reopenProjectEgress(projectId, {
                            target: request.target,
                            revision: policy.revision,
                          }),
                        )
                      }
                    />
                  </SettingsPanel>
                );
              })}
            </>
          ) : null}
          <Text variant="subtitle">Granted destinations</Text>
          {grants.length === 0 ? (
            <Text tone="muted">No active destination grants.</Text>
          ) : (
            grants.map((grant) => {
              const target = `${grant.target.host} · ${grant.target.protocol.toUpperCase()} ${grant.target.port}`;
              return (
                <SettingsPanel key={grant.id}>
                  <Text>{target}</Text>
                  <Text tone="muted">
                    {grant.expiresAt === null
                      ? 'No expiry'
                      : `Expires ${new Date(grant.expiresAt).toLocaleString()}`}
                  </Text>
                  <Button
                    label="Revoke"
                    accessibilityLabel={`Revoke ${target}`}
                    variant="secondary"
                    disabled={disabled}
                    onPress={() =>
                      void change(() =>
                        client.revokeProjectEgress(projectId, {
                          grantId: grant.id,
                          revision: policy.revision,
                        }),
                      )
                    }
                  />
                </SettingsPanel>
              );
            })
          )}
        </>
      ) : null}
    </SettingsGroup>
  );
}
