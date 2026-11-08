import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import type { RepositoryIssues, SessionSummary } from '@verity/mobile';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from './CodeHostIcon';
import { HandOffRow, handOffSession } from './HandOffRow';
import { Icon } from './Icon';
import { Button, FilterChips, Group, StatusTag, Text } from './ui';
import { createVerityClient } from '../lib/client';
import {
  dispatchTaskIssue,
  taskIssueRetry,
  taskIssueSessions,
  type IssueRepository,
} from '../lib/taskIssueDispatch';

type Issue = Extract<RepositoryIssues, { status: 'ok' }>['issues'][number];
type Retry = { targetSessionId?: string };

/** Issues a repository shows before "Show all". */
export const FIRST_ISSUES = 10;

const HOST = { github: 'GitHub', forgejo: 'Forgejo' } as const;
const isBug = (label: string) => /^bugs?$/i.test(label);
const retryKey = (repository: IssueRepository, number: number) =>
  `${repository.id}#${String(number)}`;

/**
 * The open issues of a project's repositories as things Verity can take on,
 * one section per repository with its code host. The default repository leads
 * and is open; with several, every section folds. A repository whose host did
 * not answer says so in its own section, and the others stay usable.
 */
export function TaskIssuesList({
  projectId,
  currentSessionId,
  repositories,
  onRetry,
  onOpenSession,
}: {
  projectId: string;
  currentSessionId?: string;
  repositories: RepositoryIssues[];
  onRetry(): void;
  onOpenSession(id: string): void;
}) {
  const [filter, setFilter] = useState<'all' | 'mine' | 'bugs'>('all');
  const [folded, setFolded] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [retries, setRetries] = useState<Record<string, Retry>>({});
  // Sessions started from here for other repositories' issues, which their
  // branch cannot name.
  const [started, setStarted] = useState<Record<string, string[]>>({});
  const available = repositories.filter(
    (repository): repository is Extract<RepositoryIssues, { status: 'ok' }> =>
      repository.status === 'ok',
  );
  useEffect(() => {
    let active = true;
    setRetries({});
    void Promise.all(
      available.flatMap((repository) =>
        repository.issues.map(
          async (issue) =>
            [
              retryKey(repository, issue.number),
              await taskIssueRetry(projectId, issue.number, repository),
            ] as const,
        ),
      ),
    )
      .then((entries) => {
        if (active)
          setRetries(
            Object.fromEntries(entries.filter((entry) => entry[1] !== null)) as Record<
              string,
              Retry
            >,
          );
      })
      .catch(() => undefined);
    void Promise.all(
      available
        .filter((repository) => !repository.isDefault)
        .flatMap((repository) =>
          repository.issues.map(
            async (issue) =>
              [
                retryKey(repository, issue.number),
                await taskIssueSessions(projectId, issue.number, repository),
              ] as const,
          ),
        ),
    )
      .then((entries) => {
        // Merged: a hand-over that finished while these were read is newer.
        if (active)
          setStarted((value) => ({
            ...Object.fromEntries(entries.filter((entry) => entry[1].length > 0)),
            ...value,
          }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // `available` is derived from `repositories` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, repositories]);
  useEffect(() => {
    let active = true;
    setSessions([]);
    setStarted({});
    setFilter('all');
    setExpanded([]);
    setFolded([]);
    void createVerityClient()
      ?.listSessions()
      .then((value) => {
        if (active) setSessions(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId]);
  const viewers = available.filter((repository) => repository.viewerLogin !== null);
  const dispatch = (repository: IssueRepository, issue: Issue, target?: string) => {
    if (busy) return;
    setBusy(true);
    void dispatchTaskIssue(projectId, issue, target, repository)
      .then((id) => {
        // Also for "This session" and a targeted retry: either way this session
        // now works on the issue.
        const key = retryKey(repository, issue.number);
        setStarted((value) => ({ ...value, [key]: [...(value[key] ?? []), id] }));
        onOpenSession(id);
      })
      .catch((error: unknown) => {
        void taskIssueRetry(projectId, issue.number, repository)
          .then((retry) => {
            setRetries((value) => {
              const next = { ...value };
              const key = retryKey(repository, issue.number);
              if (retry) next[key] = retry;
              else delete next[key];
              return next;
            });
          })
          .catch(() => undefined);
        Alert.alert('Issue action failed', error instanceof Error ? error.message : 'Try again');
      })
      .finally(() => setBusy(false));
  };
  // Sessions name their branch after the issue they were started for; branches
  // come from the default repository, so another repository's issue finds its
  // session through the record of the hand-over instead.
  const sessionFor = (repository: IssueRepository, issue: Issue) =>
    sessions.find(
      (item) =>
        item.projectId === projectId &&
        item.resumable !== false &&
        (repository.isDefault
          ? item.branch?.match(/^[^/]+\/(\d+)(?:-|$)/)?.[1] === String(issue.number)
          : (started[retryKey(repository, issue.number)] ?? []).includes(item.sessionId)),
    );
  // "Assigned to me" goes when no host names the viewer any more (after a
  // retry); a filter left on it would empty every section with no chip selected.
  const shown = filter === 'mine' && viewers.length === 0 ? 'all' : filter;
  const several = repositories.length > 1;
  return (
    <View style={styles.list}>
      <FilterChips
        accessibilityLabel="Filter issues"
        compact
        wrap
        value={shown}
        onChange={(value) => {
          setFilter(value);
          setExpanded([]);
        }}
        options={[
          { value: 'all', label: 'All' },
          ...(viewers.length > 0 ? [{ value: 'mine' as const, label: 'Assigned to me' }] : []),
          { value: 'bugs', label: 'Bugs' },
        ]}
      />
      {repositories.map((repository) => {
        const open = !several || !folded.includes(repository.id);
        if (repository.status !== 'ok')
          return (
            <View key={repository.id}>
              <RepositoryHeader repository={repository} count={null} />
              <View style={styles.unavailable} accessibilityRole="alert">
                <Text variant="bodySmall" tone="muted" style={styles.flex}>
                  Could not load issues
                </Text>
                <Button label="Retry" size="small" variant="secondary" onPress={onRetry} />
              </View>
            </View>
          );
        const filtered = repository.issues.filter(
          (issue) =>
            shown === 'all' ||
            (shown === 'mine'
              ? issue.assignees.some(
                  (login) => login.toLowerCase() === repository.viewerLogin?.toLowerCase(),
                )
              : issue.labels.some(isBug)),
        );
        const all = expanded.includes(repository.id);
        return (
          <View key={repository.id}>
            <RepositoryHeader
              repository={repository}
              count={filtered.length}
              {...(several
                ? {
                    expanded: open,
                    onToggle: () =>
                      setFolded((ids) =>
                        ids.includes(repository.id)
                          ? ids.filter((id) => id !== repository.id)
                          : [...ids, repository.id],
                      ),
                  }
                : {})}
            />
            {open && filtered.length > 0 ? (
              <Group>
                {(all ? filtered : filtered.slice(0, FIRST_ISSUES)).map((issue) => {
                  const session = sessionFor(repository, issue);
                  const state = session === undefined ? undefined : handOffSession(session);
                  const retry = retries[retryKey(repository, issue.number)];
                  const others = issue.labels.filter((label) => !isBug(label));
                  return (
                    <HandOffRow
                      key={issue.number}
                      title={issue.title}
                      subtitle={[`#${String(issue.number)}`, ...others].join(' · ')}
                      icon="disc"
                      tag={
                        issue.labels.some(isBug) ? (
                          <StatusTag intent="needsSetup" label="Bug" />
                        ) : undefined
                      }
                      session={state}
                      onOpenSession={() => {
                        if (session) onOpenSession(session.sessionId);
                      }}
                      onPress={() => {
                        void Linking.openURL(issue.url).catch(() =>
                          Alert.alert('Could not open issue', 'Try again'),
                        );
                      }}
                      accessibilityHint={`Opens the issue on ${HOST[repository.kind]}`}
                      onHandOff={() => dispatch(repository, issue)}
                      handOffLabel={`Let Verity fix: ${issue.title}`}
                      busy={busy}
                      answers={
                        retry || (currentSessionId && !session) ? (
                          <>
                            {retry ? (
                              <Button
                                label="Retry"
                                size="small"
                                variant="secondary"
                                disabled={busy}
                                onPress={() => dispatch(repository, issue, retry.targetSessionId)}
                              />
                            ) : null}
                            {currentSessionId && !session ? (
                              <Button
                                label="This session"
                                size="small"
                                variant="secondary"
                                disabled={busy}
                                onPress={() => dispatch(repository, issue, currentSessionId)}
                              />
                            ) : null}
                          </>
                        ) : undefined
                      }
                    />
                  );
                })}
              </Group>
            ) : null}
            {open && !all && filtered.length > FIRST_ISSUES ? (
              <View style={styles.more}>
                <Button
                  label={`Show all ${String(filtered.length)} issues`}
                  variant="text"
                  size="compact"
                  onPress={() => setExpanded((ids) => [...ids, repository.id])}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** A repository's section: code host mark, name and open count; folds with several. */
function RepositoryHeader({
  repository,
  count,
  expanded,
  onToggle,
}: {
  repository: RepositoryIssues;
  count: number | null;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const { theme } = useUnistyles();
  const label = `${repository.name}${count === null ? '' : ` · ${String(count)} open`}`;
  const content = (
    <>
      <CodeHostIcon provider={repository.kind} size={14} color={theme.colors.textMuted} />
      <Text variant="label" tone="muted" style={styles.flex} numberOfLines={1}>
        {repository.name}
      </Text>
      {count !== null ? (
        <Text variant="caption" tone="muted">{`${String(count)} open`}</Text>
      ) : null}
      {onToggle !== undefined ? (
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={16}
          color={theme.colors.textFaint}
        />
      ) : null}
    </>
  );
  return onToggle !== undefined ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${HOST[repository.kind]} ${label}`}
      accessibilityState={{ expanded: expanded === true }}
      onPress={onToggle}
      style={styles.section}
    >
      {content}
    </Pressable>
  ) : (
    <View
      style={styles.section}
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${HOST[repository.kind]} ${label}`}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing.xs, paddingTop: theme.spacing.sm },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.xs,
  },
  flex: { flex: 1 },
  unavailable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  more: { flexDirection: 'row' },
}));
