import {
  inboxDismissedKeys,
  inboxItems,
  projectBadge,
  providerName,
  type InboxItem,
  type ProjectDetail,
  type ProjectRecord,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from '../CodeHostIcon';
import { InboxFeedList, useInboxFeed, type InboxFeed } from '../home/HomeInbox';
import { KnowledgeColumn } from '../knowledge/KnowledgeBrowser';
import type { KnowledgeScope } from '../knowledge/knowledgeScope';
import { Button, FilterChips, Group, IconButton, Row, SectionHeader, StatusTag, Text } from '../ui';
import type { StatusIntent } from '../ui/Status';
import { tint } from '../ui/tint';
import { useProjectConnections, type ProjectConnections } from '../../lib/useProjectConnections';
import { useProjectDetail } from '../../lib/useProjectDetail';
import { ProjectTasksRow } from './ProjectTasksRow';
import { ProjectWork } from './ProjectWork';
import { ProjectSecurityCard } from '../vulnerability/ProjectSecurityCard';

export type ProjectTab = 'overview' | 'work' | 'knowledge';

const TABS: readonly { value: ProjectTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'work', label: 'Work' },
  { value: 'knowledge', label: 'Knowledge' },
];

/** How many of the project's sessions have an open pull request. */
function openPullRequests(sessions: readonly SessionSummary[]): number {
  return sessions.filter((session) => session.pullRequest?.phase === 'open').length;
}

/** The line under the project's name: where its code lives and what is open. */
export function projectLine(project: ProjectRecord, sessions: readonly SessionSummary[]): string {
  const open = openPullRequests(sessions);
  const parts =
    project.kind === 'github' || project.kind === 'forgejo'
      ? [providerName(project.kind), `${project.owner}/${project.repo}`]
      : ['Local project'];
  if (open > 0) parts.push(open === 1 ? '1 open PR' : `${String(open)} open PRs`);
  return parts.join(' · ');
}

/**
 * The inbox items that belong to one project: its sessions' questions,
 * permissions, crashes and merges, and its own health. Meetings belong to no
 * project, and "Open" on a health item would open the page it is shown on.
 */
export function projectInboxItems(
  project: ProjectRecord,
  sessions: readonly SessionSummary[],
  now: number,
): InboxItem[] {
  return (
    inboxItems({ sessions, projects: [project], now })
      .filter((item) => item.projectId === project.id)
      // The Security card on this page lists the findings and offers the fix;
      // Home's item only says how many and leads here.
      .filter((item) => !item.key.startsWith(`health:${project.id}:vulnerabilities:`))
      .map((item) => ({
        ...item,
        actions: item.actions.filter((action) => action.kind !== 'open_project'),
      }))
  );
}

/**
 * A project's own page in the new design (Settings › This app): what waits for
 * the operator here and what the project holds, its sessions, and its knowledge.
 * The gear leads to the project settings.
 *
 * `inline` draws the page inside the wide layout's left column, with its own
 * "Projects" back control; otherwise it is a stack screen and names itself in
 * the navigation bar.
 */
