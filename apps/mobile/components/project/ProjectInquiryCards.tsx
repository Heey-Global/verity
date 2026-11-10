import { type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useProjectInquiries } from '../../hooks/useProjectInquiries';
import { Button, Card, CardHead, StatusTag, Text } from '../ui';

/** The same durable target-side approval is shown on Home and in the session. */
export function ProjectInquiryCards({
  client,
  sessionId,
  projectId,
}: {
  client: VerityClient;
  sessionId?: string;
  projectId?: string;
}) {
  const resource = useProjectInquiries(client, sessionId, projectId);
  const [busy, setBusy] = useState<string>();
  const decide = async (targetSessionId: string, id: string, decision: 'approve' | 'reject') => {
    setBusy(id);
    try {
      await client.decideProjectInquiry(targetSessionId, id, decision);
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not save decision.');
    } finally {
      setBusy(undefined);
    }
  };
  const items = (resource.data ?? []).filter(
    (item) => projectId === undefined || item.targetProjectId === projectId,
  );
  // A failed permissions query must remain visible: otherwise a pending request looks absent.
  return (
    <>
      {resource.error ? (
        <Card stacked>
          <Text tone="attention">{resource.error}</Text>
          <Button label="Retry project requests" variant="text" onPress={resource.reload} />
        </Card>
      ) : null}
      {items.map((item) => (
        <Card stacked key={item.id}>
          <CardHead
            title={item.title}
            subtitle={`From project ${item.sourceProjectName ?? item.sourceProjectId} · session ${item.sourceSessionId}`}
            trailing={
              <StatusTag
                intent={item.status === 'pending' ? 'needsSetup' : 'optional'}
                label={item.status}
              />
            }
          />
          <Text>{item.body}</Text>
          {item.answer ? <Text>{item.answer}</Text> : null}
          {item.kind === 'change' &&
          item.status === 'pending' &&
          (sessionId === undefined || sessionId === item.targetSessionId) ? (
            <>
              <Text variant="subtitle">
                Approve this scope of work in the target project. Existing project permissions still
                apply.
              </Text>
              <View>
                <Button
                  label="Approve change"
                  loading={busy === item.id}
                  disabled={busy !== undefined}
                  onPress={() => void decide(item.targetSessionId, item.id, 'approve')}
                />
                <Button
                  label="Reject change"
                  variant="secondary"
                  disabled={busy !== undefined}
                  onPress={() => void decide(item.targetSessionId, item.id, 'reject')}
                />
              </View>
            </>
          ) : null}
          {sessionId !== item.targetSessionId ? (
            <Button
              label="Open target session"
              variant="text"
              onPress={() =>
                router.push({ pathname: '/session/[id]', params: { id: item.targetSessionId } })
              }
            />
          ) : null}
        </Card>
      ))}
    </>
  );
}
