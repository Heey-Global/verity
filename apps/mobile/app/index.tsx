// Sessions home screen: the live list of Claude Code sessions, bound to
// @verity/mobile's SessionListModel via useSessionList. Renders loading / error /
// empty / list states. When no server is configured it falls back to a "not
// connected" state. All StyleSheet.create-using components live in this file so
// the Unistyles Babel plugin (root: 'app') processes them.
import {
  type AttentionFlag,
  VerityApiError,
  type VerityClient,
  type DevServer,
  type DevServerStatusMutation,
  type DevServerDetection,
  type IssueSummary,
  type ProjectRecord,
  type ProviderLimitRow,
  type ProviderLimitState,
  type SandboxUpdate,
  type SessionSummary,
  isServerSecretSealedError,
  markerAttention,
  modelDisplayName,
  rateLimitWindowLabel,
  pacePercent,
  quotaMeterLevel,
  projectBadge,
  projectRepoRef,
  isSecuritySandboxUpdate,
  sandboxUpdateIndicator,
  subscribeProjectStatusMutations,
  subscribeDevServerStatusMutations,
  sandboxUpdateNeedsAttention,
  sessionBadge,
  attentionNotice,
  attentionNoticeText,
  sessionLabel,
  showsSessionLabel,
  UNAVAILABLE_PROJECT_BADGE,
  UNTRACKED_PROJECT_BADGE,
  type ProjectBadge,
} from '@verity/mobile';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  type GestureResponderEvent,
  Keyboard,
  type LayoutChangeEvent,
  Linking,
  type ListRenderItemInfo,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AttentionMarkers } from '../components/AttentionMarkers';
import { Icon } from '../components/Icon';
import { ProjectPortChip, type ProjectPortLink } from '../components/ProjectPortChip';
import { ProjectStatusDot } from '../components/ProjectStatusDot';
import { ServerAttentionBanner, StaleBanner } from '../components/ServerAttentionBanner';
import { UnreadDot } from '../components/UnreadDot';
import { WorkingDot } from '../components/WorkingDot';
import { useIssues } from '../hooks/useIssues';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useSessionList } from '../hooks/useSessionList';
import { useUnread } from '../hooks/useUnread';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { newSessionId, registerPendingSession } from '../lib/pendingSessions';
import { prefetchBranches } from '../lib/branchesPrefetch';
import { createSessionConfirmingWarnings } from '../lib/startSession';
import { devServerUrl } from '../lib/devServerUrl';
import { repairProject } from '../lib/projectRepair';
import {
  hasPendingProjectSetup,
  projectOverviewSetupLabel,
  projectOverviewWarning,
} from '../lib/projectSetup';
import { formatResetDisplay } from '../lib/time';
import { SessionChat } from './session/[id]';

type SessionProjectGroup = {
  id: string;
  title: string;
  subtitle: string;
  setupLabel?: string;
  /** Attention line for a project that is otherwise running — a provision
   *  warning, or a toolkit drift verdict a re-provision would repair. */
  warningLabel?: string;
  portLinks: ProjectPortLink[];
  project?: ProjectRecord;
  // Set on an "orphan" group — sessions whose project is INACTIVE (`absent`, so
  // filtered out of `GET /projects`). We still hold its id, so the overview can
  // offer the "…" action into the detail screen (where Repair lives) instead of
  // stranding the sessions with no way back.
  inactiveProjectId?: string;
  sessions: SessionSummary[];
};

const PROJECT_LIST_VISIBLE_CONTENT_POSITION = { minIndexForVisible: 0 };

export default function SessionsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <CenteredMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to see your sessions."
      />
    );
  }
  // `client` is narrowed to non-null by the guard above.
  return <SessionList client={client} />;
}

function isAuthRequiredError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('unauthorized') || normalized.includes('missing bearer');
}