export function ProjectPage({
  client,
  projectId,
  inline = false,
  onBack,
  onOpenSession,
  onRepairProject,
  onSessionChanged,
  onInboxSaved,
  reloadOn,
  selectedSessionId,
  initialTab = 'overview',
}: {
  client: VerityClient;
  projectId: string;
  inline?: boolean;
  onBack?: (() => void) | undefined;
  onOpenSession: (sessionId: string) => void;
  /** What Repair on a health item does; the sandbox settings, which offer it, when omitted. */
  onRepairProject?: ((projectId: string) => void) | undefined;
  /**
   * Changes whenever the host polled newer sessions and projects; the page then
   * reloads too, so it never lags the list and Home beside it.
   */
  reloadOn?: unknown;
  /** An inbox item on this page was answered, dismissed or restored. */
  onInboxSaved?: (() => void) | undefined;
  /** A session was renamed, (un)favorited or deleted on this page. */
  onSessionChanged?: ((sessionId: string, deleted: boolean) => void) | undefined;
  selectedSessionId?: string | null | undefined;
  initialTab?: ProjectTab;
}) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load } = useProjectDetail(client, projectId);
  const connections = useProjectConnections(client, projectId);
  const refreshConnections = connections.refresh;
  const [tab, setTab] = useState<ProjectTab>(initialTab);
  const knowledgeScope = useMemo<KnowledgeScope>(
    () => ({ kind: 'project', projectId }),
    [projectId],
  );
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(() => void load(true), [load]);
  const refresh = useCallback(() => {
    setRefreshing(true);
    refreshConnections();
    void load(true).finally(() => setRefreshing(false));
  }, [refreshConnections, load]);
  // Compared with the last value rather than skipping a first run: the mount
  // already loads, and a re-run with the same token (a re-mounted effect, a new
  // `reload`) must not read again.
  const lastReloadOn = useRef(reloadOn);
  useEffect(() => {
    if (Object.is(lastReloadOn.current, reloadOn)) return;
    lastReloadOn.current = reloadOn;
    reload();
  }, [reloadOn, reload]);
  // A host that passes `reloadOn` refreshes after the change and moves the token;
  // reading here as well would fetch the detail twice.
  const hostReloads = reloadOn !== undefined;
  const inboxSaved = useCallback(() => {
    if (!hostReloads) reload();
    onInboxSaved?.();
  }, [hostReloads, reload, onInboxSaved]);
  const sessionChanged = useCallback(
    (sessionId: string, deleted: boolean) => {
      if (!hostReloads) reload();
      onSessionChanged?.(sessionId, deleted);
    },
    [hostReloads, reload, onSessionChanged],
  );
  // Held by the page rather than the Overview tab: switching tabs must not drop
  // an answer in flight or its reply id, or a second tap could send it twice.
  const now = useClock();
  const all = useMemo(
    () => (detail ? projectInboxItems(detail.project, detail.sessions, now) : []),
    [detail, now],
  );
  const serverHidden = useMemo(
    () =>
      detail
        ? inboxDismissedKeys({ sessions: detail.sessions, projects: [detail.project] })
        : new Set<string>(),
    [detail],
  );
  const feed = useInboxFeed({
    client,
    all,
    serverHidden,
    onOpenSession,
    onRepairProject: onRepairProject ?? openSandbox,
    onSaved: inboxSaved,
  });
  const openSettings = useCallback(
    () => router.push({ pathname: '/project/[id]/settings', params: { id: projectId } }),
    [projectId],
  );
  const name = detail?.project.repo ?? 'Project';
  const gear = (
    <IconButton icon="settings" accessibilityLabel="Project settings" onPress={openSettings} />
  );

  let body;
  if (detail === undefined) {
    body =
      loading || error === undefined ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.text} />
        </View>
      ) : (
        <View style={styles.centered}>
          <Text variant="body" tone="muted">
            {error}
          </Text>
          <Button label="Retry" variant="secondary" size="compact" onPress={reload} />
        </View>
      );
  } else {
    body = (
      <>
        <ProjectHero project={detail.project} sessions={detail.sessions} />
        <View style={styles.tabs}>
          <FilterChips
            options={TABS}
            value={tab}
            onChange={setTab}
            accessibilityLabel="Project sections"
            wrap
          />
        </View>
        {tab === 'knowledge' ? (
          <View style={styles.flex} testID="project-knowledge">
            <KnowledgeColumn key={projectId} client={client} scope={knowledgeScope} />
          </View>
        ) : (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.content}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          >
            {tab === 'overview' ? (
              <ProjectOverview
                client={client}
                onOpenSession={onOpenSession}
                feed={feed}
                detail={detail}
                connections={connections}
                selectedSessionId={selectedSessionId}
              />
            ) : (
              <ProjectWork
                client={client}
                projectId={projectId}
                sessions={detail.sessions}
                selectedSessionId={selectedSessionId}
                onOpenSession={onOpenSession}
                onChanged={sessionChanged}
              />
            )}
          </ScrollView>
        )}
      </>
    );
  }

  return (
    <View style={styles.flex} testID="project-page">
      {inline ? (
        <View style={styles.topBar}>
          <Button
            label="Projects"
            icon="chevron-left"
            variant="text"
            size="compact"
            onPress={() => onBack?.()}
          />
          {gear}
        </View>
      ) : (
        <Stack.Screen options={{ title: name, headerRight: () => gear }} />
      )}
      {body}
    </View>
  );
}

function ProjectHero({
  project,
  sessions,
}: {
  project: ProjectRecord;
  sessions: readonly SessionSummary[];
}) {
  return (
    <View style={styles.hero}>
      <View style={styles.initial}>
        <Text variant="title" tone="action">
          {(project.repo.trim()[0] ?? '?').toUpperCase()}
        </Text>
      </View>
      <View style={styles.flex}>
        <Text variant="title" accessibilityRole="header" numberOfLines={1}>
          {project.repo}
        </Text>
        <Text variant="subtitle" numberOfLines={1} testID="project-line">
          {projectLine(project, sessions)}
        </Text>
      </View>
    </View>
  );
}

