import { connectionFailureKind, type InquiryDecision, type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useProjectInquiries } from '../../hooks/useProjectInquiries';
import { useConnectionRecovered, useHidesConnectionError } from '../../hooks/useServerConnection';
import { Button, Card, CardHead, Sheet, StatusTag, Text } from '../ui';
import { SessionBar, SessionBarContent, SessionBarTarget } from '../ui/SessionBar';

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
  const [openSession, setOpenSession] = useState<string>();
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggleUnfolded = (id: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const { theme } = useUnistyles();
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
  const cards = (
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
        // A long request would push its decision buttons out of view.
        const long = [item.body, item.answer ?? ''].some(isLong);
        const full = unfolded.has(item.id);
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
              <Text variant="subtitle">{item.title}</Text>
              <Text variant="bodySmall" numberOfLines={full ? undefined : CLAMPED_LINES}>
                {item.body}
              </Text>
            </View>
            {item.answer ? (
              <Text numberOfLines={full ? undefined : CLAMPED_LINES}>{item.answer}</Text>
            ) : null}
            {long ? (
              <Button
                label={full ? 'Show less' : 'Show full request'}
                variant="text"
                size="small"
                onPress={() => toggleUnfolded(item.id)}
              />
            ) : null}
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
                onPress={() => {
                  setOpenSession(undefined);
                  router.push({ pathname: '/session/[id]', params: { id: item.targetSessionId } });
                }}
              />
            ) : null}
          </Card>
        );
      })}
    </>
  );
  if (sessionId === undefined) return cards;

  const visible = openSession === sessionId;
  const hasRequests = items.length > 0 || Boolean(resource.error);
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const subtitle = resource.error
    ? 'Could not load project requests'
    : pendingCount > 0
      ? `${pendingCount} awaiting approval`
      : items.length === 1
        ? items[0]?.title
        : `${items.length} requests`;
  // The chat pins this area outside the transcript. Keep even multiple long
  // requests in a single row and let the sheet scroll their full details.
  return (
    <>
      {hasRequests ? (
        <SessionBar>
          <SessionBarTarget
            accessibilityLabel="Project requests"
            accessibilityHint={subtitle}
            expanded={visible}
            onPress={() => setOpenSession(sessionId)}
          >
            <SessionBarContent
              color={
                pendingCount > 0 || resource.error ? theme.colors.attention : theme.colors.textMuted
              }
              title="Project requests"
              subtitle={subtitle}
            />
          </SessionBarTarget>
        </SessionBar>
      ) : null}
      {visible ? (
        <Sheet visible title="Project requests" onClose={() => setOpenSession(undefined)}>
          {hasRequests ? cards : <Text variant="subtitle">No project requests.</Text>}
        </Sheet>
      ) : null}
    </>
  );
}

const CLAMPED_LINES = 6;
const isLong = (text: string) => text.length > 320 || text.split('\n').length > CLAMPED_LINES;

const styles = StyleSheet.create((theme) => ({
  quote: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
