import {
  VerityApiError,
  inboxView,
  markerAttention,
  modelDisplayName,
  sessionAgentMark,
  sessionAttention,
  sessionBadge,
  sessionLabel,
  sessionTile,
  showsSessionLabel,
  workOrder,
  type AttentionFlag,
  type AttentionKind,
  type InboxAction,
  type InboxItem,
  type ProjectRecord,
  type SessionAgentMark,
  type SessionStatus,
  type SessionSummary,
  type SessionTile,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Alert, Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { InboxFeed } from '../home/HomeInbox';
import { AnswerButtons, AnswerSheet } from './AnswerSheet';
import { SessionMarkerColumn, sessionMarkers, sessionMarkersLabel } from '../SessionMarkerColumn';
import { SwipeableSessionRow } from '../SessionRowActions';
import { SessionSettingsDialog } from '../SessionSettingsDialog';
import type { IconName } from '../Icon';
import {
  FilterChips,
  Group,
  IconButton,
  Row,
  SectionHeader,
  StatusTag,
  Text,
  TileMark,
} from '../ui';
import type { TileMarkGlyph, TileMarkTone } from '../ui';
import type { StatusIntent } from '../ui/Status';
import { isLinkableSession } from '../../lib/sessionLinks';
import { useSessionPreviews } from '../../lib/sessionPreviews';
import { useUnread } from '../../hooks/useUnread';

export type WorkFilter = 'now' | 'all' | 'favorites';

const EMPTY: Record<Exclude<WorkFilter, 'now'>, string> = {
  all: 'No sessions in this project yet.',
  favorites:
    Platform.OS === 'web'
      ? 'No favorites. Right-click a session to add one.'
      : 'No favorites. Swipe right on a session to add one.',
};

// Only the states a bare row cannot show carry a tag (showsSessionLabel): running
// has the working dot, done and idle are the absence of one. Done is not green
// here, as it never was in the session list.
const TAG_INTENT: Partial<Record<SessionStatus, StatusIntent>> = {
  awaiting_input: 'needsSetup',
  crashed: 'needsSetup',
  awaiting_dependency: 'optional',
};

const TONE_INTENT: Record<InboxItem['tone'], StatusIntent> = {
  attention: 'needsSetup',
  action: 'action',
  success: 'ready',
  neutral: 'optional',
};

/** Pull request and sandbox problems that need the operator but have no inbox item. */
const FLAG_TAG: Partial<Record<AttentionKind, string>> = {
  sandbox_disconnected: 'Sandbox',
  merge_conflict: 'Conflict',
  ci_failed: 'CI failed',
  merge_blocked: 'Blocked',
};

/** Answers a row can give in place. A permission opens its session instead: the
 *  row has no room for the request the operator has to read before allowing it. */
const IN_PLACE: ReadonlySet<InboxAction['kind']> = new Set([
  'answer',
  'merge',
  'resume',
  'repair_project',
]);

/** Working on a turn or a background task, or waiting on another session. */
export function isActive(session: SessionSummary): boolean {
  return (
    session.status === 'running' ||
    session.status === 'awaiting_dependency' ||
    session.backgroundWorking === true
  );
}

/** One row of "Needs you": a session with what it waits on, or a project's own item. */
export type NeedsYouEntry =
  | { kind: 'session'; session: SessionSummary; item?: InboxItem; flag?: AttentionFlag }
  | { kind: 'project'; item: InboxItem };

/**
 * The two sections of the Now filter. "Needs you" holds one entry per session
 * with a visible inbox item — its most pressing one, in inbox order — then the
 * sessions whose pull request or sandbox is stuck, then nothing else. A
 * dismissed item does not count, so a set-aside question leaves Now. "Running &
 * new" holds the rest that is moving or has an answer the operator has not read.
 */
export function nowSections(
  sessions: readonly SessionSummary[],
  items: readonly InboxItem[],
  /** Sessions with an answer the operator has not read ({@link useUnread}). */
  unread: ReadonlySet<string>,
  previous: readonly SessionSummary[] = [],
): { needsYou: NeedsYouEntry[]; active: SessionSummary[] } {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const needsYou: NeedsYouEntry[] = [];
  const taken = new Set<string>();
  for (const item of items) {
    if (item.sessionId === undefined) {
      if (item.kind !== 'meeting') needsYou.push({ kind: 'project', item });
      continue;
    }
    const session = byId.get(item.sessionId);
    if (session === undefined || taken.has(session.sessionId)) continue;
    taken.add(session.sessionId);
    needsYou.push({ kind: 'session', session, item });
  }
  for (const session of workOrder(sessions)) {
    if (taken.has(session.sessionId)) continue;
    const flag = sessionAttention({
      status: session.status,
      pr: session.pr,
      attention: session.attention,
    }).find((candidate) => FLAG_TAG[candidate.kind] !== undefined);
    if (flag === undefined) continue;
    taken.add(session.sessionId);
    needsYou.push({ kind: 'session', session, flag });
  }
  const active = workOrder(
    sessions.filter(
      (session) =>
        !taken.has(session.sessionId) && (isActive(session) || unread.has(session.sessionId)),
    ),
    new Map(),
    previous,
  );
  return { needsYou, active };
}

/** Which sessions the All and favorites filters keep. */
export function workFilter(session: SessionSummary, filter: Exclude<WorkFilter, 'now'>): boolean {
  return filter === 'all' || session.favorite === true;
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

/** What an item asks, under its session's name: the question, else what happened. */
function itemSubtitle(item: InboxItem, label: string): string | undefined {
  return item.title === label ? item.message : item.title;
}

/**
 * A project's sessions, filtered and ordered by what they need.
 *
 * Now, the default, is one list in two sections: what waits on the operator,
 * each row tagged with what it waits for and offering the answers that can be
 * given in place, and below it what is running or has a new answer. A section
 * with nothing in it is left out. All lists every session in {@link workOrder};
 * the star keeps the favorites.
 *
 * Dismissing is Home's: an item dismissed there stays out of Now, and Home is
 * where it is restored, so this list keeps no fold of hidden items.
 *
 * Each row leads with its {@link sessionTile}: the pull request's phase and
 * verdict, else automation, else a neutral tile, with the agent's state (working,
 * new answer, waiting) as the tile's top mark; a "Needs you" row keeps the status
 * dot of what it waits for. The trailing column keeps the star, automation and
 * link markers. A row opens its session; swipe actions
 * and the browser context menu offer favorite, session settings (rename, move,
 * linked sessions) and delete.
 */
export function ProjectWork({
  client,
  projectId,
  sessions: serverSessions,
  feed,
  leadingRows = [],
  initialFilter = 'now',
  onOpenSession,
  selectedSessionId,
  onChanged,
}: {
  client: VerityClient;
  /** The project a new session starts in; none for sessions outside a project. */
  projectId?: string | undefined;
  sessions: readonly SessionSummary[];
  selectedSessionId?: string | null | undefined;
  /** The page's inbox feed: what waits on the operator and how to answer it.
   *  Without one, Now derives the same items from the sessions — dismissed ones
   *  left out — but offers no answers in place. */
  feed?: InboxFeed | undefined;
  /** Rows the page adds at the top of "Needs you", such as severe findings. */
  leadingRows?: readonly ReactElement[];
  initialFilter?: WorkFilter;
  onOpenSession: (sessionId: string) => void;
  /** After a rename, favorite, move, link or delete of `sessionId`, so the page
   *  and its host (the wide layout's list and session pane) catch up. */
  onChanged: (sessionId: string, deleted: boolean) => void;
}) {
  // Keep confirmed removals hidden across stale parent refreshes while the
  // server stops the session and cleans up its worktree.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());
  const sessions = useMemo(
    () => serverSessions.filter((session) => !removedIds.has(session.sessionId)),
    [serverSessions, removedIds],
  );
  // Derive from the last snapshot so activity updates and newly started turns
  // cannot insert rows ahead of sessions already working.
  const [workSnapshot, setWorkSnapshot] = useState(() => ({
    source: sessions,
    ordered: workOrder(sessions),
  }));
  let ordered = workSnapshot.ordered;
  if (workSnapshot.source !== sessions) {
    ordered = workOrder(sessions, new Map(), workSnapshot.ordered);
    setWorkSnapshot({ source: sessions, ordered });
  }
  const [filter, setFilter] = useState<WorkFilter>(initialFilter);
  // The key, not the item: the sheet follows the live feed, so a question
  // answered elsewhere while it is open closes it instead of offering stale
  // answers to a session that no longer waits.
  const [answeringKey, setAnsweringKey] = useState<string | null>(null);
  const { unread: unreadIds, markSeen } = useUnread(client, sessions);
  const previews = useSessionPreviews();
  const derived = useMemo(
    () =>
      feed === undefined
        ? inboxView({ sessions, projects: [], now: Date.now() }).visible
        : undefined,
    [feed, sessions],
  );
  const items = feed?.items ?? derived;
  const answering =
    answeringKey === null ? null : (items?.find((item) => item.key === answeringKey) ?? null);
  useEffect(() => {
    if (answeringKey !== null && answering === null) setAnsweringKey(null);
  }, [answeringKey, answering]);
  const now = useMemo(
    () => nowSections(sessions, items ?? [], unreadIds, ordered),
    [sessions, items, unreadIds, ordered],
  );
  // The visible item of each session, so All tags it the way Now does.
  const itemFor = useMemo(() => {
    const map = new Map<string, InboxItem>();
    for (const item of items ?? [])
      if (item.sessionId !== undefined && !map.has(item.sessionId)) map.set(item.sessionId, item);
    return map;
  }, [items]);
  const listed = useMemo(
    () =>
      filter === 'now'
        ? []
        : workOrder(
            sessions.filter((session) => workFilter(session, filter)),
            new Map(),
            ordered,
          ),
    [sessions, filter, ordered],
  );
  const needsCount = leadingRows.length + now.needsYou.length;
  const nowCount = needsCount + now.active.length;
  const filters: readonly { value: WorkFilter; label: string; icon?: 'star' }[] = [
    { value: 'now', label: nowCount > 0 ? `Now · ${String(nowCount)}` : 'Now' },
    { value: 'all', label: 'All' },
    { value: 'favorites', label: 'Favorites', icon: 'star' },
  ];
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
  const remove = (session: SessionSummary, force = false) => {
    setRemovedIds((previous) => new Set(previous).add(session.sessionId));
    setSettings(undefined);
    void client.deleteSession(session.sessionId, force ? { force } : {}).then(
      () => onChanged(session.sessionId, true),
      (caught) => {
        setRemovedIds((previous) => {
          const next = new Set(previous);
          next.delete(session.sessionId);
          return next;
        });
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
  };
  const confirmRemove = (session: SessionSummary) =>
    Alert.alert(
      'Delete session?',
      `This permanently removes "${sessionLabel(session)}" — its history${session.automation ? ', its automation,' : ''} and worktree. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => remove(session) },
      ],
    );

  const sessionRow = (
    session: SessionSummary,
    waiting?: {
      tag: string;
      intent: StatusIntent;
      subtitle?: string | undefined;
      item?: InboxItem;
      /** Drawn in "Needs you": a status dot instead of the activity dot, the
       *  item's question as subtitle, its answers, and the chevron. */
      needs?: boolean;
    },
  ) => {
    const needs = waiting?.needs === true;
    const label = sessionLabel(session);
    const working = isActive(session);
    const unread = !working && unreadIds.has(session.sessionId);
    const item = waiting?.item;
    const tile = sessionTile(session);
    const agent = sessionAgentMark({ status: session.status, working, unread });
    const result = tile.result !== undefined ? RESULT_MARK[tile.result] : undefined;
    const tileIntent = TILE_INTENT[tile.tone];
    const statusTag =
      waiting !== undefined
        ? { label: waiting.tag, intent: waiting.intent }
        : showsSessionLabel(session.status) && TAG_INTENT[session.status] !== undefined
          ? { label: sessionBadge(session.status).label, intent: TAG_INTENT[session.status]! }
          : undefined;
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
      waiting?.subtitle,
      // From the same mark the tile draws, so the screen and VoiceOver never
      // disagree; waiting is spoken by the tag that names what it waits for.
      agent === 'working' ? 'working' : agent === 'unread' ? 'new answer' : null,
      // The row speaks one label, so the subtitle's PR verdict is not read on its
      // own; the tile says it instead, unless the tag already does.
      !needs &&
      (tile.glyph === 'pull_request' || tile.glyph === 'merged') &&
      tile.label.toLowerCase() !== statusTag?.label.toLowerCase()
        ? tile.label
        : null,
      statusTag?.label,
      markers.length > 0 ? sessionMarkersLabel(markers) : null,
    ]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(', ');
    return (
      <SwipeableSessionRow
        key={session.sessionId}
        favorite={session.favorite === true}
        label={label}
        onToggleFavorite={() => toggleFavorite(session)}
        onEdit={() => openSettings(session)}
        onDelete={() => confirmRemove(session)}
      >
        <Row
          title={label}
          active={session.sessionId === selectedSessionId}
          // Merged and quiet: the work is done and the row only waits to be
          // deleted, so it recedes the way it sinks to the bottom of the list. A
          // star keeps it with the favorites, at full strength.
          settled={
            tile.glyph === 'merged' &&
            agent === undefined &&
            statusTag === undefined &&
            session.favorite !== true
          }
          subtitle={waiting?.subtitle ?? workSubtitle(session)}
          leading={
            needs && waiting !== undefined
              ? { dot: waiting.intent }
              : {
                  icon: TILE_ICON[tile.glyph],
                  ...(tileIntent !== undefined ? { intent: tileIntent } : { quiet: true }),
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
                        <View
                          testID={`work-result-${session.sessionId}`}
                          accessibilityRole="image"
                          accessibilityLabel={tile.label}
                        >
                          <TileMark tone={result.tone} glyph={result.glyph} />
                        </View>
                      ) : undefined,
                  },
                }
          }
          // In "Needs you" the tag leads the subtitle, so the title keeps the
          // width the chevron leaves instead of wrapping beside the tag.
          tag={
            needs && statusTag !== undefined ? (
              <StatusTag intent={statusTag.intent} label={statusTag.label} />
            ) : undefined
          }
          trailing={
            (!needs && statusTag !== undefined) || markers.length > 0 ? (
              <View style={styles.trailing}>
                {!needs && statusTag !== undefined ? (
                  <StatusTag intent={statusTag.intent} label={statusTag.label} />
                ) : null}
                <SessionMarkerColumn
                  markers={markers}
                  previewUrl={previews.urls.get(session.sessionId) ?? null}
                  onOpenLinks={() => openSettings(session, true)}
                />
              </View>
            ) : undefined
          }
          navigates={needs}
          answers={needs && item !== undefined ? answersFor(item) : undefined}
          onPress={() => {
            markSeen(session.sessionId, session.eventCount, session.eventCountVersion);
            onOpenSession(session.sessionId);
          }}
          accessibilityLabel={spoken}
          accessibilityHint={
            Platform.OS === 'web'
              ? 'Opens the session. Right-click for favorite, edit and delete actions.'
              : 'Opens the session. Swipe right to favorite, or left to edit or delete.'
          }
        />
      </SwipeableSessionRow>
    );
  };
  const answersOf = (item: InboxItem) => item.actions.filter((action) => IN_PLACE.has(action.kind));
  const send = (item: InboxItem, action: InboxAction) => {
    // `perform` reports failures as outcomes; anything it throws is
    // unexpected, but the operator still has to learn it was not sent.
    feed?.run(item, action).catch(() => {
      Alert.alert('Not sent', 'Something went wrong. Open the session and try again.');
    });
  };
  const answersFor = (item: InboxItem) => {
    if (feed === undefined) return undefined;
    const answers = answersOf(item);
    if (answers.length === 0) return undefined;
    // Only this item's answers wait; the other rows stay answerable.
    const locked = feed.pending.has(item.key);
    return (
      <AnswerButtons
        answers={answers}
        pending={feed.pending.get(item.key) ?? false}
        disabled={locked}
        onMore={() => setAnsweringKey(item.key)}
        onAnswer={(action) => send(item, action)}
      />
    );
  };
  const needsYouRow = (entry: NeedsYouEntry) => {
    if (entry.kind === 'project') {
      const { item } = entry;
      return (
        <Row
          key={item.key}
          title={item.context}
          subtitle={item.message}
          leading={{ icon: 'server', intent: 'needsSetup' }}
          tag={<StatusTag intent={TONE_INTENT[item.tone]} label={item.tag} />}
          // A project's own item is about its sandbox; the settings explain it
          // even when no answer can be given here, such as a stalled update.
          navigates
          onPress={() =>
            router.push({
              pathname: '/project/[id]/settings/sandbox',
              params: { id: item.projectId ?? projectId ?? '' },
            })
          }
          answers={answersFor(item)}
        />
      );
    }
    const { session, item, flag } = entry;
    if (item !== undefined)
      return sessionRow(session, {
        tag: item.tag,
        intent: TONE_INTENT[item.tone],
        subtitle: itemSubtitle(item, sessionLabel(session)),
        item,
        needs: true,
      });
    // The tag names the problem; the line under the name says where it is.
    const pr = session.pullRequest;
    return sessionRow(session, {
      tag: FLAG_TAG[flag!.kind]!,
      intent: 'needsSetup',
      subtitle: pr ? `PR #${String(pr.number)} · ${pr.title}` : flag!.label,
      needs: true,
    });
  };

  return (
    <View style={styles.root} testID="project-work">
      <View style={styles.toolbar}>
        <View style={styles.flex}>
          <FilterChips
            options={filters}
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
      {filter === 'now' ? (
        <>
          {needsCount > 0 ? (
            <View style={styles.section} testID="work-needs-you">
              <SectionHeader title={`Needs you · ${String(needsCount)}`} flush />
              <Group>
                {leadingRows}
                {now.needsYou.map(needsYouRow)}
              </Group>
            </View>
          ) : null}
          {now.active.length > 0 ? (
            <View style={styles.section} testID="work-active">
              <SectionHeader title={`Running & new · ${String(now.active.length)}`} flush />
              <Group>{now.active.map((session) => sessionRow(session))}</Group>
            </View>
          ) : null}
        </>
      ) : listed.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {EMPTY[filter]}
        </Text>
      ) : (
        <Group>
          {listed.map((session) => {
            const item = itemFor.get(session.sessionId);
            return item !== undefined
              ? sessionRow(session, {
                  tag: item.tag,
                  intent: TONE_INTENT[item.tone],
                })
              : sessionRow(session);
          })}
        </Group>
      )}
      <AnswerSheet
        item={answering}
        answers={answering !== null ? answersOf(answering) : []}
        onAnswer={(action) => {
          const item = answering!;
          setAnsweringKey(null);
          send(item, action);
        }}
        onOpenSession={
          answering?.sessionId !== undefined
            ? () => {
                const id = answering.sessionId!;
                setAnsweringKey(null);
                onOpenSession(id);
              }
            : undefined
        }
        onClose={() => setAnsweringKey(null)}
      />
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
  section: { gap: theme.spacing.sm },
  empty: { paddingVertical: theme.spacing.md },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
}));
