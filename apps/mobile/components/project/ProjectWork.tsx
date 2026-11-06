import {
  VerityApiError,
  markerAttention,
  modelDisplayName,
  sessionAgentMark,
  sessionBadge,
  sessionLabel,
  sessionTile,
  showsSessionLabel,
  workOrder,
  type ProjectRecord,
  type SessionAgentMark,
  type SessionStatus,
  type SessionSummary,
  type SessionTile,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionMarkerColumn, sessionMarkers, sessionMarkersLabel } from '../SessionMarkerColumn';
import { SessionSettingsDialog } from '../SessionSettingsDialog';
import type { IconName } from '../Icon';
import { FilterChips, Group, IconButton, Row, StatusTag, Text, TileMark } from '../ui';
import type { TileMarkGlyph, TileMarkTone } from '../ui';
import type { StatusIntent } from '../ui/Status';
import { isLinkableSession } from '../../lib/sessionLinks';
import { useSessionPreviews } from '../../lib/sessionPreviews';
import { useUnread } from '../../hooks/useUnread';

export type WorkFilter = 'all' | 'running' | 'done' | 'favorites';

const FILTERS: readonly { value: WorkFilter; label: string; icon?: 'star' }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'favorites', label: 'Favorites', icon: 'star' },
];

const EMPTY: Record<WorkFilter, string> = {
  all: 'No sessions in this project yet.',
  running: 'Nothing is running.',
  done: 'Nothing is done yet.',
  favorites: 'No favorites. Long press a session to add one.',
};