function SessionList({ client }: { client: VerityClient }) {
  // A non-null `client` was built from a non-null base URL, so this is set too; the
  // right pane needs it for the live WS stream. Read at render, not a module const.
  const baseUrl = getVerityBaseUrl();
  // Register this device for push and route notification responses (fail-safe when
  // push is disabled server-side). Mounted here — the root authenticated screen —
  // so it lives for the whole session with a ready client + bearer.
  usePushNotifications(client, baseUrl);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  // A `selected` route param preselects a session into the right pane — this is how
  // a freshly-started session (new.tsx → /session/[id] → Redirect on wide) and any
  // deep link land in the unified split layout instead of the old per-route sidebar.
  const { selected, targetMessageId, targetSearchQuery } = useLocalSearchParams<{
    selected?: string;
    targetMessageId?: string;
    targetSearchQuery?: string;
  }>();
  const [selectedId, setSelectedId] = useState<string | null>(selected ?? null);
  const lastSelectedParamRef = useRef(selected);
  const incomingSelectedRef = useRef<string | null>(null);
  // A session started inline from the sidebar "+" (wide layout): we preselect it
  // into the right pane WITHOUT the full-screen /new → /session round-trip, and
  // WITHOUT waiting for the create — the id is minted here, so the pane can mount
  // the chat in the same frame and the session model holds its stream and first
  // turn until the server has the session (see `lib/pendingSessions`).
  // `justCreatedId` keeps the fresh session's selection alive until the 2s poll
  // lists it (mirroring the `selected` param exemption below).
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  // Track an incoming param change (e.g. arriving from a new session) without
  // clobbering a manual in-pane selection: only the param moving drives this.
  useEffect(() => {
    if (selected && selected !== lastSelectedParamRef.current) {
      lastSelectedParamRef.current = selected;
      incomingSelectedRef.current = selected;
      setSelectedId(selected);
    }
  }, [selected]);
  // Keep the single app-header search action aware of the session shown in the
  // wide right pane. The route param is also the deep-link contract used by search.
  useEffect(() => {
    if (incomingSelectedRef.current !== null) {
      if (selectedId === incomingSelectedRef.current) incomingSelectedRef.current = null;
      return;
    }
    if (wide && selectedId && selectedId !== selected) {
      router.setParams({
        selected: selectedId,
        targetMessageId: undefined,
        targetSearchQuery: undefined,
      });
    }
  }, [selected, selectedId, wide]);
  const { sessions, loading, error, refresh, rename, remove, providerLimitRows, serverAttention } =
    useSessionList(client);
  const authRequired = error !== undefined && isAuthRequiredError(error);
  const { unread, markSeen } = useUnread(client, sessions);
  useEffect(() => {
    if (authRequired && !loading) router.replace('/unlock-device');
  }, [authRequired, loading]);
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
    devServersByProject,
    detectionsByProject,
  } = useProjects(client);
  const {
    issues,
    loading: issuesLoading,
    error: issuesError,
    refresh: refreshIssues,
  } = useIssues(client);
  // Returning to the overview refetches the sessions too, not just the projects
  // (`useProjects` does its own). Deleting a project takes its sessions with it,
  // and the 2s poll would otherwise leave them on the list for a frame or two,
  // regrouped under "Inactive project" as if they had outlived it. Skips the
  // first focus — the list model already loads on mount — and stays silent so a
  // populated list never blinks back to its spinner.
  const sessionsLoadedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (sessionsLoadedOnce.current) void refresh({ silent: true });
      sessionsLoadedOnce.current = true;
    }, [refresh]),
  );
  const groups = useMemo(
    () => projectGroups(projects, sessions, devServersByProject, detectionsByProject, baseUrl),
    [baseUrl, detectionsByProject, devServersByProject, projects, sessions],
  );
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const orderedGroups = useMemo(() => applyProjectOrder(groups, dragOrder), [groups, dragOrder]);
  const activeGroups = useMemo(
    () => orderedGroups.filter((group) => !isPausedProjectGroup(group)),
    [orderedGroups],
  );
  const pausedGroups = useMemo(() => orderedGroups.filter(isPausedProjectGroup), [orderedGroups]);
  const defaultNewSessionProject = useMemo(
    () =>
      projects.find(isVerityControlPlaneProject) ??
      projects.find((project) => project.state === 'active'),
    [projects],
  );
  // Local optimistic overrides for the server-persisted per-project fold state
  // (`project.collapsed`), keyed by group id. An entry is cleared once the polled
  // project list confirms the same value, so a collapse/expand made on another
  // device (arriving via the next poll) then takes over. Non-project groups (the
  // default-repo row, orphan rows) have no server row, so their override simply
  // lives for the session — matching the previous device-local behavior.
  const [collapsedOverride, setCollapsedOverride] = useState<Map<string, boolean>>(() => new Map());
  // Once the polled project list reports the same value an optimistic override
  // holds, drop the override so the server (including changes made on another
  // device) is the source of truth again.
  useEffect(() => {
    setCollapsedOverride((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Map(current);
      for (const project of projects) {
        if (next.get(project.id) === (project.collapsed ?? false)) {
          next.delete(project.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [projects]);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const dragHeights = useRef(new Map<string, number>());
  const dragStartIndex = useRef<number | null>(null);
  const dragStartPageY = useRef<number | null>(null);
  const [refreshingOverview, setRefreshingOverview] = useState(false);
  const [updatingProjectIds, setUpdatingProjectIds] = useState<Set<string>>(() => new Set());
  const updatingProjectIdsRef = useRef(new Set<string>());
  const [repairingProjectIds, setRepairingProjectIds] = useState<Set<string>>(() => new Set());
  // State drives rendering; the ref is the synchronous mutex. Two native press
  // events can arrive before React commits the first state update.
  const repairingProjectIdsRef = useRef(new Set<string>());
  // The session whose actions sheet is open (its long-press opened the modal), or
  // null when the modal is closed.
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);

  // Drop a stale split-pane selection: if the chosen session disappears (deleted,
  // or it was never refreshed in), clear it so the right pane falls back to the
  // placeholder instead of showing a dead/unknown session. Exempt the session named
  // by the current `selected` param: a just-created one arrives before the polled
  // list includes it, and clearing here would strand it on the placeholder — the
  // pane's SessionChat loads it by id directly and surfaces its own dead-session
  // banner if it truly no longer exists.
  useEffect(() => {
    if (
      selectedId &&
      selectedId !== selected &&
      selectedId !== justCreatedId &&
      !sessions.some((s) => s.sessionId === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [sessions, selectedId, selected, justCreatedId]);

  // Once the polled list catches up with an inline-created session, drop its
  // exemption so it's treated like any other selected row from then on.
  useEffect(() => {
    if (justCreatedId && sessions.some((s) => s.sessionId === justCreatedId)) {
      setJustCreatedId(null);
    }
  }, [sessions, justCreatedId]);

  // Start a session inline for a project (wide layout): preselect it into the right
  // pane and let the create finish in the background — no full-screen /new takeover,
  // and no spinner while the worktree is provisioned. The pane's chat is live from
  // this frame; the session model holds its stream and any typed turn until the
  // session exists (see `lib/pendingSessions`), and reports it in place if the
  // create fails. Mirrors new.tsx, which does the same for the phone layout.
  const createSessionInPane = useCallback(
    (project: ProjectRecord) => {
      const sessionId = newSessionId();
      registerPendingSession(
        sessionId,
        (async () => {
          try {
            await createSessionConfirmingWarnings(client, {
              sessionId,
              projectId: project.id,
            });
          } catch (caught) {
            if (isServerSecretSealedError(caught)) {
              router.push({
                pathname: '/unlock-device',
                params: { returnTo: '/', serverSecret: '1' },
              });
            }
            throw caught;
          }
          // Only now does the sidebar have a row to list.
          void refresh();
        })(),
      );
      // Selecting BEFORE the create resolves is the whole point: the pane mounts the
      // chat for this id immediately. `justCreatedId` exempts it from the
      // stale-selection sweep until the poll catches up.
      setJustCreatedId(sessionId);
      setSelectedId(sessionId);
    },
    [client, refresh],
  );

  // Opening a session (either into the split pane or via navigation) marks it seen
  // at its current event count, clearing its unread dot.
  const onOpenSession = useCallback(
    (session: SessionSummary) => {
      prefetchBranches(client, session.sessionId);
      markSeen(session.sessionId, session.eventCount);
    },
    [client, markSeen],
  );

  const updateProjectSandbox = useCallback(
    async (project: ProjectRecord) => {
      // Guard per project, not globally: a recreation in flight for one project
      // must not swallow "Update" presses on other projects.
      if (updatingProjectIdsRef.current.has(project.id)) return;
      updatingProjectIdsRef.current.add(project.id);
      setUpdatingProjectIds((prev) => new Set(prev).add(project.id));
      try {
        await client.recreateProjectContainer(project.id, { confirmWarnings: true });
        await Promise.allSettled([refreshProjects(), refresh()]);
      } catch (caught) {
        if (!(caught instanceof VerityApiError))
          await Promise.allSettled([refreshProjects(), refresh()]);
        Alert.alert(
          'Update failed',
          caught instanceof VerityApiError
            ? caught.message
            : 'Could not update the project sandbox.',
        );
      } finally {
        updatingProjectIdsRef.current.delete(project.id);
        setUpdatingProjectIds((prev) => {
          const next = new Set(prev);
          next.delete(project.id);
          return next;
        });
      }
    },
    [client, refresh, refreshProjects],
  );

  // Repair straight from the overview row: a project whose container is gone is
  // visible here first, and making the operator walk into project detail to fix it
  // was the main reason a broken sandbox could sit unnoticed. Guarded per project
  // like the sandbox update above.
  const repairProjectRow = useCallback(
    async (projectId: string) => {
      if (repairingProjectIdsRef.current.has(projectId)) return;
      repairingProjectIdsRef.current.add(projectId);
      setRepairingProjectIds((prev) => new Set(prev).add(projectId));
      try {
        await repairProject({
          client,
          projectId,
          returnTo: '/',
          onUpdated: () => {
            void Promise.allSettled([refreshProjects(), refresh()]);
          },
          onError: (message) => Alert.alert('Repair failed', message),
        });
      } finally {
        repairingProjectIdsRef.current.delete(projectId);
        setRepairingProjectIds((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          return next;
        });
      }
    },
    [client, refresh, refreshProjects],
  );

  const confirmSandboxUpdate = useCallback(
    (project: ProjectRecord) => {
      const update = project.sandboxUpdate;
      if (!sandboxUpdateNeedsAttention(update)) return;
      Alert.alert('Retry sandbox update?', sandboxUpdateMessage(project, update), [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Update', onPress: () => void updateProjectSandbox(project) },
      ]);
    },
    [updateProjectSandbox],
  );

  const renderGroup = useCallback(
    (item: SessionProjectGroup) => {
      const reorderable =
        item.project !== undefined &&
        item.project.state !== 'absent' &&
        !isVerityControlPlaneProject(item.project);
      return (
        <ProjectGroup
          group={item}
          wide={wide}
          collapsed={
            draggingProjectId !== null ||
            (collapsedOverride.get(item.id) ?? item.project?.collapsed ?? false)
          }
          onToggle={() => {
            if (draggingProjectId !== null) return;
            const nextValue = !(collapsedOverride.get(item.id) ?? item.project?.collapsed ?? false);
            setCollapsedOverride((current) => {
              const next = new Map(current);
              next.set(item.id, nextValue);
              return next;
            });
            const project = item.project;
            if (!project) return;
            void client
              .setProjectCollapsed(project.id, nextValue)
              .then((updated) => {
                // Reconcile the override with what the server actually stored for
                // this write. Two rapid toggles whose PATCHes resolve out of order
                // would otherwise leave the override stuck at a value the server
                // never ended on (the clear-on-poll effect only drops an override
                // that already equals `project.collapsed`); pinning it to the
                // response makes the last-resolving write win and stay consistent
                // with every other device.
                const serverValue = updated.collapsed ?? false;
                setCollapsedOverride((current) => {
                  const next = new Map(current);
                  next.set(item.id, serverValue);
                  return next;
                });
                void refreshProjects();
              })
              .catch((caught) => {
                // Roll the override back to server truth so a failed write doesn't
                // strand the group in the wrong state.
                setCollapsedOverride((current) => {
                  const next = new Map(current);
                  next.delete(item.id);
                  return next;
                });
                Alert.alert(
                  'Update failed',
                  caught instanceof VerityApiError
                    ? caught.message
                    : 'Could not save the collapse state.',
                );
              });
          }}
          onLongPressProject={
            reorderable
              ? (pageY) => {
                  const projectIds = activeGroups.flatMap((group) =>
                    group.project && !isVerityControlPlaneProject(group.project)
                      ? [group.project.id]
                      : [],
                  );
                  dragOrderRef.current = projectIds;
                  dragStartIndex.current = projectIds.indexOf(item.project!.id);
                  dragStartPageY.current = pageY;
                  setDragOrder(projectIds);
                  setDraggingProjectId(item.project!.id);
                }
              : undefined
          }
          onProjectLayout={
            reorderable
              ? (height) => {
                  dragHeights.current.set(item.project!.id, height);
                }
              : undefined
          }
          onProjectDragMove={
            reorderable && item.project && draggingProjectId === item.project.id
              ? (_projectId, pageY) => {
                  const height = dragHeights.current.get(item.project!.id) ?? 56;
                  const startIndex = dragStartIndex.current;
                  const startPageY = dragStartPageY.current;
                  if (startIndex === null || startPageY === null) return;
                  const offsetRows = Math.round((pageY - startPageY) / height);
                  const next = moveProjectIdToIndex(
                    dragOrderRef.current,
                    item.project!.id,
                    startIndex + offsetRows,
                  );
                  if (next === dragOrderRef.current) return;
                  dragOrderRef.current = next;
                  setDragOrder(next);
                }
              : undefined
          }
          onProjectDragEnd={
            reorderable && item.project && draggingProjectId === item.project.id
              ? () => {
                  const ids =
                    dragOrderRef.current ??
                    activeGroups.flatMap((group) =>
                      group.project && !isVerityControlPlaneProject(group.project)
                        ? [group.project.id]
                        : [],
                    );
                  setDraggingProjectId(null);
                  setDragOrder(null);
                  dragOrderRef.current = null;
                  dragStartIndex.current = null;
                  dragStartPageY.current = null;
                  void client
                    .reorderProjects(ids)
                    .then(() => refreshProjects())
                    .catch((caught) => {
                      Alert.alert(
                        'Reorder failed',
                        caught instanceof VerityApiError
                          ? caught.message
                          : 'Could not save project order.',
                      );
                    });
                }
              : undefined
          }
          dragging={item.project?.id === draggingProjectId}
          reordering={draggingProjectId !== null}
          onRenameSession={setRenaming}
          onSelectSession={wide ? setSelectedId : undefined}
          onNewSession={wide ? createSessionInPane : undefined}
          onOpenSession={onOpenSession}
          onUpdateProject={confirmSandboxUpdate}
          onRepairProject={(projectId) => void repairProjectRow(projectId)}
          defaultNewSessionProject={defaultNewSessionProject}
          unread={unread}
          selectedId={wide ? selectedId : null}
          renamingId={renaming?.sessionId ?? null}
          updatingProjectIds={updatingProjectIds}
          repairingProjectIds={repairingProjectIds}
        />
      );
    },
    [
      activeGroups,
      collapsedOverride,
      client,
      draggingProjectId,
      wide,
      selectedId,
      unread,
      onOpenSession,
      createSessionInPane,
      renaming,
      confirmSandboxUpdate,
      updatingProjectIds,
      repairProjectRow,
      repairingProjectIds,
      defaultNewSessionProject,
      refreshProjects,
    ],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SessionProjectGroup>) => renderGroup(item),
    [renderGroup],
  );

  // Wide layout: the session shown in the split pane is "open", so keep it marked
  // seen as new events stream in (markSeen no-ops when the count hasn't moved).
  useEffect(() => {
    if (!selectedId) return;
    const open = sessions.find((s) => s.sessionId === selectedId);
    if (open) markSeen(open.sessionId, open.eventCount);
  }, [selectedId, sessions, markSeen]);

  const onSubmitRename = useCallback(
    (name: string | null) => {
      if (renaming) rename(renaming.sessionId, name);
      setRenaming(null);
    },
    [renaming, rename],
  );

  const onRefreshOverview = useCallback(async () => {
    setRefreshingOverview(true);
    try {
      await Promise.allSettled([refresh(), refreshProjects(), refreshIssues()]);
    } finally {
      setRefreshingOverview(false);
    }
  }, [refresh, refreshIssues, refreshProjects]);

  // Delete is destructive + irreversible (drops history, removes the worktree),
  // so confirm with a native alert before firing. The optimistic removal + any
  // server error (e.g. 409 busy) are handled by the model and surface in the
  // stale banner.
  const onDeleteRenaming = useCallback(() => {
    if (!renaming) return;
    void confirmDeleteSession(renaming, client, remove, refresh, () => setRenaming(null));
  }, [client, refresh, renaming, remove]);

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (error && sessions.length === 0) {
    return <CenteredMessage title="Couldn't load sessions" subtitle={error} onRetry={refresh} />;
  }

  // The list is shown as project groups. A poll error with known data is non-fatal
  // (keep the last list) but not silent. Issues live in the footer so they stay below
  // the project/session overview.
  const master = (
    <View style={styles.flex}>
      {/* Above the stale banner on purpose: a poll that failed is a symptom, and
          this is the Server telling us the cause. */}
      {serverAttention ? <ServerAttentionBanner notice={serverAttention} /> : null}
      {error && sessions.length > 0 ? <StaleBanner message={error} onRetry={refresh} /> : null}
      {projectsError ? (
        <StaleBanner message={`Projects: ${projectsError}`} onRetry={refreshProjects} />
      ) : null}
      <FlatList
        data={activeGroups}
        keyExtractor={(g) => g.id}
        renderItem={renderItem}
        // Dev-server polling can add a port chip after the process starts, which
        // changes a project row's height. Keep the first visible project anchored
        // across that relayout instead of letting the virtualized list jump upward.
        maintainVisibleContentPosition={PROJECT_LIST_VISIBLE_CONTENT_POSITION}
        refreshControl={
          <RefreshControl refreshing={refreshingOverview} onRefresh={onRefreshOverview} />
        }
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
        ItemSeparatorComponent={GroupSeparator}
        ListHeaderComponent={
          providerLimitRows.length > 0 ? <ProviderLimitMeters rows={providerLimitRows} /> : null
        }
        ListEmptyComponent={
          pausedGroups.length === 0 ? (
            <View style={styles.emptyOverview}>
              {projectsLoading ? <ActivityIndicator /> : null}
              <Text style={styles.emptyTitle}>
                {projectsLoading ? 'Loading projects' : 'No projects yet'}
              </Text>
              <Text style={styles.emptySubtitle}>
                Tap + to add a repository and see its sessions here.
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          <>
            {pausedGroups.length > 0 ? (
              <View style={styles.pausedSection}>
                <View style={styles.issuesHeaderRow}>
                  <Text style={styles.issuesHeader}>Paused</Text>
                  <Text style={styles.pausedCount}>{pausedGroups.length}</Text>
                </View>
                <View style={styles.pausedList}>
                  {pausedGroups.map((group) => (
                    <Fragment key={group.id}>{renderGroup(group)}</Fragment>
                  ))}
                </View>
              </View>
            ) : null}
            <IssuesSection
              issues={issues}
              loading={issuesLoading}
              error={issuesError}
              refresh={refreshIssues}
            />
          </>
        }
      />
      <RenameModal
        session={renaming}
        onSubmit={onSubmitRename}
        onDelete={onDeleteRenaming}
        onCancel={() => setRenaming(null)}
      />
    </View>
  );

  if (!wide) return master;

  return (
    <View style={styles.splitRow}>
      <View style={styles.leftPane}>{master}</View>
      <View style={styles.rightPane}>
        {selectedId && baseUrl ? (
          <SessionChat
            key={selectedId}
            client={client}
            sessionId={selectedId}
            baseUrl={baseUrl}
            embedded
            initialTargetMessageId={targetMessageId}
            initialTargetSearchQuery={targetSearchQuery}
          />
        ) : (
          <RightPanePlaceholder />
        )}
      </View>
    </View>
  );
}

function RightPanePlaceholder() {
  const { theme } = useUnistyles();
  return (
    <View style={styles.rightPanePlaceholder}>
      <Icon name="message-square" size={28} color={theme.colors.textFaint} />
      <Text style={styles.rightPanePlaceholderText}>Select a session</Text>
    </View>
  );
}

// How often the overview silently re-fetches projects so the container-lifecycle
// state and the GitHub release version stay current without a pull-to-refresh.
// Coarser than the 2s session poll — project/release data changes slowly and the
// server throttles the underlying GitHub calls (installation list ~60s, latest
// release ~5min), so a tighter interval would only add no-op round-trips.
const PROJECTS_POLL_MS = 15_000;
const PROJECT_SETUP_POLL_MS = 2_000;

function useProjects(client: VerityClient) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [devServersByProject, setDevServersByProject] = useState<Map<string, DevServer[]>>(
    () => new Map(),
  );
  const devServersByProjectRef = useRef<Map<string, DevServer[]>>(new Map());
  const pendingDevServerMutations = useRef(
    new Map<string, Map<string, { mutation: DevServerStatusMutation; generation: number }>>(),
  );
  const [detectionsByProject, setDetectionsByProject] = useState<Map<string, DevServerDetection>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadGeneration = useRef(0);
  const pendingProjectMutations = useRef(
    new Map<string, { project: ProjectRecord; generation: number }>(),
  );
  const detectionAttemptedProjectIds = useRef(new Set<string>());
  devServersByProjectRef.current = devServersByProject;

  useEffect(
    () =>
      subscribeProjectStatusMutations((updated) => {
        pendingProjectMutations.current.set(updated.id, {
          project: updated,
          generation: loadGeneration.current,
        });
        setProjects((current) => {
          const found = current.some((project) => project.id === updated.id);
          return found
            ? current.map((project) => (project.id === updated.id ? updated : project))
            : [...current, updated];
        });
      }),
    [],
  );

  useEffect(
    () =>
      subscribeDevServerStatusMutations((mutation) => {
        const projectPending =
          pendingDevServerMutations.current.get(mutation.projectId) ??
          new Map<string, { mutation: DevServerStatusMutation; generation: number }>();
        projectPending.set(mutation.id, { mutation, generation: loadGeneration.current });
        pendingDevServerMutations.current.set(mutation.projectId, projectPending);
        const known = devServersByProjectRef.current.get(mutation.projectId);
        if (known === undefined) return;
        setDevServersByProject((current) => {
          const servers = current.get(mutation.projectId);
          if (!servers) return current;
          const found = servers.some((server) => server.id === mutation.id);
          const next = new Map(current);
          next.set(
            mutation.projectId,
            found
              ? servers.map((server) =>
                  server.id === mutation.id
                    ? (mutation.devServer ?? {
                        ...server,
                        ...(mutation.running === undefined ? {} : { running: mutation.running }),
                        ...(mutation.previewSessionId === undefined
                          ? {}
                          : { previewSessionId: mutation.previewSessionId }),
                      })
                    : server,
                )
              : mutation.devServer
                ? [...servers, mutation.devServer]
                : servers,
          );
          return next;
        });
      }),
    [],
  );

  // `silent` skips the loading-spinner flip so the interval poll refreshes in
  // place (no flicker); the initial load + pull-to-refresh flip it as before.
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const generation = ++loadGeneration.current;
      if (!opts?.silent) setLoading(true);
      try {
        const nextProjects = await client.listProjects();
        const devServerResults = await Promise.allSettled(
          nextProjects
            .filter((project) => project.state === 'active')
            .map(async (project) => [project.id, await client.listDevServers(project.id)] as const),
        );
        const projectsToAnalyze = nextProjects.filter(
          ({ id, state, setupStatus }) =>
            state === 'active' &&
            (setupStatus === 'pending' || !detectionAttemptedProjectIds.current.has(id)),
        );
        for (const { id } of projectsToAnalyze) detectionAttemptedProjectIds.current.add(id);
        const detectionResults = await Promise.allSettled(
          projectsToAnalyze.map(async (project) => {
            try {
              return [project.id, await client.getDevServerDetection(project.id)] as const;
            } catch (error) {
              detectionAttemptedProjectIds.current.delete(project.id);
              throw error;
            }
          }),
        );
        if (generation !== loadGeneration.current) return;
        const pending = new Map(
          [...pendingProjectMutations.current].filter(
            ([, entry]) => entry.generation >= generation,
          ),
        );
        const seen = new Set(nextProjects.map((project) => project.id));
        setProjects([
          ...nextProjects.map((project) => pending.get(project.id)?.project ?? project),
          ...[...pending.values()]
            .map(({ project }) => project)
            .filter((project) => !seen.has(project.id)),
        ]);
        pendingProjectMutations.current.clear();
        setDevServersByProject((current) => {
          const projectIds = new Set(nextProjects.map(({ id }) => id));
          const next = new Map([...current].filter(([projectId]) => projectIds.has(projectId)));
          for (const result of devServerResults) {
            if (result.status === 'fulfilled') {
              const [projectId, servers] = result.value;
              const pendingEntries = pendingDevServerMutations.current.get(projectId);
              const pending = new Map(
                [...(pendingEntries ?? [])]
                  .filter(([, entry]) => entry.generation >= generation)
                  .map(([id, entry]) => [id, entry.mutation]),
              );
              if (pending.size === 0) {
                next.set(projectId, servers);
                pendingDevServerMutations.current.delete(projectId);
                continue;
              }
              const seen = new Set(servers.map((server) => server.id));
              next.set(projectId, [
                ...servers.map((server) => {
                  const mutation = pending.get(server.id);
                  return (
                    mutation?.devServer ??
                    (mutation
                      ? {
                          ...server,
                          ...(mutation.running === undefined ? {} : { running: mutation.running }),
                          ...(mutation.previewSessionId === undefined
                            ? {}
                            : { previewSessionId: mutation.previewSessionId }),
                        }
                      : server)
                  );
                }),
                ...[...pending.values()].flatMap((mutation) =>
                  !seen.has(mutation.id) && mutation.devServer ? [mutation.devServer] : [],
                ),
              ]);
              pendingDevServerMutations.current.delete(projectId);
            }
          }
          // Mutation callbacks run between renders and consult the ref. Keep it
          // in lockstep with the committed cache instead of waiting for the next
          // render, which could otherwise merge a fresh event into stale data.
          devServersByProjectRef.current = next;
          return next;
        });
        setDetectionsByProject((current) => {
          const projectIds = new Set(nextProjects.map(({ id }) => id));
          const next = new Map([...current].filter(([projectId]) => projectIds.has(projectId)));
          for (const result of detectionResults) {
            if (result.status === 'fulfilled') next.set(...result.value);
          }
          return next;
        });
        setError(undefined); // recovered — clear any stale banner
      } catch (caught) {
        if (generation !== loadGeneration.current) return;
        // A silent background poll keeps the last-good list on screen without
        // flashing an error banner over it; only the initial load and
        // pull-to-refresh surface a failure to the operator.
        if (!opts?.silent) {
          setError(caught instanceof VerityApiError ? caught.message : 'Could not load projects');
        }
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [client],
  );

  // Load on focus — the first mount AND every return to the overview. The poll
  // below is too coarse to carry a change the operator just made elsewhere: a
  // project deleted on its detail screen pops back here, and waiting out the
  // interval would leave the deleted card on the list, tappable. Every refetch
  // after the first is silent, so coming back never flashes the list into its
  // loading state.
  const loadedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(loadedOnce.current ? { silent: true } : undefined);
      loadedOnce.current = true;
    }, [load]),
  );

  const setupRunning = hasPendingProjectSetup(projects);
  useEffect(() => {
    const timer = setInterval(
      () => void load({ silent: true }),
      setupRunning ? PROJECT_SETUP_POLL_MS : PROJECTS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [load, setupRunning]);

  return {
    projects,
    devServersByProject,
    detectionsByProject,
    loading,
    error,
    refresh: () => load(),
  };
}

function projectGroups(
  projects: ProjectRecord[],
  sessions: SessionSummary[],
  devServersByProject: Map<string, DevServer[]>,
  detectionsByProject: Map<string, DevServerDetection>,
  baseUrl: string | null,
): SessionProjectGroup[] {
  const byProject = new Map<string | null, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.projectId ?? null;
    const bucket = byProject.get(key) ?? [];
    bucket.push(session);
    byProject.set(key, bucket);
  }

  const groups: SessionProjectGroup[] = projects.map((project) => {
    const detection = detectionsByProject.get(project.id);
    const setupLabel = projectOverviewSetupLabel(project, detection);
    const portLinks = (devServersByProject.get(project.id) ?? []).flatMap((server) => {
      const url = baseUrl ? devServerUrl(baseUrl, server) : null;
      return server.running && server.hostPort && url
        ? [{ id: server.id, label: server.hostPort, url }]
        : [];
    });
    return {
      id: project.id,
      title: projectTitle(project),
      subtitle: project.latestReleaseTag ?? '',
      setupLabel,
      warningLabel: projectOverviewWarning(project),
      portLinks,
      project,
      sessions: byProject.get(project.id) ?? [],
    };
  });
  const defaultSessions = byProject.get(null) ?? [];
  if (defaultSessions.length > 0 || groups.length === 0) {
    groups.unshift({
      id: 'default',
      title: 'Default repository',
      subtitle: 'Verity server workspace',
      portLinks: [],
      sessions: defaultSessions,
    });
  }

  const knownProjects = new Set(projects.map((p) => p.id));
  for (const [projectId, projectSessions] of byProject) {
    if (projectId === null || knownProjects.has(projectId)) continue;
    groups.push({
      id: `orphan:${projectId}`,
      title: 'Inactive project',
      subtitle: 'Project unavailable',
      portLinks: [],
      inactiveProjectId: projectId,
      sessions: projectSessions,
    });
  }
  return groups;
}

function applyProjectOrder(
  groups: SessionProjectGroup[],
  orderedProjectIds: string[] | null,
): SessionProjectGroup[] {
  if (!orderedProjectIds) return groups;
  const rank = new Map(orderedProjectIds.map((id, index) => [id, index]));
  const sortable = groups
    .filter((group) => group.project)
    .sort((a, b) => {
      const aRank = rank.get(a.project!.id) ?? Number.MAX_SAFE_INTEGER;
      const bRank = rank.get(b.project!.id) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank;
    });
  let sortableIndex = 0;
  return groups.map((group) => (group.project ? sortable[sortableIndex++]! : group));
}

function moveProjectIdToIndex(
  ids: string[] | null,
  projectId: string,
  requestedIndex: number,
): string[] | null {
  if (!ids) return ids;
  const from = ids.indexOf(projectId);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, requestedIndex));
  if (from === to) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

function isPausedProjectGroup(group: SessionProjectGroup): boolean {
  return group.project?.state === 'absent' && group.project.setupStatus !== 'pending';
}

function ProjectGroup({
  group,
  wide,
  collapsed,
  onToggle,
  onLongPressProject,
  onProjectLayout,
  onProjectDragMove,
  onProjectDragEnd,
  dragging,
  reordering,
  onRenameSession,
  onSelectSession,
  onNewSession,
  onOpenSession,
  onUpdateProject,
  onRepairProject,
  defaultNewSessionProject,
  unread,
  selectedId,
  renamingId,
  updatingProjectIds,
  repairingProjectIds,
}: {
  group: SessionProjectGroup;
  wide: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onLongPressProject?: ((pageY: number) => void) | undefined;
  onProjectLayout?: ((height: number) => void) | undefined;
  onProjectDragMove?: ((projectId: string, pageY: number) => void) | undefined;
  onProjectDragEnd?: (() => void) | undefined;
  dragging?: boolean | undefined;
  reordering?: boolean | undefined;
  onRenameSession: (session: SessionSummary) => void;
  onSelectSession?: (id: string) => void;
  // Wide layout only: create a session inline for this project (no /new route).
  // Undefined on narrow, where the "+" falls back to navigating to /new.
  onNewSession?: (project: ProjectRecord) => void;
  onOpenSession: (session: SessionSummary) => void;
  onUpdateProject: (project: ProjectRecord) => void;
  onRepairProject?: ((projectId: string) => void) | undefined;
  defaultNewSessionProject?: ProjectRecord | undefined;
  unread: ReadonlySet<string>;
  selectedId?: string | null;
  renamingId?: string | null;
  updatingProjectIds?: ReadonlySet<string>;
  repairingProjectIds?: ReadonlySet<string>;
}) {
  const { theme } = useUnistyles();
  const [headerHovered, setHeaderHovered] = useState(false);
  // Container state for the leading dot. A group with no project row is either an
  // orphan (including soft-deleted projects, which are not repairable) or the
  // untracked default workspace, which has no container lifecycle at all.
  const badge: ProjectBadge = group.project
    ? projectBadge(group.project)
    : group.inactiveProjectId
      ? UNAVAILABLE_PROJECT_BADGE
      : UNTRACKED_PROJECT_BADGE;
  const repairProjectId = badge.needsRepair
    ? (group.project?.id ?? group.inactiveProjectId)
    : undefined;
  const repairing =
    repairProjectId !== undefined && repairingProjectIds?.has(repairProjectId) === true;
  const controlPlane = group.project ? isVerityControlPlaneProject(group.project) : false;
  const sessionCount = group.sessions.length;
  // Undefined unless there is something to report, so the button below is gated on
  // the glyph itself rather than on a separate boolean that has to be kept in
  // agreement with it — and the tone is resolved into the same object, so the JSX
  // has no second `string | undefined` to narrow.
  const indicator = controlPlane ? undefined : sandboxUpdateIndicator(group.project?.sandboxUpdate);
  const updateGlyph = indicator
    ? { ...indicator, color: theme.colors.tone[indicator.tone] }
    : undefined;
  const updating =
    group.project !== undefined && updatingProjectIds?.has(group.project.id) === true;
  const sandboxUpdatePending =
    group.project?.sandboxUpdate?.state === 'available' &&
    group.project.sandboxUpdate.selfRepair === 'converging';
  const onTouchMove = (event: GestureResponderEvent) => {
    if (!group.project || !onProjectDragMove) return;
    onProjectDragMove(group.project.id, event.nativeEvent.pageY);
  };
  const onLayout = (event: LayoutChangeEvent) => {
    onProjectLayout?.(event.nativeEvent.layout.height);
  };
  return (
    <View
      style={[
        styles.projectGroup,
        !wide && styles.projectGroupFlat,
        dragging ? styles.projectGroupDragging : null,
      ]}
      onLayout={onLayout}
      onTouchMove={dragging ? onTouchMove : undefined}
      onTouchEnd={dragging ? onProjectDragEnd : undefined}
      onTouchCancel={dragging ? onProjectDragEnd : undefined}
    >
      <View
        style={[
          styles.projectHeader,
          headerHovered ? styles.projectHeaderHovered : null,
          !collapsed && sessionCount > 0 ? styles.projectHeaderOpen : null,
        ]}
      >
        <Pressable
          style={({ pressed }) => [styles.projectToggle, pressed ? styles.rowPressed : null]}
          onHoverIn={() => setHeaderHovered(true)}
          onHoverOut={() => setHeaderHovered(false)}
          onPress={reordering ? undefined : onToggle}
          onLongPress={(event) => onLongPressProject?.(event.nativeEvent.pageY)}
          delayLongPress={260}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={
            reordering
              ? `Move ${group.title}`
              : `${collapsed ? 'Expand' : 'Collapse'} ${group.title}`
          }
        >
          {/* Shared grid: [chevron col] [dot col] [title block]. Sessions reuse the
              same two leading columns (chevron empty) so dots + titles line up. */}
          <View style={styles.colChevron}>
            <Icon
              name={collapsed ? 'chevron-right' : 'chevron-down'}
              size={18}
              color={theme.colors.textMuted}
            />
          </View>
          <View style={styles.colDot}>
            <ProjectStatusDot badge={badge} />
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.projectTitle} numberOfLines={1}>
              {group.title}
            </Text>
            {group.portLinks.length > 0 ||
            group.setupLabel ||
            group.warningLabel ||
            group.subtitle ||
            sandboxUpdatePending ? (
              <View style={styles.projectMetaRow}>
                {group.portLinks.map((port) => (
                  <ProjectPortChip key={port.id} port={port} />
                ))}
                {group.setupLabel ? (
                  group.project?.setupStatus === 'pending' ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Continue setup for ${group.title}`}
                      onPress={() =>
                        router.push({
                          pathname: '/new-project',
                          params: { projectId: group.project!.id },
                        })
                      }
                    >
                      <Text style={styles.projectSetupLabel} numberOfLines={1}>
                        {group.setupLabel}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text
                      style={[
                        styles.projectSetupLabel,
                        badge.needsRepair ? styles.projectSetupLabelBroken : null,
                      ]}
                      numberOfLines={1}
                    >
                      {group.setupLabel}
                    </Text>
                  )
                ) : group.subtitle ? (
                  <Text
                    style={[
                      styles.projectSubtitle,
                      badge.needsRepair ? styles.projectSetupLabelBroken : null,
                    ]}
                    numberOfLines={1}
                  >
                    {group.subtitle}
                  </Text>
                ) : null}
                {/* Sits alongside the setup label rather than replacing it: a
                    project can be mid-setup AND carry a provision warning, and
                    dropping either one loses information the other doesn't
                    carry. */}
                {group.warningLabel ? (
                  <Text style={styles.projectWarningLabel} numberOfLines={1}>
                    {group.warningLabel}
                  </Text>
                ) : null}
                {sandboxUpdatePending ? (
                  <View style={styles.projectUpdatePending} accessibilityRole="progressbar">
                    <ActivityIndicator size="small" color={theme.colors.textMuted} />
                    <Text style={styles.projectSubtitle} numberOfLines={1}>
                      Waiting to update sandbox…
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </Pressable>
        <View style={[styles.projectActions, reordering ? styles.projectActionsHidden : null]}>
          {/* Repair is only offered for a live project row whose reconciled state is
              failed. Missing rows may be soft-deleted and cannot use this endpoint. */}
          {repairProjectId && onRepairProject ? (
            <Pressable
              style={[
                styles.projectIconButton,
                styles.projectRepairButton,
                repairing ? styles.projectActionDisabled : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Repair ${group.title}`}
              onPress={() => onRepairProject(repairProjectId)}
              disabled={repairing}
            >
              {repairing ? (
                <ActivityIndicator size="small" color={theme.colors.tone.danger} />
              ) : (
                <Icon name="tool" size={16} color={theme.colors.tone.danger} />
              )}
            </Pressable>
          ) : null}
          {group.project ? (
            <>
              {updateGlyph ? (
                <Pressable
                  style={[
                    styles.projectIconButton,
                    styles.projectUpdateButton,
                    {
                      borderColor: `${updateGlyph.color}99`,
                      backgroundColor: `${updateGlyph.color}1f`,
                    },
                    updating ? styles.projectActionDisabled : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`${updateGlyph.label} for ${group.title}`}
                  onPress={() => onUpdateProject(group.project!)}
                  disabled={updating}
                >
                  {updating ? (
                    <ActivityIndicator size="small" color={updateGlyph.color} />
                  ) : (
                    <Icon name={updateGlyph.icon} size={18} color={updateGlyph.color} />
                  )}
                </Pressable>
              ) : null}
              {!controlPlane && projectRepoRef(group.project) !== undefined ? (
                <Pressable
                  style={styles.projectIconButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${group.title} on GitHub`}
                  onPress={() =>
                    void Linking.openURL(
                      `https://github.com/${projectRepoRef(group.project!)!}`,
                    ).catch(() => undefined)
                  }
                >
                  <Icon name="github" size={18} color={theme.colors.textMuted} />
                </Pressable>
              ) : null}
              {onNewSession ? (
                <Pressable
                  style={styles.projectIconButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Start new session in ${group.title}`}
                  onPress={() => onNewSession(group.project!)}
                >
                  <Icon name="plus" size={20} color={theme.colors.primary} />
                </Pressable>
              ) : (
                <Link
                  href={{
                    pathname: '/new',
                    params: { projectId: group.project.id },
                  }}
                  accessibilityLabel={`Start new session in ${group.title}`}
                  asChild
                >
                  <Pressable style={styles.projectIconButton} accessibilityRole="button">
                    <Icon name="plus" size={20} color={theme.colors.primary} />
                  </Pressable>
                </Link>
              )}
              {!controlPlane ? (
                <Link
                  href={{ pathname: '/project/[id]', params: { id: group.project.id } }}
                  accessibilityLabel={`Open project settings for ${group.title}`}
                  asChild
                >
                  <Pressable style={styles.projectOpenButton} accessibilityRole="button">
                    <Icon name="more-horizontal" size={20} color={theme.colors.textMuted} />
                  </Pressable>
                </Link>
              ) : null}
            </>
          ) : group.inactiveProjectId ? null : defaultNewSessionProject ? (
            onNewSession ? (
              <Pressable
                style={styles.projectIconButton}
                accessibilityRole="button"
                accessibilityLabel={`Start new session in ${defaultNewSessionProject.repo}`}
                onPress={() => onNewSession(defaultNewSessionProject)}
              >
                <Icon name="plus" size={20} color={theme.colors.primary} />
              </Pressable>
            ) : (
              <Link
                href={{
                  pathname: '/new',
                  params: {
                    projectId: defaultNewSessionProject.id,
                  },
                }}
                accessibilityLabel={`Start new session in ${defaultNewSessionProject.repo}`}
                asChild
              >
                <Pressable style={styles.projectIconButton} accessibilityRole="button">
                  <Icon name="plus" size={20} color={theme.colors.primary} />
                </Pressable>
              </Link>
            )
          ) : null}
        </View>
      </View>
      {!reordering && !collapsed && group.sessions.length > 0 ? (
        <View style={styles.projectSessions}>
          {group.sessions.map((session, index) => (
            <Fragment key={session.sessionId}>
              {/* Quiet inset hairline between sessions (never above the first — the
                  project header already draws its own bottom border). Inset to start
                  under the session title, leaving the dot gutter clear (iOS-style
                  leading inset), so adjacent session blocks read as separate without
                  the restless full-width line grid the group had before. */}
              {index > 0 ? <View style={styles.sessionDivider} /> : null}
              <SessionRow
                session={session}
                onRename={() => onRenameSession(session)}
                onSelect={onSelectSession ? () => onSelectSession(session.sessionId) : undefined}
                onOpen={() => onOpenSession(session)}
                unread={unread.has(session.sessionId)}
                selected={selectedId === session.sessionId}
                renaming={renamingId === session.sessionId}
              />
            </Fragment>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// Delete is destructive + irreversible (drops history, removes the worktree), so
// confirm with a native alert before firing. Called from the rename modal (opened
// by a row long-press); `onConfirmed` lets the modal close itself after the delete.
async function confirmDeleteSession(
  session: SessionSummary,
  client: VerityClient,
  remove: (sessionId: string, opts?: { force?: boolean }) => Promise<void>,
  refresh: () => Promise<void>,
  onConfirmed?: () => void,
): Promise<void> {
  const deleteSession = (force = false) => {
    void remove(session.sessionId, { force }).catch((error: unknown) => {
      if (error instanceof VerityApiError && error.status === 409 && !force) {
        Alert.alert(
          'Session is still running',
          `Verity could not stop "${sessionLabel(session)}" automatically. Delete it anyway? This permanently removes its history and worktree.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete anyway',
              style: 'destructive',
              onPress: () => deleteSession(true),
            },
          ],
        );
        return;
      }
      Alert.alert(
        'Could not delete session',
        error instanceof Error ? error.message : 'Please try again.',
      );
    });
    onConfirmed?.();
  };

  if (session.kind === 'agent_loop' && session.projectId) {
    try {
      const loops = await client.listAgentLoops(session.projectId);
      const loop = loops.find((candidate) => candidate.sessionId === session.sessionId);
      if (loop) {
        Alert.alert(
          'Delete Agent Loop session?',
          `Choose whether to remove only the chat for "${sessionLabel(session)}" or the Agent Loop and its schedule too.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Session only',
              onPress: () => {
                deleteSession();
              },
            },
            {
              text: 'Session + loop',
              style: 'destructive',
              onPress: () => {
                void client
                  .deleteAgentLoop(loop.id, { deleteSession: true })
                  .then(refresh)
                  .catch((error: unknown) =>
                    Alert.alert(
                      'Could not delete Agent Loop',
                      error instanceof Error ? error.message : 'Please try again.',
                    ),
                  );
                onConfirmed?.();
              },
            },
          ],
        );
        return;
      }
    } catch (error) {
      Alert.alert(
        'Could not load Agent Loop',
        error instanceof Error ? error.message : 'Please try again.',
      );
      return;
    }
  }
  Alert.alert(
    'Delete session?',
    `This permanently removes "${sessionLabel(session)}" — its history and worktree. This can't be undone.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteSession();
        },
      },
    ],
  );
}

function sandboxUpdateMessage(project: ProjectRecord, update: SandboxUpdate): string {
  const security = isSecuritySandboxUpdate(update);
  return (
    `Verity could not update ${project.owner}/${project.repo}'s sandbox on its own — ` +
    `it is still running the old image${security ? ', which is missing a security fix' : ''}. ` +
    'This will recreate its container and retry.'
  );
}

function isVerityControlPlaneProject(project: ProjectRecord): boolean {
  return project.kind === 'control_plane';
}

function projectTitle(project: ProjectRecord): string {
  return isVerityControlPlaneProject(project) ? 'Verity Control' : project.repo;
}

// The open-issues backlog (#137) shown beneath the sessions: tap an issue to read
// it and spawn a session from it. Hidden entirely when there's nothing to show and
// nothing in flight — e.g. GitHub isn't configured server-side (the server 503s, the
// client maps that to an empty list), so the overview stays clean.
function IssuesSection({
  issues,
  loading,
  error,
  refresh,
}: {
  issues: IssueSummary[];
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}) {
  if (!loading && !error && issues.length === 0) return null;
  return (
    <View style={styles.issuesSection}>
      <View style={styles.issuesHeaderRow}>
        <Text style={styles.issuesHeader}>Issues</Text>
        {loading ? <ActivityIndicator size="small" /> : null}
      </View>
      {error ? (
        <Pressable
          onPress={refresh}
          accessibilityRole="button"
          accessibilityLabel="Retry loading issues"
        >
          <Text style={styles.issuesError}>Couldn&apos;t load issues — {error}. Tap to retry.</Text>
        </Pressable>
      ) : null}
      {issues.map((issue) => (
        <IssueRow key={issue.number} issue={issue} />
      ))}
    </View>
  );
}

// One issue row: its number + title; tap to open the detail screen (the issue's
// fields ride along as route params so the detail renders without a second fetch).
function IssueRow({ issue }: { issue: IssueSummary }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.issueRow,
        hovered ? styles.rowHovered : null,
        pressed ? styles.rowPressed : null,
      ]}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() =>
        router.push({
          pathname: '/issue/[number]',
          params: {
            number: String(issue.number),
            title: issue.title,
            body: issue.body,
            url: issue.url,
            ...(issue.projectId ? { projectId: issue.projectId } : {}),
          },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`Open issue ${String(issue.number)}: ${issue.title}`}
    >
      <Text style={styles.issueRowNumber}>#{issue.number}</Text>
      <Text style={styles.issueRowTitle} numberOfLines={2}>
        {issue.title}
      </Text>
    </Pressable>
  );
}

