import {
  permissionOverview,
  sessionHandoffSummary,
  type AssistantApproval,
  type AssistantConversationItem,
  type SessionHandoffSummary,
} from '@verity/mobile';
import { useRef, useState, type ReactNode } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { decideVerityApproval } from '../../lib/verityConversation';
import { Icon } from '../Icon';
import { Button, Card, CardHead, StatusDot, StatusTag, Text } from '../ui';
import { Disclosure } from '../ui/Disclosure';
import { tint } from '../ui/tint';
import { VerityMark } from '../VerityMark';

type Assignment = Extract<AssistantConversationItem, { kind: 'assignment' }>;

/**
 * A case Verity hands to another project, as one card from the request to the result
 * (docs/assistant.md). While it waits for the user it is the approval itself: where it
 * goes, the task, the briefing folded with its size, and the two answers. Decided, the
 * same card keeps its head, route and task and shows the session's progress below.
 */
export function HandoffCard({
  item,
  approval,
  onOpenSession,
  onReview,
}: {
  item: Assignment;
  /** The approval this handoff waits on, when the conversation names one. */
  approval: AssistantApproval | undefined;
  /** Opens the session the work went to. */
  onOpenSession: (sessionId: string) => void;
  /** Opens Verity's own session, where a request too large for this card is read. */
  onReview: (() => void) | null;
}) {
  if (approval !== undefined)
    return <WaitingHandoff item={item} approval={approval} onReview={onReview} />;
  const declined = item.state === 'failed' && item.declined === true;
  return (
    <View testID="handoff-card">
      <Card stacked muted={declined}>
        <KindLine label="Handoff to another project" trailing={<HandoffTag item={item} />} />
        <Route project={item.project} compact />
        <Task title={item.title} />
        <HandoffProgress item={item} onOpenSession={onOpenSession} />
      </Card>
    </View>
  );
}

function WaitingHandoff({
  item,
  approval,
  onReview,
}: {
  item: Assignment;
  approval: AssistantApproval;
  onReview: (() => void) | null;
}) {
  // The request as the tool received it; null when it was too large to carry or did not
  // parse, and then the session's own card is the place to read it.
  const summary = approval.input === undefined ? null : sessionHandoffSummary(approval.input);
  // Once the request parsed, only it names the destination: the card it was linked to by
  // title could belong to another handoff, and a bare session target has no project.
  const project = summary !== null ? summary.destination.project : item.project;
  return (
    <View testID="handoff-card">
      <Card stacked selected>
        <KindLine
          label="Handoff to another project"
          trailing={<StatusTag intent="action" label="Waiting for you" />}
        />
        <Route project={project} session={summary?.destination.session ?? null} />
        <Task title={summary?.title ?? item.title} />
        {summary !== null ? (
          <>
            <Briefing summary={summary} />
            <Text variant="footnote">{handOverSentence(summary)}</Text>
          </>
        ) : null}
        <Decision
          approval={approval}
          allowLabel={project === null ? 'Hand over' : `Hand over to ${shortProject(project)}`}
          denyLabel="Don't hand over"
          decidable={summary !== null}
          onReview={onReview}
        />
      </Card>
    </View>
  );
}

/**
 * Any other approval Verity waits for (a mail to send, an event to change), decided here
 * when its summary carries the whole request, as on Home; otherwise in the session.
 */
export function VerityApprovalCard({
  approval,
  onReview,
}: {
  approval: AssistantApproval;
  onReview: (() => void) | null;
}) {
  const overview =
    approval.input === undefined ? null : permissionOverview(approval.tool, approval.input);
  return (
    <View testID="verity-approval">
      <Card stacked selected>
        <CardHead
          title={overview?.title ?? 'Verity needs your approval'}
          wrapTitle
          trailing={<StatusTag intent="action" label="Waiting for you" />}
        />
        {overview?.decidable
          ? overview.lines?.map((line, index) => (
              <Text
                key={index}
                variant={line.kind === 'code' ? 'code' : 'bodySmall'}
                tone={line.kind === 'code' ? undefined : 'muted'}
                selectable
              >
                {line.text}
              </Text>
            ))
          : overview?.message !== undefined && (
              <Text variant="bodySmall" tone="muted" numberOfLines={3}>
                {overview.message}
              </Text>
            )}
        <Decision
          approval={approval}
          allowLabel="Allow"
          denyLabel="Deny"
          decidable={overview?.decidable === true}
          onReview={onReview}
        />
      </Card>
    </View>
  );
}

