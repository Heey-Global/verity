import { actionTitle } from '@verity/events';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { createVerityClient } from '../lib/client';
import { McpAppFrame } from './McpAppFrame.native';
import { appFallback, type McpAppCardEvent } from './McpAppCard.shared';
import { Card } from './ui/Card';
import { Text } from './ui/Text';
import { Button } from './ui/Button';

export function McpAppCard({ event }: { event: McpAppCardEvent }) {
  const client = useMemo(() => createVerityClient(), [event.sessionId, event.appId]);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const failed = useCallback(() => setError(true), []);
  useEffect(() => {
    setError(false);
    setAttempt(0);
  }, [event.sessionId, event.appId]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setActive(state === 'active'),
    );
    return () => subscription.remove();
  }, []);
  return (
    <Card stacked>
      <Text>{actionTitle(event.toolName, event.title, event.source)}</Text>
      {error || !client ? (
        <>
          <Text tone="muted">The interactive app could not be loaded.</Text>
          {client ? (
            <Button
              label="Try again"
              variant="secondary"
              size="compact"
              onPress={() => {
                setError(false);
                setAttempt((value) => value + 1);
              }}
            />
          ) : null}
          <Text variant="label">Last result</Text>
          <Text>{appFallback(event) || 'No saved result.'}</Text>
        </>
      ) : active ? (
        <McpAppFrame
          key={`${event.sessionId}:${event.appId}:${attempt}`}
          event={event}
          client={client}
          failed={failed}
        />
      ) : (
        <Text tone="muted">Interactive app paused.</Text>
      )}
    </Card>
  );
}