function ProjectOverview({
  client,
  onOpenSession,
  feed,
  detail,
  connections,
  selectedSessionId,
}: {
  client: VerityClient;
  onOpenSession: (sessionId: string) => void;
  feed: InboxFeed;
  detail: ProjectDetail;
  connections: ProjectConnections;
  selectedSessionId?: string | null | undefined;
}) {
  return (
    <>
      <SectionHeader title="For you in this project" variant="eyebrow" flush />
      {feed.items.length === 0 ? (
        <Text variant="body" tone="muted" testID="project-for-you-empty">
          Nothing here needs you.
        </Text>
      ) : null}
      <InboxFeedList feed={feed} selectedSessionId={selectedSessionId} />
      <ProjectSecurityCard
        client={client}
        projectId={detail.project.id}
        onOpenSession={onOpenSession}
      />
      <SectionHeader title="Content" variant="eyebrow" />
      <ProjectContent client={client} detail={detail} connections={connections} />
    </>
  );
}

/** Repair asks for a decision; the sandbox settings explain it and offer it. */
function openSandbox(projectId: string) {
  router.push({ pathname: '/project/[id]/settings/sandbox', params: { id: projectId } });
}

function sandboxIntent(badge: ReturnType<typeof projectBadge>, project: ProjectRecord) {
  const intent: StatusIntent = badge.pulsing
    ? 'transient'
    : badge.needsRepair
      ? 'needsSetup'
      : project.state === 'active'
        ? 'ready'
        : 'optional';
  return intent;
}

/**
 * What the project holds, each row leading to the setting that configures it.
 * Only services the project uses appear; adding one is a project setting.
 */
function ProjectContent({
  client,
  detail,
  connections,
}: {
  client: VerityClient;
  detail: ProjectDetail;
  connections: ProjectConnections;
}) {
  const { theme } = useUnistyles();
  const { project, settings, sessions } = detail;
  const { usage, driveFolderNames } = connections;
  const id = project.id;
  const toSettings = (
    pathname:
      | '/project/[id]/settings/repository'
      | '/project/[id]/settings/sandbox'
      | '/project/[id]/settings/services',
    section?: 'doppler' | 'drive' | 'mcp' | 'matrix' | 'google',
  ) => router.push({ pathname, params: section ? { id, section } : { id } });
  const badge = projectBadge(project);
  const open = openPullRequests(sessions);
  const host = project.kind === 'github' || project.kind === 'forgejo' ? project.kind : null;
  const drive =
    driveFolderNames ?? (settings?.googleDriveFolderName ? [settings.googleDriveFolderName] : []);
  return (
    <Group>
      <ProjectTasksRow client={client} projectId={id} />
      {host !== null ? (
        <Row
          leading={{
            element: <CodeHostIcon provider={host} color={theme.colors.action} />,
          }}
          title={`${project.owner}/${project.repo}`}
          subtitle={`${providerName(host)} · ${
            open === 1 ? '1 open PR' : `${String(open)} open PRs`
          }`}
          navigates
          onPress={() => toSettings('/project/[id]/settings/repository')}
        />
      ) : (
        <Row
          leading={{ icon: 'git-branch' }}
          title="Code workspace"
          subtitle="Local Git, no code host connected"
          navigates
          onPress={() => toSettings('/project/[id]/settings/repository')}
        />
      )}
      {settings?.dopplerConfig ? (
        <Row
          leading={{ icon: 'key' }}
          title="Doppler"
          subtitle={settings.dopplerConfig}
          navigates
          onPress={() => toSettings('/project/[id]/settings/services', 'doppler')}
        />
      ) : null}
      {drive.length > 0 ? (
        <Row
          leading={{ icon: 'folder' }}
          title="Google Drive"
          subtitle={drive.join(', ')}
          navigates
          onPress={() => toSettings('/project/[id]/settings/services', 'drive')}
        />
      ) : null}
      {usage.google > 0 ? (
        <Row
          leading={{ icon: 'mail' }}
          title="Google services"
          subtitle={`${String(usage.google)} of Gmail, Calendar and Contacts`}
          navigates
          onPress={() => toSettings('/project/[id]/settings/services', 'google')}
        />
      ) : null}
      {usage.mcp > 0 ? (
        <Row
          leading={{ icon: 'tool' }}
          title="MCP"
          subtitle={usage.mcp === 1 ? '1 connection' : `${String(usage.mcp)} connections`}
          navigates
          onPress={() => toSettings('/project/[id]/settings/services', 'mcp')}
        />
      ) : null}
      {usage.matrix > 0 ? (
        <Row
          leading={{ icon: 'message-circle' }}
          title="Matrix rooms"
          subtitle={usage.matrix === 1 ? '1 room' : `${String(usage.matrix)} rooms`}
          navigates
          onPress={() => toSettings('/project/[id]/settings/services', 'matrix')}
        />
      ) : null}
      <Row
        leading={{ icon: 'server' }}
        title="Sandbox"
        trailing={<StatusTag intent={sandboxIntent(badge, project)} label={badge.label} />}
        navigates
        onPress={() => toSettings('/project/[id]/settings/sandbox')}
      />
    </Group>
  );
}

/** Re-evaluates relative times on the page without new data. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  initial: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  tabs: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
}));
