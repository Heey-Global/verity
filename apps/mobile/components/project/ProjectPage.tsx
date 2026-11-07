import { ProjectInquiryCards } from './ProjectInquiryCards';
import {
  inboxDismissedKeys,
  inboxItems,
  providerName,
  type InboxItem,
  type ProjectDetail,
  type ProjectRecord,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useInboxFeed } from '../home/HomeInbox';
import { KnowledgeColumn } from '../knowledge/KnowledgeBrowser';
import {
  folderIcon,
  folderSubtitle,
  folderTitle,
  type KnowledgeScope,
} from '../knowledge/knowledgeScope';
import { Button, Group, IconButton, Row, SectionHeader, StatusTag, Text } from '../ui';
import { tint } from '../ui/tint';
import { useProjectDetail } from '../../lib/useProjectDetail';
import { ProjectTasksRow } from './ProjectTasksRow';
import { ProjectWork } from './ProjectWork';
import {
  packagesToUpdate,
  ProjectSecurityRow,
  useProjectSecurity,
  type ProjectSecurity,
} from '../vulnerability/ProjectSecurity';

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
      // The page's own Security row lists the findings and offers the fix;
      // Home's item only says how many and leads here.
      .filter((item) => !item.key.startsWith(`health:${project.id}:vulnerabilities:`))
      .map((item) => ({
        ...item,
        actions: item.actions.filter((action) => action.kind !== 'open_project'),
      }))
  );
}

/**
 * A project's own page in the new design (Settings › This app), one scrolling
 * page: the project, its work — by default what needs the operator and what is
 * running ({@link ProjectWork}) — and what it holds, its knowledge first. The
 * gear leads to the project settings.
 *
 * `inline` draws the page inside the wide layout's left column, with its own
 * "Projects" back control, and opens the knowledge in that column; otherwise it
 * is a stack screen that names itself in the navigation bar and pushes the
 * knowledge as a screen of its own.
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
}: {
  client: VerityClient;
  projectId: string;
  selectedSessionId?: string | null | undefined;
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
}) {
  const { theme } = useUnistyles();
  const { detail, loading, error, load } = useProjectDetail(client, projectId);
  /** The knowledge area open in the wide layout's column, if any. */
  const [knowledgeArea, setKnowledgeArea] = useState<string>();
  const security = useProjectSecurity(client, projectId, onOpenSession);
  const knowledgeScope = useMemo<KnowledgeScope>(
    () => ({ kind: 'project', projectId }),
    [projectId],
  );
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(() => void load(true), [load]);
  const refresh = useCallback(() => {
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  }, [load]);
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
  // Held by the page rather than the work list: switching its filter must not
  // drop an answer in flight or its reply id, or a second tap could send it twice.
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
  const openKnowledge = useCallback(
    (folder: string) => {
      if (inline) setKnowledgeArea(folder);
      else router.push({ pathname: '/project/[id]/knowledge', params: { id: projectId, folder } });
    },
    [inline, projectId],
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
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <ProjectHero project={detail.project} sessions={detail.sessions} />
        <ProjectWork
          client={client}
          projectId={projectId}
          sessions={detail.sessions}
          selectedSessionId={selectedSessionId}
          feed={feed}
          leadingRows={securityRows(security)}
          onOpenSession={onOpenSession}
          onChanged={sessionChanged}
        />
        <ProjectInquiryCards client={client} projectId={projectId} />
        <SectionHeader title="Content" variant="eyebrow" />
        <ProjectContent
          client={client}
          detail={detail}
          security={security}
          onOpenKnowledge={openKnowledge}
        />
      </ScrollView>
    );
  }

  if (inline && knowledgeArea !== undefined) {
    return (
      <View style={styles.flex} testID="project-knowledge">
        <View style={styles.topBar}>
          <Button
            label={name}
            icon="chevron-left"
            variant="text"
            size="compact"
            onPress={() => setKnowledgeArea(undefined)}
          />
        </View>
        <KnowledgeColumn
          key={`${projectId}:${knowledgeArea}`}
          client={client}
          scope={knowledgeScope}
          start={knowledgeArea}
        />
      </View>
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

/** Severe findings wait at the top of "Needs you", with the fix one tap away. */
function securityRows(security: ProjectSecurity | undefined): ReactElement[] {
  if (!security || (security.severe === 0 && !security.status)) return [];
  return [<ProjectSecurityRow key="security" security={security} />];
}

/** Repair asks for a decision; the sandbox settings explain it and offer it. */
function openSandbox(projectId: string) {
  router.push({ pathname: '/project/[id]/settings/sandbox', params: { id: projectId } });
}

/** The project’s Wiki (with its decisions), sources, tasks and security findings. */
function ProjectContent({
  client,
  detail,
  security,
  onOpenKnowledge,
}: {
  client: VerityClient;
  detail: ProjectDetail;
  security: ProjectSecurity | undefined;
  onOpenKnowledge: (folder: string) => void;
}) {
  const id = detail.project.id;
  const scope = useMemo<KnowledgeScope>(() => ({ kind: 'project', projectId: id }), [id]);
  const severe = security !== undefined && security.severe > 0;
  return (
    <Group>
      {(['insights', 'sources'] as const).map((area) => (
        <Row
          key={area}
          leading={{ icon: folderIcon(area) }}
          title={folderTitle(scope, area)}
          subtitle={folderSubtitle(area)}
          navigates
          onPress={() => onOpenKnowledge(area)}
        />
      ))}
      <ProjectTasksRow client={client} projectId={id} />
      {security !== undefined ? (
        <Row
          leading={{ icon: 'shield', ...(severe ? { intent: 'needsSetup' as const } : {}) }}
          title="Security"
          subtitle={packagesToUpdate(security.packages)}
          trailing={
            <StatusTag
              intent={severe ? 'needsSetup' : 'optional'}
              label={security.status ?? (severe ? 'Security' : 'Review')}
            />
          }
          navigates
          onPress={security.show}
        />
      ) : null}
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
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  initial: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
}));