// Only the states a bare row cannot show carry a tag (showsSessionLabel): running
// has the working dot, done and idle are the absence of one. Done is not green
// here, as it never was in the session list.
const TAG_INTENT: Partial<Record<SessionStatus, StatusIntent>> = {
  awaiting_input: 'needsSetup',
  crashed: 'needsSetup',
  awaiting_dependency: 'optional',
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

// The tile's phase glyph: git symbols for code, so a pull request's verdict is
// always a mark on a PR glyph and never a bare check or cross.
const TILE_ICON: Record<SessionTile['glyph'], IconName> = {
  pull_request: 'git-pull-request',
  merged: 'git-merge',
  automation: 'repeat',
  session: 'message-square',
};

const TILE_INTENT: Record<SessionTile['tone'], StatusIntent | undefined> = {
  progress: 'transient',
  ready: 'ready',
  problem: 'needsSetup',
  quiet: undefined,
};

const RESULT_MARK: Record<
  NonNullable<SessionTile['result']>,
  { tone: TileMarkTone; glyph: TileMarkGlyph }
> = {
  running: { tone: 'action', glyph: 'loader' },
  passed: { tone: 'success', glyph: 'check' },
  failed: { tone: 'attention', glyph: 'x' },
  conflict: { tone: 'attention', glyph: '!' },
  checking: { tone: 'muted', glyph: 'more-horizontal' },
};

// The labels the row's old leading dots carried, kept so VoiceOver says the same.
const AGENT_MARK: Record<
  SessionAgentMark,
  { tone: TileMarkTone; glyph?: TileMarkGlyph; pulsing?: boolean; label: string }
> = {
  question: { tone: 'attention', glyph: '?', label: 'Waiting for you' },
  working: { tone: 'signature', pulsing: true, label: 'Agent is working' },
  unread: { tone: 'action', label: 'Unread messages' },
};

/** The line under a session's name: its pull request and what it wants, else its model. */
function workSubtitle(session: SessionSummary): string | undefined {
  const parts: string[] = [];
  const pr = session.pullRequest;
  if (pr) {
    parts.push(`PR #${String(pr.number)}`);
    if (pr.phase === 'merged') parts.push('merged');
    else if (pr.phase === 'closed') parts.push('closed');
  }
  // The same PR signals the session list marks (CI failed, ready to merge, …).
  for (const flag of markerAttention({
    status: session.status,
    pr: session.pr,
    attention: session.attention,
  }))
    if (flag.kind !== 'unread') parts.push(flag.label);
  if (parts.length > 0) return parts.join(' · ');
  return session.model ? modelDisplayName(session.model) : undefined;
}

/**
 * A project's sessions as one list, filtered by what they are doing and ordered
 * by {@link workOrder}: what needs the operator or is moving first, then
 * favorites. Each row leads with its {@link sessionTile}: the pull request's
 * phase and verdict, else automation, else a neutral tile, with the agent's
 * state (working, new answer, waiting) as the tile's top mark. The trailing
 * column keeps the session list's star, automation and link markers. A row opens its
 * session; a long press offers favorite, the session settings (rename, move,
 * linked sessions) and delete.
 */
export function ProjectWork({
  client,
  projectId,
  sessions,
  onOpenSession,
  onChanged,
}: {
  client: VerityClient;
  /** The project a new session starts in; none for sessions outside a project. */
  projectId?: string | undefined;
  sessions: readonly SessionSummary[];
  onOpenSession: (sessionId: string) => void;
  /** After a rename, favorite, move, link or delete of `sessionId`, so the page
   *  and its host (the wide layout's list and session pane) catch up. */
  onChanged: (sessionId: string, deleted: boolean) => void;
}) {
  const [filter, setFilter] = useState<WorkFilter>('all');
  const { unread: unreadIds, markSeen } = useUnread(client, sessions);
  const previews = useSessionPreviews();
  const shown = useMemo(
    () => workOrder(sessions.filter((session) => workFilter(session, filter))),
    [sessions, filter],
  );
  const [settings, setSettings] = useState<{
    session: SessionSummary;
    links: boolean;
    // Linking reaches sessions in other projects, which this page does not hold.
    projects: ProjectRecord[];
    everySession: SessionSummary[];
  }>();

  const failed = (title: string) => (caught: unknown) =>
    Alert.alert(title, caught instanceof Error ? caught.message : 'Please try again.');
  const openSettings = (session: SessionSummary, links = false) => {
    void Promise.all([
      client.listProjects().catch(() => [] as ProjectRecord[]),
      client.listSessions().catch(() => [...sessions]),
    ]).then(([projects, everySession]) => setSettings({ session, links, projects, everySession }));
  };
  const toggleFavorite = (session: SessionSummary) =>
    void client
      .setSessionFavorite(session.sessionId, session.favorite !== true)
      .then(() => onChanged(session.sessionId, false), failed('Could not update favorite'));
  const remove = (session: SessionSummary, force = false) =>
    void client.deleteSession(session.sessionId, force ? { force } : {}).then(
      () => {
        setSettings(undefined);
        onChanged(session.sessionId, true);
      },
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
      {
        text: session.favorite === true ? 'Remove from favorites' : 'Add to favorites',
        onPress: () => toggleFavorite(session),
      },
      { text: 'Session settings', onPress: () => openSettings(session) },
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
        <IconButton
          icon="plus"
          accessibilityLabel="New session"
          onPress={() =>
            router.push(projectId ? { pathname: '/new', params: { projectId } } : '/new')
          }
        />
      </View>
      {shown.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {EMPTY[filter]}
        </Text>
      ) : (
        <Group>
          {shown.map((session) => {
            const label = sessionLabel(session);
            const working = session.status === 'running' || session.backgroundWorking === true;
            const unread = !working && unreadIds.has(session.sessionId);
            const tile = sessionTile(session);
            const agent = sessionAgentMark({ status: session.status, working, unread });
            const result = tile.result !== undefined ? RESULT_MARK[tile.result] : undefined;
            const intent = TILE_INTENT[tile.tone];
            const tag = showsSessionLabel(session.status) ? TAG_INTENT[session.status] : undefined;
            const markers = sessionMarkers({
              favorite: session.favorite === true,
              linked: session.linked,
              automation: session.automation?.status,
              shared: previews.urls.has(session.sessionId)
                ? previews.online.has(session.sessionId)
                  ? 'online'
                  : 'local'
                : undefined,
            });
            const spoken = [
              label,
              working ? 'working' : unread ? 'new answer' : null,
              tag !== undefined ? sessionBadge(session.status).label : null,
              markers.length > 0 ? sessionMarkersLabel(markers) : null,
            ]
              .filter((part): part is string => part !== null)
              .join(', ');
            return (
              <Row
                key={session.sessionId}
                title={label}
                subtitle={workSubtitle(session)}
                leading={{
                  icon: TILE_ICON[tile.glyph],
                  ...(intent !== undefined ? { intent } : { quiet: true }),
                  marks: {
                    top:
                      agent !== undefined ? (
                        <View
                          testID={`work-agent-${session.sessionId}`}
                          accessibilityRole="image"
                          accessibilityLabel={AGENT_MARK[agent].label}
                        >
                          <TileMark
                            tone={AGENT_MARK[agent].tone}
                            glyph={AGENT_MARK[agent].glyph}
                            pulsing={AGENT_MARK[agent].pulsing === true}
                          />
                        </View>
                      ) : undefined,
                    bottom:
                      result !== undefined ? (
                        <View testID={`work-result-${session.sessionId}`}>
                          <TileMark tone={result.tone} glyph={result.glyph} />
                        </View>
                      ) : undefined,
                  },
                }}
                trailing={
                  tag !== undefined || markers.length > 0 ? (
                    <View style={styles.trailing}>
                      {tag !== undefined ? (
                        <StatusTag intent={tag} label={sessionBadge(session.status).label} />
                      ) : null}
                      <SessionMarkerColumn
                        markers={markers}
                        previewUrl={previews.urls.get(session.sessionId) ?? null}
                        onOpenLinks={() => openSettings(session, true)}
                      />
                    </View>
                  ) : undefined
                }
                onPress={() => {
                  markSeen(session.sessionId, session.eventCount, session.eventCountVersion);
                  onOpenSession(session.sessionId);
                }}
                onLongPress={() => actions(session)}
                accessibilityLabel={spoken}
                accessibilityHint="Opens the session. Long press to favorite, link, rename or delete it."
              />
            );
          })}
        </Group>
      )}
      {settings ? (
        <SessionSettingsDialog
          key={settings.session.sessionId}
          initialSection={settings.links ? 'links' : undefined}
          sessionId={settings.session.sessionId}
          sessionName={settings.session.name ?? null}
          displayName={sessionLabel(settings.session)}
          projectId={settings.session.projectId ?? null}
          projectName={
            settings.projects.find((project) => project.id === settings.session.projectId)?.repo ??
            'No project'
          }
          canMove={
            settings.session.status !== 'running' &&
            settings.projects.some(
              (project) => project.id === settings.session.projectId && project.kind === 'local',
            )
          }
          moveDisabledReason={
            settings.session.status === 'running'
              ? 'Finish the current turn before changing projects.'
              : 'Moving is available for normal sessions in local projects.'
          }
          client={client}
          projects={settings.projects
            .filter((project) => project.kind === 'local')
            .map((project) => ({ id: project.id, name: project.repo }))}
          // The same rule as the session list's dialog, so both offer the same partners.
          linkableSessions={settings.everySession
            .filter((candidate) =>
              isLinkableSession(candidate, settings.session.sessionId, settings.projects),
            )
            .map((candidate) => ({
              id: candidate.sessionId,
              name: sessionLabel(candidate),
              projectId: candidate.projectId!,
              projectName:
                settings.projects.find((project) => project.id === candidate.projectId)?.repo ??
                candidate.projectId!,
              detail: modelDisplayName(candidate.model),
            }))}
          onClose={() => setSettings(undefined)}
          onDelete={() => confirmRemove(settings.session)}
          onChanged={() => onChanged(settings.session.sessionId, false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.md },
  flex: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  empty: { paddingVertical: theme.spacing.md },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
}));