// A long-press on a row opens this modal: rename the session (set/clear its
// display name — an empty submission clears it back to the worktree/id) or
// delete it outright. Seeded with the current name each time it opens.
function RenameModal({
  session,
  onSubmit,
  onDelete,
  onCancel,
}: {
  session: SessionSummary | null;
  onSubmit: (name: string | null) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');

  // Re-seed the field each time a different session opens the modal.
  useEffect(() => {
    setDraft(session?.name ?? '');
  }, [session]);

  const visible = session !== null;
  const submit = useCallback(() => {
    const trimmed = draft.trim();
    onSubmit(trimmed.length > 0 ? trimmed : null);
    Keyboard.dismiss();
  }, [draft, onSubmit]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      {/* Anchor the card near the top (not screen-centred) so the keyboard never
          overlaps it — this avoids a KeyboardAvoidingView, whose padding animated
          the card downward as the keyboard retracted on dismiss (a visible drift). */}
      <Pressable
        style={[styles.modalBackdrop, { paddingTop: insets.top + theme.spacing.xxl * 2 }]}
        onPress={onCancel}
        accessibilityRole="button"
      >
        {/* Stop taps inside the card from dismissing the modal. */}
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Rename session</Text>
            {session ? (
              <Text style={styles.modalSubtitle} numberOfLines={1}>
                {sessionLabel(session)}
              </Text>
            ) : null}
          </View>
          <TextInput
            style={styles.modalInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Session name"
            placeholderTextColor={theme.colors.textFaint}
            maxLength={80}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submit}
            accessibilityLabel="Session name"
          />
          <View style={styles.modalActions}>
            <Pressable
              style={({ pressed }) => [
                styles.modalDeleteButton,
                pressed ? styles.rowPressed : null,
              ]}
              onPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel="Delete session"
            >
              <Text style={styles.modalDeleteText}>Delete</Text>
            </Pressable>
            <View style={styles.modalActionsRight}>
              <Pressable
                style={({ pressed }) => [
                  styles.modalCancelButton,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={onCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel rename"
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.modalSaveButton,
                  pressed ? styles.rowPressed : null,
                ]}
                onPress={submit}
                accessibilityRole="button"
                accessibilityLabel="Save session name"
              >
                <Text style={styles.modalSaveText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const WIDE_PROVIDER_LIMIT_MIN_WIDTH = 700;

function ProviderLimitMeters({ rows }: { rows: ProviderLimitRow[] }) {
  return (
    <View style={[styles.limitMeters, styles.limitMetersHeader]}>
      {rows.map((row) => (
        <View key={row.providerLabel} style={styles.limitMeterRow}>
          <Text style={styles.limitProvider} numberOfLines={1}>
            {row.providerLabel}
          </Text>
          <ProviderLimitSegment label="5h" window="five_hour" limit={row.fiveHour} />
          <ProviderLimitSegment label="Week" window="weekly" limit={row.weekly} />
        </View>
      ))}
    </View>
  );
}

function ProviderLimitSegment({
  label,
  window,
  limit,
}: {
  label: string;
  window: 'five_hour' | 'weekly';
  limit: ProviderLimitState | null;
}) {
  const { theme } = useUnistyles();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const usesWideSpacing = screenWidth >= WIDE_PROVIDER_LIMIT_MIN_WIDTH;
  const chartRef = useRef<View>(null);
  const [showPaceInfo, setShowPaceInfo] = useState(false);
  const [paceInfoAnchor, setPaceInfoAnchor] = useState<{
    top: number;
    left: number;
    width: number;
    arrowLeft: number;
  } | null>(null);
  // Exhausted, not merely warned about: providers flag `allowed_warning` from
  // around half a window, and painting the bar in the reached-limit colour there
  // says "you are out" for days while every turn still runs.
  const meterLevel = quotaMeterLevel(limit);
  const blocked = meterLevel === 'spent';
  // A warning whose percent the provider left out or garbled draws an empty bar
  // in the warning tint, and `percentText` below stays blank: the colour carries
  // what the provider told us, and inventing a length would be the one part we
  // do not know. A finite percent is required — NaN would reach the flex widths.
  const reported = limit?.usedPercent;
  const percent =
    reported !== undefined && Number.isFinite(reported) ? reported : blocked ? 100 : 0;
  const usage = Math.max(0, percent);
  const clamped = Math.min(100, usage);
  const fillColor =
    meterLevel === 'spent'
      ? theme.colors.accent
      : meterLevel === 'low'
        ? theme.colors.primary
        : theme.colors.textMuted;
  // Even-burn marker: where usage "should" sit now if the quota were spent at a
  // steady rate. Shown for both the five-hour and weekly windows.
  const pace = limit === null ? null : pacePercent(limit.resetsAt, window);
  useEffect(() => {
    if (pace === null) {
      setShowPaceInfo(false);
      setPaceInfoAnchor(null);
    }
  }, [pace]);
  useEffect(() => {
    setShowPaceInfo(false);
    setPaceInfoAnchor(null);
  }, [screenHeight, screenWidth]);
  const text = limit === null ? '--' : formatResetDisplay(limit.resetsAt, window);
  const percentText =
    reported === undefined || !Number.isFinite(reported) ? undefined : `${Math.round(usage)}%`;
  const accessibilityText =
    limit === null ? 'unknown' : `${Math.round(usage)} percent, resets ${text}`;
  const windowLabel = rateLimitWindowLabel(window);
  const paceStatus =
    pace === null
      ? null
      : usage > pace + 2
        ? `Usage is above the even ${windowLabel} pace.`
        : usage < pace - 2
          ? `Usage is below the even ${windowLabel} pace.`
          : `Usage matches the even ${windowLabel} pace.`;
  const closePaceInfo = () => {
    setShowPaceInfo(false);
    setPaceInfoAnchor(null);
  };
  const openPaceInfo = () => {
    chartRef.current?.measureInWindow((x, y, width, height) => {
      const cardWidth = Math.min(280, screenWidth - 24);
      const chartCenter = x + width / 2;
      const left = Math.max(
        12,
        Math.min(chartCenter - cardWidth / 2, screenWidth - cardWidth - 12),
      );
      setPaceInfoAnchor({
        top: y + height + 10,
        left,
        width: cardWidth,
        arrowLeft: Math.max(16, Math.min(cardWidth - 16, chartCenter - left)),
      });
      setShowPaceInfo(true);
    });
  };
  const chartContent = (
    <>
      <View
        style={styles.limitTrack}
        accessibilityLabel={`${rateLimitWindowLabel(window)} quota ${accessibilityText}`}
      >
        <View style={[styles.limitFill, { flex: clamped, backgroundColor: fillColor }]} />
        <View style={[styles.limitRemainder, { flex: 100 - clamped }]} />
      </View>
      {pace !== null ? (
        <View pointerEvents="none" style={[styles.limitPace, { left: `${pace}%` }]} />
      ) : null}
      {percentText !== undefined ? (
        <Text
          style={[styles.limitPercent, blocked ? styles.limitValueBlocked : null]}
          numberOfLines={1}
          ellipsizeMode="clip"
        >
          {percentText}
        </Text>
      ) : null}
    </>
  );
  return (
    <View
      style={[
        styles.limitSegment,
        usesWideSpacing
          ? window === 'weekly'
            ? styles.limitWeeklySegmentWide
            : styles.limitFiveHourSegmentWide
          : null,
      ]}
    >
      <Text style={styles.limitWindowLabel} numberOfLines={1} ellipsizeMode="clip">
        {label}
      </Text>
      {pace !== null ? (
        <Pressable
          ref={chartRef}
          style={styles.limitChart}
          onPress={showPaceInfo ? closePaceInfo : openPaceInfo}
          accessibilityRole="button"
          accessibilityLabel={`${windowLabel} token pace. ${accessibilityText}. ${paceStatus}`}
          accessibilityHint="Shows or hides an explanation of the pace marker"
          accessibilityState={{ expanded: showPaceInfo }}
          hitSlop={11}
        >
          {chartContent}
        </Pressable>
      ) : (
        <View style={styles.limitChart}>{chartContent}</View>
      )}
      <Text
        style={[styles.limitValue, blocked ? styles.limitValueBlocked : null]}
        numberOfLines={1}
      >
        {text}
      </Text>
      {pace !== null && paceInfoAnchor !== null ? (
        <Modal
          visible={showPaceInfo}
          transparent
          animationType="fade"
          onRequestClose={closePaceInfo}
        >
          <View
            style={styles.limitPaceInfoBackdrop}
            accessibilityViewIsModal
            onAccessibilityEscape={closePaceInfo}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={closePaceInfo} accessible={false} />
            <View
              style={[
                styles.limitPaceInfo,
                {
                  top: paceInfoAnchor.top,
                  left: paceInfoAnchor.left,
                  width: paceInfoAnchor.width,
                  maxHeight: Math.max(0, screenHeight - paceInfoAnchor.top - 12),
                },
              ]}
            >
              <View style={[styles.limitPaceInfoArrow, { left: paceInfoAnchor.arrowLeft - 7 }]} />
              <ScrollView bounces={false} contentContainerStyle={styles.limitPaceInfoContent}>
                <Text style={styles.limitPaceInfoTitle} accessibilityRole="header">
                  {windowLabel === 'weekly' ? 'Weekly' : '5-hour'} usage pace
                </Text>
                <Text style={styles.limitPaceInfoText}>
                  {Math.round(usage)}% used · {Math.round(pace)}% at even pace
                </Text>
                <Text style={styles.limitPaceInfoText}>{paceStatus}</Text>
                <Text style={styles.limitPaceInfoHint}>
                  The triangle shows where usage would be if your {windowLabel} limit were spread
                  evenly.
                </Text>
                <Pressable
                  style={styles.limitPaceInfoClose}
                  onPress={closePaceInfo}
                  accessibilityRole="button"
                >
                  <Text style={styles.limitPaceInfoCloseText}>Got it</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

// One session in the list: compact, table-like row inside its project group.
// The project card owns the outer frame; session rows stay flat so the overview
// does not read as nested cards.
function SessionRow({
  session,
  onRename,
  onSelect,
  onOpen,
  unread,
  selected,
  renaming,
}: {
  session: SessionSummary;
  onRename: () => void;
  onSelect?: () => void;
  onOpen?: () => void;
  unread?: boolean;
  selected?: boolean;
  renaming?: boolean;
}) {
  const { theme } = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const badge = sessionBadge(session.status);
  const toneColor = theme.colors.tone[badge.tone];
  const label = sessionLabel(session);
  const subtitle = modelDisplayName(session.model);
  const running = session.status === 'running';
  // "Done"/"Idle" are implicit from the ABSENCE of the working dot, so they get no
  // label — only states worth actively noticing keep a pill (see showsSessionLabel).
  const showLabel = showsSessionLabel(session.status);
  // Right-side markers are the PR signals only (merge-ready / merge-blocked /
  // CI-failed). Unread is NOT a right marker — it's folded into the LEFT dot below
  // (a stable blue dot when the agent is done + there are unread messages), so a row
  // has a single "wants your attention" indicator on the left.
  const markers: AttentionFlag[] = markerAttention({
    status: session.status,
    pr: session.pr,
    attention: session.attention,
  });
  // A condition the SERVER reported about THIS session, already written for the
  // operator. It replaces the model name on the second line rather than adding a
  // third: when a session's sandbox has been replaced under it, which model it
  // would have used is not the thing to say — and the row keeps its height, which
  // this list re-measures on every poll.
  const notice = attentionNotice(session.attention);
  // Accent wash marking the row whose rename sheet is open. Driven by an animated
  // value so that on close it lingers a beat and fades out (rather than vanishing)
  // as the sheet dismisses; on open it snaps in.
  const wash = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(wash, {
      toValue: renaming ? 1 : 0,
      duration: renaming ? 120 : 480,
      delay: renaming ? 0 : 140,
      useNativeDriver: true,
    }).start();
  }, [renaming, wash]);
  const rowBody = (
    // The row layout (flexDirection) MUST live on this inner View, not the outer
    // Pressable: in the narrow layout that Pressable is cloned by `<Link asChild>`,
    // which drops its `style` — so a flex-row set there silently falls back to a
    // column and stacks the dot ABOVE the name. A plain child View keeps its style.
    <View style={styles.rowInner}>
      {/* Accent wash overlay (behind the content) that fades out when the rename
          sheet closes. pointerEvents none so it never intercepts row taps. */}
      <Animated.View pointerEvents="none" style={[styles.renamingWash, { opacity: wash }]} />
      {/* Same [chevron col | dot col | title block] grid as the project header, so a
          session's dot + name line up under the project's. The chevron column is empty
          here; the dot column holds the single left indicator: a pulsing magenta dot
          while the agent works, else a stable blue dot if there are unread messages (a
          finished session with something new to read), else nothing. */}
      <View style={styles.colChevron} />
      <View style={styles.colDot}>{running ? <WorkingDot /> : unread ? <UnreadDot /> : null}</View>
      <View style={styles.titleBlock}>
        <Text style={styles.sessionTitle} numberOfLines={1}>
          {label}
        </Text>
        <Text
          style={[styles.rowSub, notice ? { color: theme.colors.tone.danger } : null]}
          numberOfLines={1}
          {...(notice ? { accessibilityRole: 'alert' as const } : {})}
        >
          {notice ? attentionNoticeText(notice) : subtitle}
        </Text>
      </View>
      {/* Right: attention icons, then the lifecycle label — hidden while working
          since the left dot already conveys it. */}
      <View style={styles.rowTrail}>
        <AttentionMarkers flags={markers} />
        {showLabel ? (
          <View
            style={[
              styles.statusPill,
              { borderColor: toneColor, backgroundColor: `${toneColor}1f` },
            ]}
          >
            <Text style={[styles.statusPillText, { color: toneColor }]} numberOfLines={1}>
              {badge.label}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  // Wide layout: select into the right pane instead of navigating. Narrow layout:
  // navigate to the full-screen session via the Link, exactly as before.
  if (onSelect) {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.row,
          hovered && !selected ? styles.rowHovered : null,
          selected ? styles.selectedRow : null,
          pressed ? styles.rowPressed : null,
        ]}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => {
          onOpen?.();
          onSelect();
        }}
        onLongPress={onRename}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityState={{ selected: !!selected }}
        accessibilityLabel={`Open session ${label}`}
        accessibilityHint="Long press to rename or delete"
      >
        {rowBody}
      </Pressable>
    );
  }

  return (
    <Link
      href={{ pathname: '/session/[id]', params: { id: session.sessionId } }}
      accessibilityLabel={`Open session ${label}`}
      asChild
    >
      <Pressable
        style={({ pressed }) => [
          styles.row,
          hovered ? styles.rowHovered : null,
          pressed ? styles.rowPressed : null,
        ]}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => onOpen?.()}
        onLongPress={onRename}
        delayLongPress={300}
        accessibilityHint="Long press to rename or delete"
      >
        {rowBody}
      </Pressable>
    </Link>
  );
}

function GroupSeparator() {
  return <View style={styles.separator} />;
}

function CenteredMessage({
  title,
  subtitle,
  onRetry,
}: {
  title: string;
  subtitle: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
      {onRetry ? (
        <Pressable style={styles.retry} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryLabel}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  limitMeters: {
    gap: 1,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 6,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  limitMetersHeader: {
    marginTop: -theme.spacing.md,
    marginHorizontal: -theme.spacing.lg,
    marginBottom: theme.spacing.md,
  },
  limitMeterRow: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  limitProvider: {
    width: 48,
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontWeight: '800',
  },
  limitSegment: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 7,
  },
  // The phone layout fits both segments evenly. On wider iPad/desktop layouts a
  // weekly reset includes a weekday plus its clock time, so shift WEEK left and
  // give it more of the shared row without disturbing the compact phone layout.
  limitFiveHourSegmentWide: {
    flex: 0.92,
  },
  limitWeeklySegmentWide: {
    flex: 1.08,
  },
  limitWindowLabel: {
    width: 32,
    flexShrink: 0,
    color: theme.colors.textMuted,
    fontSize: 10 * theme.fontScale,
    fontWeight: '800',
    textAlign: 'right',
    textTransform: 'uppercase',
  },
  limitChart: {
    width: 46,
    flexShrink: 0,
    minWidth: 38,
    // Taller than the bar to leave room for the pace tick below it (see
    // limitTrack.marginBottom); percent text occupies the space above the bar.
    height: 22,
    justifyContent: 'flex-end',
  },
  limitTrack: {
    height: 5,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
    // Lift the bar off the chart's bottom edge, reserving a lane for the pace
    // tick. Using the track's margin (not chart padding) keeps the tick's
    // absolute `bottom:0` anchored to the chart edge regardless of how Yoga
    // resolves padding for absolutely-positioned children.
    marginBottom: 4,
  },
  limitFill: {
    minWidth: 0,
    height: 5,
  },
  limitRemainder: {
    minWidth: 0,
    height: 5,
    backgroundColor: 'transparent',
  },
  // Even-burn marker: a small triangle in the lane below the quota bar, its
  // apex pointing up at the "you should be here now" position. Below the bar
  // (not above) so it never collides with the percent text. Border trick draws
  // the upward triangle; marginLeft recenters its 4px width on the left offset.
  limitPace: {
    position: 'absolute',
    bottom: 0,
    width: 0,
    height: 0,
    marginLeft: -2,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 3,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: theme.colors.text,
    opacity: 0.5,
  },
  limitPaceInfo: {
    position: 'absolute',
    elevation: 6,
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.16,
    shadowRadius: 6,
  },
  limitPaceInfoArrow: {
    position: 'absolute',
    top: -8,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: theme.colors.surface,
  },
  limitPaceInfoBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.34)',
  },
  limitPaceInfoContent: {
    gap: 2,
  },
  limitPaceInfoTitle: {
    color: theme.colors.text,
    fontSize: 11 * theme.fontScale,
    fontWeight: '800',
  },
  limitPaceInfoText: {
    color: theme.colors.text,
    fontSize: 10 * theme.fontScale,
    lineHeight: 14 * theme.fontScale,
  },
  limitPaceInfoHint: {
    marginTop: 2,
    color: theme.colors.textMuted,
    fontSize: 9 * theme.fontScale,
    lineHeight: 12 * theme.fontScale,
  },
  limitPaceInfoClose: {
    alignSelf: 'flex-end',
    minWidth: 44,
    minHeight: 44,
    marginTop: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  limitPaceInfoCloseText: {
    color: theme.colors.primary,
    fontSize: 10 * theme.fontScale,
    fontWeight: '800',
  },
  limitValue: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.textMuted,
    fontSize: 10 * theme.fontScale,
    fontWeight: '700',
  },
  limitPercent: {
    position: 'absolute',
    left: 2,
    // Track sits 4px up (marginBottom lane); keep the percent above it.
    bottom: 11,
    width: 30,
    color: theme.colors.textMuted,
    fontSize: 8 * theme.fontScale,
    fontWeight: '800',
    lineHeight: 9 * theme.fontScale,
    textAlign: 'left',
  },
  limitValueBlocked: {
    color: theme.colors.accent,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '600',
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 20 * theme.fontScale,
  },
  retry: {
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  retryLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  splitRow: {
    flex: 1,
    flexDirection: 'row',
  },
  leftPane: {
    width: 380,
    backgroundColor: theme.colors.background,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  rightPane: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  rightPanePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.xl,
  },
  rightPanePlaceholderText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
  },
  emptyOverview: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
  },
  issuesSection: {
    marginTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  pausedSection: {
    marginTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  pausedCount: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
  },
  pausedList: {
    gap: theme.spacing.sm,
  },
  projectGroup: {
    overflow: 'hidden',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  // iPhone single-pane: shed the rounded card frame and all borders so each group
  // reads as a full-width surface panel floating on the true-black page. The
  // negative margin cancels listContent's side gutter (which the issues
  // footer/empty state still rely on); groups are separated by the black gap from
  // `separator`, not by hairlines — fewer competing lines, clearer project blocks.
  projectGroupFlat: {
    borderRadius: 0,
    borderWidth: 0,
    marginHorizontal: -theme.spacing.lg,
  },
  projectGroupDragging: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surfaceAlt,
  },
  issuesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  issuesHeader: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  issuesError: {
    color: theme.colors.tone.attention,
    fontSize: theme.text.xs,
    lineHeight: 16 * theme.fontScale,
  },
  issueRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  issueRowNumber: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  issueRowTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 52,
    paddingVertical: theme.spacing.xs,
    paddingLeft: theme.spacing.lg,
    paddingRight: theme.spacing.lg,
  },
  projectHeaderHovered: {
    backgroundColor: 'transparent',
  },
  projectHeaderOpen: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  projectToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    minWidth: 0,
    paddingVertical: theme.spacing.xs,
  },
  // Shared 4-column grid, reused by project headers AND session rows so their dots
  // and titles line up on the same vertical lines. `colChevron` holds the collapse
  // chevron (empty on session rows); `colDot` holds the status/working dot, centered
  // in the row; then the flex `titleBlock`; then the trailing controls. Fixed column
  // widths (no inter-column gap) are what keep projects and sessions identical.
  colChevron: {
    width: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colDot: {
    width: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
    // Breathing room between the dot column and the name — the dot column centers a
    // small dot, leaving the text too close otherwise. Applied to the shared block so
    // projects and sessions get the same gap and stay aligned.
    paddingLeft: theme.spacing.md,
  },
  projectTitle: {
    minWidth: 0,
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
    lineHeight: 21 * theme.fontScale,
  },
  projectMetaRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  projectSubtitle: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  projectSetupLabel: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  // A failure reason has to be legible as a failure — muted grey made "Sandbox
  // container stopped" look like just another progress step.
  projectSetupLabelBroken: {
    color: theme.colors.tone.danger,
  },
  // Attention, not danger: the project is running. A stale attestation verdict
  // means it needs re-checking, not that it is broken — `danger` here would put
  // a working project in the same colour as a stopped container.
  projectWarningLabel: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.tone.attention,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  projectUpdatePending: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  projectActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  projectActionsHidden: {
    opacity: 0,
  },
  projectOpenButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm,
    backgroundColor: 'transparent',
  },
  projectIconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm,
    backgroundColor: 'transparent',
  },
  projectUpdateButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${theme.colors.accent}99`,
    backgroundColor: `${theme.colors.accent}1f`,
  },
  // Outlined in the same danger tone as the row's status dot, so the broken
  // project and the action that fixes it read as one signal.
  projectRepairButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${theme.colors.tone.danger}99`,
    backgroundColor: `${theme.colors.tone.danger}1f`,
  },
  projectActionDisabled: {
    opacity: 0.6,
  },
  projectSessions: {
    marginTop: 2,
    overflow: 'hidden',
  },
  // Inset hairline between adjacent sessions: hairlineWidth (thinner than 1px) in
  // the border tone, inset from the left to line up with the session title (row
  // gutter 16 + chevron col 30 + dot col 18 + title-block padding 12 = 76) so the
  // dot gutter stays clear. A calm iOS-style separator that distinguishes adjacent
  // session blocks without the restless full-width line grid the group had before.
  sessionDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: theme.spacing.lg + 30 + 18 + theme.spacing.md,
    backgroundColor: theme.colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    backgroundColor: theme.colors.surface,
  },
  // The [chevron | dot | title | trail] grid. Lives on a plain child View (not the
  // Pressable) because `<Link asChild>` drops the Pressable's style in the narrow
  // layout; `flex: 1` fills the Pressable's width in both layouts. paddingLeft ==
  // the project header's, so a session's leading columns line up under the project's.
  rowInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: theme.spacing.sm,
    paddingLeft: theme.spacing.lg,
  },
  selectedRow: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  // Accent wash for the row whose rename sheet is open. An absolute-fill overlay
  // (opacity animated) rather than a background on rowInner, so it can fade out on
  // close. Behind the content and pointer-transparent; sits on rowInner (NOT the
  // outer Pressable, whose style `<Link asChild>` drops in the narrow layout) so it
  // shows on phones too. No border → no layout shift.
  renamingWash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: `${theme.colors.accent}4d`,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowTrail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.sm,
    paddingRight: theme.spacing.lg,
  },
  rowSub: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  sessionTitle: {
    minWidth: 0,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
    lineHeight: 19 * theme.fontScale,
  },
  statusPill: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusPillText: {
    fontSize: theme.text.xs,
    fontWeight: '800',
    lineHeight: 15 * theme.fontScale,
  },
  separator: {
    height: theme.spacing.md,
  },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    // Top-anchored (paddingTop applied inline from the safe-area inset) so the
    // card sits in the upper area, clear of the keyboard, with a fixed position
    // that doesn't move when the keyboard opens or closes.
    justifyContent: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: 'rgba(0, 0, 0, 0.66)',
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    // Near-black surface defined by a hairline border, matching the rest of the
    // app — the violet surfaceAlt fill read as a heavy coloured slab. Depth
    // comes from the hairline + a soft neutral drop-shadow, not a fill.
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 16,
  },
  modalHeader: {
    gap: 4,
  },
  modalTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
  },
  modalInput: {
    minHeight: 44,
    color: theme.colors.text,
    fontSize: theme.text.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    // Pure-black inset against the near-black card — a crisp, hairline-defined
    // field rather than another filled block.
    backgroundColor: theme.colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    // Hairline divider separating the field from the actions — the fine-line
    // structure the rest of the app uses between grouped rows.
    paddingTop: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  modalActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  modalDeleteButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    // Ghost (text-only) destructive action — de-emphasised vs the filled Save
    // pill, and there's a native confirm before it fires (confirmDeleteSession).
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.pill,
  },
  modalDeleteText: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  modalCancelButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
  },
  modalCancelText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  modalSaveButton: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    // Tinted + hairline-outlined accent pill (the app's badge language) instead
    // of a solid neon fill — reads as the primary action without shouting.
    backgroundColor: `${theme.colors.accent}24`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
  },
  modalSaveText: {
    color: theme.colors.accent,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
}));
