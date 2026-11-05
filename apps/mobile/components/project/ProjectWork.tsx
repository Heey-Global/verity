import {
  VerityApiError,
  isUnread,
  sessionBadge,
  sessionLabel,
  type BadgeTone,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, FilterChips, Group, Row, StatusDot, Text, useTextPrompt } from '../ui';
import type { StatusIntent } from '../ui/Status';

export type WorkFilter = 'all' | 'running' | 'done' | 'favorites';

const FILTERS: readonly { value: WorkFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'favorites', label: 'Favorites' },
];

const EMPTY: Record<WorkFilter, string> = {
  all: 'No sessions in this project yet.',
  running: 'Nothing is running.',
  done: 'Nothing is done yet.',
  favorites: 'No favorites. Long press a session to add one.',
};

const INTENT: Record<BadgeTone, StatusIntent> = {
  idle: 'optional',
  active: 'transient',
  attention: 'needsSetup',
  danger: 'needsSetup',
  done: 'ready',
};

/** Which sessions a Work filter keeps. */
export function workFilter(session: SessionSummary, filter: WorkFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'running':
      return (
        session.status === 'running' ||
        session.status === 'awaiting_input' ||
        session.status === 'awaiting_dependency' ||
        session.backgroundWorking === true
      );
    case 'done':
      return session.status === 'completed' || session.pullRequest?.phase === 'merged';
    case 'favorites':
      return session.favorite === true;
  }
}

/** The line under a session's name: what is new, and its pull request. */
function workSubtitle(session: SessionSummary): string | undefined {
  const parts: string[] = [];
  // No local overrides here: the page reloads after opening a session, and the
  // server's per-person mark is what every device agrees on.
  if (isUnread(session, new Map())) parts.push('New activity');
  const pr = session.pullRequest;
  if (pr) {
    parts.push(`PR #${String(pr.number)}`);
    if (pr.phase === 'merged') parts.push('merged');
    else if (pr.phase === 'closed') parts.push('closed');
    else if (pr.pipeline === 'failure') parts.push('checks failing');
    else if (pr.pipeline === 'success') parts.push('checks passed');
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * A project's sessions as one list, filtered by what they are doing. A row
 * opens its session; a long press offers rename, favorite and delete. Unlike the
 * project list this view does not reorder: it shows the order the list keeps.
 */
export function ProjectWork({
  client,
  projectId,
  sessions,
  onOpenSession,
  onChanged,
}: {
  client: VerityClient;
  projectId: string;
  sessions: readonly SessionSummary[];
  onOpenSession: (sessionId: string) => void;
  /** After a rename, favorite or delete of `sessionId`, so the page and its
   *  host (the wide layout's list and session pane) catch up. */
  onChanged: (sessionId: string, deleted: boolean) => void;
}) {
  const [filter, setFilter] = useState<WorkFilter>('all');
  const textPrompt = useTextPrompt();
  const shown = useMemo(
    () => sessions.filter((session) => workFilter(session, filter)),
    [sessions, filter],
  );

  const failed = (title: string) => (caught: unknown) =>
    Alert.alert(title, caught instanceof Error ? caught.message : 'Please try again.');
  const rename = (session: SessionSummary) =>
    textPrompt.prompt(
      'Rename session',
      'An empty name shows the session by its first prompt again.',
      (name) => {
        void client
          .renameSession(session.sessionId, name.trim() || null)
          .then(() => onChanged(session.sessionId, false), failed('Could not rename session'));
      },
      'plain-text',
      session.name ?? '',
    );
  const toggleFavorite = (session: SessionSummary) =>
    void client
      .setSessionFavorite(session.sessionId, session.favorite !== true)
      .then(() => onChanged(session.sessionId, false), failed('Could not update favorite'));
  const remove = (session: SessionSummary, force = false) =>
    void client.deleteSession(session.sessionId, force ? { force } : {}).then(
      () => onChanged(session.sessionId, true),
      (caught) => {
        if (caught instanceof VerityApiError && caught.status === 409 && !force) {
          Alert.alert(
            'Session is still running',
            `Verity could not stop "${sessionLabel(session)}" automatically. Delete it anyway? This permanently removes its history and worktree.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete anyway', style: 'destructive', onPress: () => remove(session, true) },
            ],
          );
          return;
        }
        failed('Could not delete session')(caught);
      },
    );
  const confirmRemove = (session: SessionSummary) =>
    Alert.alert(
      'Delete session?',
      `This permanently removes "${sessionLabel(session)}" — its history${session.automation ? ', its automation,' : ''} and worktree. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => remove(session) },
      ],
    );
  const actions = (session: SessionSummary) =>
    Alert.alert(sessionLabel(session), undefined, [
      { text: 'Rename', onPress: () => rename(session) },
      {
        text: session.favorite === true ? 'Remove from favorites' : 'Add to favorites',
        onPress: () => toggleFavorite(session),
      },
      { text: 'Delete', style: 'destructive', onPress: () => confirmRemove(session) },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <View style={styles.root} testID="project-work">
      <View style={styles.toolbar}>
        <View style={styles.flex}>
          <FilterChips
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            accessibilityLabel="Filter sessions"
            compact
          />
        </View>
        <Button
          label="New session"
          icon="plus"
          size="compact"
          variant="secondary"
          onPress={() => router.push({ pathname: '/new', params: { projectId } })}
        />
      </View>
      {shown.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {EMPTY[filter]}
        </Text>
      ) : (
        <Group>
          {shown.map((session) => {
            const badge = sessionBadge(session.status);
            return (
              <Row
                key={session.sessionId}
                title={`${session.favorite === true ? '★ ' : ''}${sessionLabel(session)}`}
                subtitle={workSubtitle(session)}
                trailing={<StatusDot intent={INTENT[badge.tone]} label={badge.label} />}
                onPress={() => onOpenSession(session.sessionId)}
                onLongPress={() => actions(session)}
                accessibilityHint="Opens the session. Long press to rename, favorite or delete it."
              />
            );
          })}
        </Group>
      )}
      {textPrompt.dialog}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.md },
  flex: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  empty: { paddingVertical: theme.spacing.md },
}));
