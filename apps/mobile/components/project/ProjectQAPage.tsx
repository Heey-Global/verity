import {
  qaIssueLabel,
  qaStopReason,
  type ProjectQAState,
  type QAIssue,
  type QAIssueDecision,
} from '@verity/mobile';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  Button,
  Card,
  CardHead,
  FilterChips,
  Group,
  Row,
  SectionHeader,
  StatusDot,
  StatusTag,
  Text,
} from '../ui';

const MODE: Record<string, string> = {
  automatic: 'Repairs within mandate',
  monitor: 'Observes and proposes',
  paused: 'Paused',
  off: 'Switched off',
};

function clock(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The head of the QA page: what QA reads, whether it could, and when. */
export function QAStatusCard({ state, name }: { state: ProjectQAState; name: string }) {
  const needs = state.issues.filter((issue) => issue.state === 'needs_you').length;
  const source = (readable: boolean, failing: number, ok: string) =>
    !readable ? (
      <StatusDot intent="unknown" label="Unreadable" />
    ) : failing > 0 ? (
      <StatusDot intent="needsSetup" label={`${String(failing)} failing`} />
    ) : (
      <StatusDot intent="ready" label={ok} />
    );
  return (
    <Card stacked divided>
      <CardHead
        title={`Watching ${name}`}
        subtitle={`${MODE[state.mode ?? 'off'] ?? 'QA'} · checked ${clock(state.checkedAt)}`}
        leading={{ icon: 'shield' }}
        trailing={
          state.brakeAt ? (
            <StatusTag intent="needsSetup" label="Brake" />
          ) : needs > 0 ? (
            <StatusTag intent="needsSetup" label="Needs you" />
          ) : undefined
        }
      />
      <View style={styles.columns}>
        <View style={styles.column}>
          <Text variant="label">Pull requests</Text>
          {source(
            state.sources.pullRequests.readable,
            state.sources.pullRequests.failing,
            'Passing',
          )}
        </View>
        <View style={styles.column}>
          <Text variant="label">CI on main</Text>
          {source(state.sources.ci.readable, state.sources.ci.failing, 'Passing')}
        </View>
      </View>
      {state.brakeAt ? (
        <Text variant="bodySmall" tone="muted">
          Repairs started unusually fast, so QA stopped starting new ones. An administrator releases
          the brake in Settings › QA.
        </Text>
      ) : null}
    </Card>
  );
}

export function QATabs({
  value,
  count,
  onChange,
}: {
  value: 'issues' | 'chat';
  count: number;
  onChange: (value: 'issues' | 'chat') => void;
}) {
  return (
    <FilterChips
      accessibilityLabel="QA sections"
      options={[
        { value: 'issues', label: count ? `Issues · ${String(count)}` : 'Issues' },
        { value: 'chat', label: 'Chat' },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

function issueLine(issue: QAIssue): {
  subtitle: string;
  tag?: { label: string; intent: 'needsSetup' | 'transient' | 'optional' | 'ready' | 'unknown' };
} {
  const failing = issue.failing ?? 'Failing';
  if (issue.state === 'needs_you')
    return {
      subtitle: qaStopReason(issue.reason),
      tag: { label: 'Needs you', intent: 'needsSetup' },
    };
  if (issue.state === 'resolved') return { subtitle: `Resolved · ${failing}` };
  if (issue.state === 'deferred')
    return {
      subtitle: 'Deferred until a new revision',
      tag: { label: 'Deferred', intent: 'unknown' },
    };
  if (issue.state === 'taken_over')
    return { subtitle: 'Taken over by you', tag: { label: 'Yours', intent: 'unknown' } };
  if (issue.repairing)
    return {
      subtitle: `${issue.sessionName ? `“${issue.sessionName}” · ` : ''}round ${String(issue.roundsUsed)} of ${String(issue.roundsAllowed)}`,
      tag: { label: 'Repairing', intent: 'transient' },
    };
  if (issue.originSessionId)
    return {
      subtitle: `${failing} · with its session`,
      tag: { label: 'Session', intent: 'optional' },
    };
  return { subtitle: failing, tag: { label: 'Open', intent: 'optional' } };
}

/** The issues QA tracks, by what they need: you, work, or nothing any more. */
export function QAIssueList({
  issues,
  onOpen,
}: {
  issues: readonly QAIssue[];
  onOpen: (issue: QAIssue) => void;
}) {
  const groups: [string, QAIssue[]][] = [
    ['Needs you', issues.filter((i) => i.state === 'needs_you')],
    ['In progress', issues.filter((i) => i.state === 'open')],
    ['Set aside', issues.filter((i) => i.state === 'deferred' || i.state === 'taken_over')],
    ['Resolved this week', issues.filter((i) => i.state === 'resolved')],
  ];
  if (!issues.length)
    return (
      <Text variant="bodySmall" tone="muted" style={styles.empty}>
        Nothing open. QA reports here when a pull request or CI run fails.
      </Text>
    );
  return (
    <>
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <View key={title}>
            <SectionHeader title={`${title} · ${String(list.length)}`} variant="eyebrow" />
            <Group>
              {list.map((issue) => {
                const line = issueLine(issue);
                return (
                  <Row
                    key={issue.id}
                    title={`${qaIssueLabel(issue.key)}${issue.incidents > 1 ? ` · ${String(issue.incidents)} failures` : ''}`}
                    subtitle={line.subtitle}
                    leading={
                      issue.state === 'resolved'
                        ? { icon: 'check-circle', intent: 'ready' }
                        : {
                            icon: issue.key.startsWith('pr:') ? 'git-pull-request' : 'activity',
                            ...(issue.state === 'needs_you'
                              ? { intent: 'needsSetup' as const }
                              : { quiet: true }),
                          }
                    }
                    tag={
                      line.tag ? (
                        <StatusTag intent={line.tag.intent} label={line.tag.label} />
                      ) : undefined
                    }
                    navigates
                    onPress={() => onOpen(issue)}
                  />
                );
              })}
            </Group>
          </View>
        ))}
    </>
  );
}

/** One issue: why QA stopped and the answers, its timeline, and the evidence QA checked. */
export function QAIssueDetail({
  issue,
  projectName,
  canDecide,
  onDecide,
  onOpenSession,
}: {
  issue: QAIssue;
  projectName: string;
  canDecide: boolean;
  onDecide: (decision: QAIssueDecision) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}) {
  const [pending, setPending] = useState<QAIssueDecision>();
  const decide = (decision: QAIssueDecision) => {
    setPending(decision);
    void onDecide(decision)
      .catch((caught: unknown) =>
        Alert.alert('Not sent', caught instanceof Error ? caught.message : 'Please try again.'),
      )
      .finally(() => setPending(undefined));
  };
  const stopped = issue.state === 'needs_you';
  const steps: {
    title: string;
    subtitle: string;
    intent: 'ready' | 'needsSetup' | 'unknown' | 'transient';
  }[] = [
    {
      title: 'Detected',
      subtitle: `${clock(issue.detectedAt)} · ${issue.failing ?? 'failure'}`,
      intent: 'ready',
    },
    {
      title: 'Assigned',
      subtitle: issue.originSessionId
        ? 'To the session that opened the pull request'
        : issue.sessionId
          ? 'New session, no origin session'
          : 'Not yet',
      intent: issue.sessionId || issue.originSessionId ? 'ready' : 'unknown',
    },
    {
      title: 'Repair',
      subtitle: `${String(issue.roundsUsed)} of ${String(issue.roundsAllowed)} rounds`,
      intent: issue.repairing ? 'transient' : issue.roundsUsed > 0 ? 'ready' : 'unknown',
    },
    {
      title: 'Review',
      subtitle: stopped
        ? 'Still failing'
        : issue.state === 'resolved'
          ? 'Checks pass on the current revision'
          : 'Waiting for the next check',
      intent: stopped ? 'needsSetup' : issue.state === 'resolved' ? 'ready' : 'unknown',
    },
    {
      title: 'Done',
      subtitle: stopped
        ? 'Waiting for your decision'
        : issue.state === 'resolved'
          ? 'Resolved'
          : '—',
      intent: issue.state === 'resolved' ? 'ready' : 'unknown',
    },
  ];
  return (
    <>
      <Card stacked divided attention={stopped}>
        <CardHead
          title={`${qaIssueLabel(issue.key)} failed`}
          subtitle={`${projectName} · ${issue.failing ?? 'CI'}`}
          leading={{
            icon: 'git-pull-request',
            ...(stopped ? { intent: 'needsSetup' as const } : {}),
          }}
          trailing={stopped ? <StatusTag intent="needsSetup" label="Needs you" /> : undefined}
        />
        {stopped ? (
          <View style={styles.stack}>
            <Text variant="row">{qaStopReason(issue.reason)}</Text>
            {issue.detail ? (
              <Text variant="bodySmall" tone="muted">
                {issue.detail}
              </Text>
            ) : null}
            {canDecide ? (
              <View style={styles.actions}>
                <Button
                  label="Another round"
                  size="small"
                  loading={pending === 'another_round'}
                  disabled={pending !== undefined}
                  onPress={() => decide('another_round')}
                />
                <Button
                  label="Take over"
                  size="small"
                  variant="secondary"
                  loading={pending === 'take_over'}
                  disabled={pending !== undefined}
                  onPress={() => decide('take_over')}
                />
                <Button
                  label="Defer"
                  size="small"
                  variant="secondary"
                  loading={pending === 'defer'}
                  disabled={pending !== undefined}
                  onPress={() => decide('defer')}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </Card>
      <SectionHeader title="Timeline" />
      <Group>
        {steps.map((step) => (
          <Row
            key={step.title}
            title={step.title}
            subtitle={step.subtitle}
            leading={{ dot: step.intent }}
          />
        ))}
      </Group>
      <SectionHeader title="Evidence" />
      <Group>
        <Row
          title="Failing"
          trailing={<Text variant="bodySmall">{issue.failing ?? 'Unknown'}</Text>}
        />
        <Row
          title="Revision"
          trailing={<Text variant="bodySmall">{issue.revision?.slice(0, 7) ?? 'Unknown'}</Text>}
        />
        {issue.sessionId ? (
          <Row
            title="Session"
            subtitle={issue.sessionName ?? 'Repair session'}
            leading={{ icon: 'message-square' }}
            navigates
            onPress={() => onOpenSession(issue.sessionId!)}
          />
        ) : null}
        <Row
          title="Rounds"
          trailing={
            <Text variant="bodySmall">{`${String(issue.roundsUsed)} of ${String(issue.roundsAllowed)} used`}</Text>
          }
        />
      </Group>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  columns: { flexDirection: 'row', gap: theme.spacing.lg },
  column: { flex: 1, gap: theme.spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  stack: { gap: theme.spacing.sm },
  empty: { marginTop: theme.spacing.md },
}));