/** The two answers, or the way to the session when this card cannot show enough to decide. */
function Decision({
  approval,
  allowLabel,
  denyLabel,
  decidable,
  onReview,
}: {
  approval: AssistantApproval;
  allowLabel: string;
  denyLabel: string;
  decidable: boolean;
  onReview: (() => void) | null;
}) {
  const [deciding, setDeciding] = useState<'allow' | 'deny' | null>(null);
  // State re-renders too late to stop a fast double tap; a second decision would fail as
  // already decided and report an approval that went through as "Not decided".
  const running = useRef(false);
  const decide = (allow: boolean) => {
    if (running.current) return;
    running.current = true;
    setDeciding(allow ? 'allow' : 'deny');
    decideVerityApproval(approval, allow)
      .catch((error: unknown) => {
        Alert.alert('Not decided', error instanceof Error ? error.message : 'Try again');
      })
      .finally(() => {
        running.current = false;
        setDeciding(null);
      });
  };
  // Without Verity's session (onReview null) there is nothing to decide against either.
  if (onReview === null) return null;
  if (!decidable)
    return (
      <View style={styles.actions}>
        <Text variant="footnote" style={styles.flex}>
          Too much to show here; the full request is in Verity&apos;s session.
        </Text>
        <Button
          label="Review in session"
          size="compact"
          onPress={onReview}
          accessibilityHint="Opens Verity's session with this request"
        />
      </View>
    );
  return (
    <View style={styles.actions}>
      <Button
        label={denyLabel}
        variant="secondary"
        size="compact"
        loading={deciding === 'deny'}
        disabled={deciding !== null}
        onPress={() => decide(false)}
      />
      <Button
        label={allowLabel}
        size="compact"
        loading={deciding === 'allow'}
        disabled={deciding !== null}
        onPress={() => decide(true)}
      />
    </View>
  );
}

function KindLine({ label, trailing }: { label: string; trailing: ReactNode }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.kind}>
      <Icon name="arrow-up-right" size={14} color={theme.colors.actionLabel} />
      <Text variant="label" tone="action" style={styles.flex} numberOfLines={1}>
        {label}
      </Text>
      {trailing}
    </View>
  );
}

