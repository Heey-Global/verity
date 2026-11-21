import { connectionFailureKind, type InquiryDecision, type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useProjectInquiries } from '../../hooks/useProjectInquiries';
import { useConnectionRecovered, useHidesConnectionError } from '../../hooks/useServerConnection';
import { Button, Card, CardHead, StatusTag, Text } from '../ui';

/**
 * A request from a session to another project. The same durable approval is
 * shown in the asking session, on Home and on the target project's page, and
 * nothing reaches the target before "Allow once" or "Always allow".
 */
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
  // During a server update the header's connection bar says so; this card only
  // reports failures that are its own, and asks again once the server is back.
  const hidesError = useHidesConnectionError(resource.error);
  useConnectionRecovered(() => {
    if (connectionFailureKind(resource.error) !== undefined) resource.reload();
  });
  const [busy, setBusy] = useState<string>();
  const decide = async (targetProjectId: string, id: string, decision: InquiryDecision) => {
    setBusy(id);
    try {
      await client.decideProjectInquiry(targetProjectId, id, decision);
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
  // A failed permissions query must remain visible: otherwise a pending request
  // looks absent. While the header's bar shows an outage, it says so quietly,
  // without the raw error or a retry the bar already offers.
  return (
    <>
      {resource.error && hidesError ? (
        <Card stacked>
          <Text variant="subtitle">Project requests load once the server is back.</Text>
        </Card>
      ) : resource.error ? (
        <Card stacked>
          <Text tone="attention">{resource.error}</Text>
          <Button label="Retry project requests" variant="text" onPress={resource.reload} />
        </Card>
      ) : null}
      {items.map((item) => {
        const question = item.kind === 'question';
        const pending = item.status === 'pending';
        const source = item.sourceProjectName ?? item.sourceProjectId;
        const target = item.targetProjectName ?? item.targetProjectId;
        // Who asks whom comes first: the card is answered outside the asking session.
        const origin =
          sessionId === item.sourceSessionId
            ? 'From this session'
            : `From session „${item.sourceSessionName ?? item.sourceSessionId}“`;
        return (
          <Card stacked key={item.id}>
            <CardHead
              title={`${source} → ${target}`}
              subtitle={`${origin} · ${question ? 'read-only' : 'may change code'}`}
              trailing={
                <StatusTag
                  intent={pending ? 'needsSetup' : 'optional'}
                  label={pending ? (question ? 'Question' : 'Change') : item.status}
                />
              }
            />
            <View style={styles.quote}>
              <Text variant="bodySmall">{item.body}</Text>
            </View>
            {item.answer ? <Text>{item.answer}</Text> : null}
            {pending ? (
              <View style={styles.actions}>
                <Button
                  label="Allow once"
                  size="small"
                  loading={busy === item.id}
                  disabled={busy !== undefined}
                  onPress={() => void decide(item.targetProjectId, item.id, 'approve')}
                />
                {question ? (
                  <Button
                    label="Always allow"
                    size="small"
                    variant="secondary"
                    accessibilityLabel={`Always allow questions from ${source} to ${target}`}
                    disabled={busy !== undefined}
                    onPress={() => void decide(item.targetProjectId, item.id, 'approve_always')}
                  />
                ) : null}
                <Button
                  label="Reject"
                  size="small"
                  variant="text"
                  disabled={busy !== undefined}
                  onPress={() => void decide(item.targetProjectId, item.id, 'reject')}
                />
              </View>
            ) : null}
            {/* The target session exists only once a request was allowed. */}
            {sessionId !== item.targetSessionId &&
            ['approved', 'queued', 'answered'].includes(item.status) ? (
              <Button
                label="Open target session"
                variant="text"
                onPress={() =>
                  router.push({ pathname: '/session/[id]', params: { id: item.targetSessionId } })
                }
              />
            ) : null}
          </Card>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  quote: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
