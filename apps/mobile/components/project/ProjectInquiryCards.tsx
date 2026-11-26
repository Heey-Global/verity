import {
  connectionFailureKind,
  type InquiryDecision,
  type ProjectInquiry,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useProjectInquiries } from '../../hooks/useProjectInquiries';
import { useConnectionRecovered, useHidesConnectionError } from '../../hooks/useServerConnection';
import { Button, Card, CardHead, IconButton, Sheet, StatusTag, Text } from '../ui';
import { SessionBar, SessionBarContent, SessionBarTarget } from '../ui/SessionBar';

type InquiryResource = ReturnType<typeof useProjectInquiries>;
type Decide = (targetProjectId: string, id: string, decision: InquiryDecision) => void;

/** Saves a decision and reloads the shared list; one decision at a time. */
export function useInquiryDecisions(client: VerityClient, resource: InquiryResource) {
  const [busy, setBusy] = useState<string>();
  const decide: Decide = (targetProjectId, id, decision) => {
    setBusy(id);
    void client
      .decideProjectInquiry(targetProjectId, id, decision)
      .then(resource.reload, (error: unknown) =>
        resource.setError(error instanceof Error ? error.message : 'Could not save decision.'),
      )
      .finally(() => setBusy(undefined));
  };
  return { busy, decide };
}

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
  if (sessionId !== undefined)
    return <SessionInquiryRow client={client} resource={resource} sessionId={sessionId} />;
  return <InquiryCardList client={client} resource={resource} projectId={projectId} />;
}

/** Every request the resource holds, each as a card with its decision. */
function InquiryCardList({
  client,
  resource,
  sessionId,
  projectId,
  only,
}: {
  client: VerityClient;
  resource: InquiryResource;
  sessionId?: string;
  projectId?: string | undefined;
  only?: (item: ProjectInquiry) => boolean;
}) {
  // During a server update the header's connection bar says so; this card only
  // reports failures that are its own, and asks again once the server is back.
  const hidesError = useHidesConnectionError(resource.error);
  useConnectionRecovered(() => {
    if (connectionFailureKind(resource.error) !== undefined) resource.reload();
  });
  const { busy, decide } = useInquiryDecisions(client, resource);
  const items = (resource.data ?? []).filter(
    (item) =>
      (projectId === undefined || item.targetProjectId === projectId) && (only?.(item) ?? true),
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
      {items.map((item) => (
        <ProjectInquiryCard
          key={item.id}
          item={item}
          sessionId={sessionId}
          busy={busy}
          onDecide={decide}
        />
      ))}
    </>
  );
}

function ProjectInquiryCard({
  item,
  sessionId,
  busy,
  onDecide,
}: {
  item: ProjectInquiry;
  sessionId: string | undefined;
  busy: string | undefined;
  onDecide: Decide;
}) {
  const [full, setFull] = useState(false);
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
  return (
    <Card stacked>
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
        <Text variant="bodySmall" numberOfLines={long && !full ? CLAMPED_LINES : undefined}>
          {item.body}
        </Text>
      </View>
      {item.answer ? (
        <Text numberOfLines={long && !full ? CLAMPED_LINES : undefined}>{item.answer}</Text>
      ) : null}
      {long ? (
        <Button
          label={full ? 'Show less' : 'Show full request'}
          variant="text"
          size="small"
          onPress={() => setFull(!full)}
        />
      ) : null}
      {pending ? (
        <View style={styles.actions}>
          <Button
            label="Allow once"
            size="small"
            loading={busy === item.id}
            disabled={busy !== undefined}
            onPress={() => onDecide(item.targetProjectId, item.id, 'approve')}
          />
          {question ? (
            <Button
              label="Always allow"
              size="small"
              variant="secondary"
              accessibilityLabel={`Always allow questions from ${source} to ${target}`}
              disabled={busy !== undefined}
              onPress={() => onDecide(item.targetProjectId, item.id, 'approve_always')}
            />
          ) : null}
          <Button
            label="Reject"
            size="small"
            variant="text"
            disabled={busy !== undefined}
            onPress={() => onDecide(item.targetProjectId, item.id, 'reject')}
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
}

const isWaiting = (item: ProjectInquiry) => item.status === 'pending';

/**
 * The one row above the composer while a request waits for a decision. A
 * settled request has no row: its answer is in the chat and the linked session
 * is under the header. The X hides waiting requests here without deciding them;
 * they then wait at the end of the chat ({@link DismissedInquiryCards}).
 */
export function SessionInquiryRow({
  client,
  resource,
  sessionId,
  dismissed,
  onDismiss,
}: {
  client: VerityClient;
  resource: InquiryResource;
  sessionId: string;
  dismissed?: ReadonlySet<string>;
  onDismiss?: (ids: readonly string[]) => void;
}) {
  const { theme } = useUnistyles();
  const hidesError = useHidesConnectionError(resource.error);
  useConnectionRecovered(() => {
    if (connectionFailureKind(resource.error) !== undefined) resource.reload();
  });
  const [openSession, setOpenSession] = useState<string>();
  const shown = (item: ProjectInquiry) => isWaiting(item) && !dismissed?.has(item.id);
  const waiting = (resource.data ?? []).filter(shown);
  const visible = openSession === sessionId;
  // Pending decisions sit behind this row, so a failed refresh must not hide them.
  const subtitle =
    waiting.length > 0
      ? `${waiting.length} awaiting approval`
      : hidesError
        ? 'Loads once the server is back'
        : 'Could not load project requests';
  if (waiting.length === 0 && !resource.error && !visible) return null;
  return (
    <>
      {waiting.length > 0 || resource.error ? (
        <SessionBar
          trailing={
            onDismiss && waiting.length > 0 ? (
              <IconButton
                icon="x"
                accessibilityLabel="Hide project requests. They stay open in the chat."
                onPress={() => onDismiss(waiting.map((item) => item.id))}
              />
            ) : undefined
          }
        >
          <SessionBarTarget
            accessibilityLabel="Project requests"
            accessibilityHint={subtitle}
            expanded={visible}
            onPress={() => setOpenSession(sessionId)}
          >
            <SessionBarContent
              color={
                waiting.length > 0 || (resource.error && !hidesError)
                  ? theme.colors.attention
                  : theme.colors.textMuted
              }
              title="Project requests"
              subtitle={subtitle}
            />
          </SessionBarTarget>
        </SessionBar>
      ) : null}
      {visible ? (
        <Sheet visible title="Project requests" onClose={() => setOpenSession(undefined)}>
          <InquiryCardList client={client} resource={resource} sessionId={sessionId} only={shown} />
        </Sheet>
      ) : null}
    </>
  );
}

/** Waiting requests hidden from above the composer, with the same decisions. */
export function DismissedInquiryCards({
  client,
  resource,
  sessionId,
  dismissed,
}: {
  client: VerityClient;
  resource: InquiryResource;
  sessionId: string;
  dismissed: ReadonlySet<string>;
}) {
  const { busy, decide } = useInquiryDecisions(client, resource);
  return (resource.data ?? [])
    .filter((item) => isWaiting(item) && dismissed.has(item.id))
    .map((item) => (
      <ProjectInquiryCard
        key={item.id}
        item={item}
        sessionId={sessionId}
        busy={busy}
        onDecide={decide}
      />
    ));
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