/** From Verity to the project: the part of a handoff that cannot be undone, drawn first. */
function Route({
  project,
  session = null,
  compact = false,
}: {
  project: string | null;
  session?: string | null;
  compact?: boolean;
}) {
  const { theme } = useUnistyles();
  const tile = compact ? 28 : 36;
  return (
    <View
      style={[styles.route, compact ? styles.routeCompact : null]}
      accessibilityLabel={`From Verity to ${project ?? session ?? 'a project'}${
        project !== null && session ? `, ${session}` : ''
      }`}
      testID="handoff-route"
    >
      <View style={styles.node}>
        <VerityMark size={tile} glow={false} />
        <View>
          <Text variant="label" tone="faint">
            From
          </Text>
          <Text variant="bodySmall" style={styles.nodeName}>
            Verity
          </Text>
        </View>
      </View>
      <View style={styles.arrow}>
        <View style={styles.arrowLine} />
        <Icon name="arrow-right" size={16} color={theme.colors.action} />
      </View>
      <View style={[styles.node, styles.shrink]}>
        <View style={[styles.target, { width: tile, height: tile }]}>
          <Text variant="row" tone="action">
            {(project === null ? 'S' : shortProject(project).slice(0, 1)).toUpperCase()}
          </Text>
        </View>
        <View style={styles.shrink}>
          <Text variant="label" tone="faint">
            To
          </Text>
          <Text variant="bodySmall" style={styles.nodeName} numberOfLines={1}>
            {project ?? session ?? 'Project'}
          </Text>
          {session !== null && project !== null && !compact ? (
            <Text variant="footnote" tone="muted" numberOfLines={1}>
              {session}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function Task({ title }: { title: string }) {
  return (
    <View>
      <Text variant="label" tone="faint">
        Task
      </Text>
      <Text variant="row">{title}</Text>
    </View>
  );
}

/** Folded with its size: approving without reading it is the user's call (docs/assistant.md). */
function Briefing({ summary }: { summary: SessionHandoffSummary }) {
  return (
    <View style={styles.briefing} testID="handoff-briefing">
      <Disclosure title="Briefing" subtitle={`${briefingSize(summary)} · written by Verity`}>
        <ScrollView style={styles.briefingScroll} nestedScrollEnabled>
          <Text variant="code" selectable testID="handoff-briefing-text">
            {summary.briefing}
          </Text>
        </ScrollView>
      </Disclosure>
    </View>
  );
}

function HandoffTag({ item }: { item: Assignment }) {
  if (item.result)
    return item.result.delivered ? (
      <StatusTag intent="ready" label="Done" />
    ) : (
      <StatusTag intent="action" label="Open" />
    );
  if (item.state === 'sent') return <StatusTag intent="ready" label="Handed over" />;
  if (item.state === 'failed')
    return item.declined ? (
      <StatusTag intent="optional" tag muted label="Not handed over" />
    ) : (
      <StatusTag intent="needsSetup" label="Failed" />
    );
  return <StatusDot intent="transient" label="Handing over" />;
}

function HandoffProgress({
  item,
  onOpenSession,
}: {
  item: Assignment;
  onOpenSession: (sessionId: string) => void;
}) {
  const target = item.sessionId;
  const open =
    target === undefined ? null : (
      <Button
        label="Open session"
        variant="text"
        size="compact"
        onPress={() => onOpenSession(target)}
      />
    );
  if (item.result)
    return (
      <>
        <Text variant="bodySmall" numberOfLines={2} testID="handoff-result">
          {item.result.summary}
        </Text>
        {item.result.blocker ? (
          <Text variant="subtitle" tone="attention" numberOfLines={2}>
            {`Blocker: ${item.result.blocker}`}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Text variant="footnote" tone="faint" style={styles.flex}>
            {`Result from the session · ${resultTime(item.result.at, item.at)}`}
          </Text>
          {open}
        </View>
      </>
    );
  if (item.state === 'sent')
    return (
      <View style={styles.actions}>
        <View style={styles.flex}>
          <StatusDot intent="transient" label="The session is working" />
        </View>
        {open}
      </View>
    );
  if (item.state === 'failed')
    return (
      <Text variant="footnote">
        {item.declined ? "You didn't hand it over · nothing was sent" : 'Could not hand it over'}
      </Text>
    );
  return null;
}

/** What "Hand over" does, in the words of the target the request names. */
export function handOverSentence(summary: SessionHandoffSummary): string {
  const where = summary.destination.project ?? 'that project';
  const action =
    summary.targetKind === 'new-session'
      ? `starts a new session in ${where} and gives it the briefing as its first message`
      : summary.targetKind === 'project'
        ? `gives the briefing to the one open session of ${where}; with none or several, nothing is sent`
        : `sends the briefing to ${summary.target} as its next message`;
  return `Hand over ${action}. Verity wrote it, and the session sees that.`;
}

/** "1,277 characters · 7 lines", measured on what the target session receives. */
export function briefingSize(summary: SessionHandoffSummary): string {
  const { characters, lines } = summary.briefingSize;
  const group = (value: number) => value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${group(characters)} character${characters === 1 ? '' : 's'} · ${group(lines)} line${
    lines === 1 ? '' : 's'
  }`;
}

/** The repository part of `owner/repo`, for a button that must stay short. */
function shortProject(project: string | null): string {
  if (project === null) return 'project';
  return project.split('/').pop() || project;
}

/** When a handoff's result arrived: the time, with the date once it is not the card's day,
 *  since the day heading above the card belongs to the handoff. */
function resultTime(at: number, handedOffAt: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return when.toDateString() === new Date(handedOffAt).toDateString()
    ? time
    : `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  kind: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  route: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  routeCompact: { gap: theme.spacing.sm, paddingVertical: theme.spacing.sm },
  node: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  nodeName: { fontFamily: theme.fonts.semibold },
  arrow: { flex: 1, minWidth: 28, flexDirection: 'row', alignItems: 'center' },
  arrowLine: { flex: 1, height: 2, backgroundColor: tint(theme.colors.action, 'border') },
  target: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.tile,
    borderWidth: 1,
    borderColor: tint(theme.colors.action, 'border'),
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  briefing: {
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    overflow: 'hidden',
  },
  briefingScroll: { maxHeight: 260 },
}));
