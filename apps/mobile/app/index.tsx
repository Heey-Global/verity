import { useSessionRowCallbacks } from '../hooks/useSessionRowCallbacks';
import {
  beginRenderWork,
  beginRowTouch,
  markFirstSessionRender,
  rowPress,
} from '../lib/sessionSwitchTiming';
import { cancelSessionSwitch, markSessionSwitch, sessionSwitchTiming } from '@verity/mobile';
import { isLinkableSession } from '../lib/sessionLinks';
import { moveProjectIdToIndex } from '../lib/projectReorder';
import { SessionDragSlot } from '../components/SessionDragSlot';
import { SessionIssueRef } from '../components/SessionIssueRef';
import { SwipeableSessionRow } from '../components/SessionRowActions';
import {
  SessionMarkerColumn,
  sessionMarkers,
  sessionMarkersLabel,
} from '../components/SessionMarkerColumn';
import { SessionSettingsDialog } from '../components/SessionSettingsDialog';
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
  type DevServerDetection,
  type ProjectRecord,
  type ProviderLimitRow,
  type ProviderLimitState,
  type SessionSummary,
  isServerSecretSealedError,
  markerAttention,
  modelDisplayName,
  rateLimitWindowLabel,
  pacePercent,
  quotaMeterLevel,
  projectBadge,
  projectRepoRef,
  sandboxUpdateAlertMessage,
  sandboxUpdateIndicator,
  sandboxUpdateNeedsAttention,
  sessionBadge,
  attentionNotice,
  attentionNoticeText,
  sessionLabel,
  showsSessionLabel,
  UNAVAILABLE_PROJECT_BADGE,
  UNTRACKED_PROJECT_BADGE,
  type ProjectBadge,
  type RepoIdentity,
  parseBranchIssue,
} from '@verity/mobile';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  type LayoutChangeEvent,
  Linking,
  type ListRenderItemInfo,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AttentionMarkers, drawsAttentionMarker } from '../components/AttentionMarkers';
import { Icon } from '../components/Icon';
import { ProjectPortChip, type ProjectPortLink } from '../components/ProjectPortChip';
import { ProjectOverviewList } from '../components/ProjectOverviewList';
import { ProjectSessionsCollapse } from '../components/ProjectSessionsCollapse';
import {
  useProjectReorder,
  useProjectRowDrag,
  useSessionDragOrder,
  type ProjectReorderController,
} from '../components/useProjectReorder';
import { ProjectStatusDot } from '../components/ProjectStatusDot';
import { ServerAttentionBanner, StaleBanner } from '../components/ServerAttentionBanner';
import { UnreadDot } from '../components/UnreadDot';
import { WorkingDot } from '../components/WorkingDot';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useSessionList } from '../hooks/useSessionList';
import { useUnread } from '../hooks/useUnread';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';
import { useProjects } from '../hooks/useProjects';
import {
  cancelPrefetchedBranches,
  prefetchBranches,
  seedSessionBranches,
} from '../lib/branchesPrefetch';
import { newSessionId, registerPendingSession } from '../lib/pendingSessions';
import { createProjectCollapseQueue } from '../lib/projectCollapseQueue';
import { createSessionConfirmingWarnings } from '../lib/startSession';
import { devServerUrl } from '../lib/devServerUrl';
import { repairProject } from '../lib/projectRepair';
import { sessionLoadError } from '../lib/sessionLoadError';
import { projectOverviewStatus, type ProjectOverviewStatus } from '../lib/projectSetup';
import { formatResetDisplay } from '../lib/time';
import { SessionChat } from './session/[id]';

type SessionProjectGroup = {
  id: string;
  title: string;
  subtitle: string;
  /** The single line the row says about what is happening to this project — a
   *  transition in flight, a failure, or an attention line. Shown INSTEAD of
   *  `subtitle`, which is metadata and can wait. */
  status?: ProjectOverviewStatus;
  portLinks: ProjectPortLink[];
  project?: ProjectRecord;
  // Set on an "orphan" group — sessions whose project is INACTIVE (`absent`, so
  // filtered out of `GET /projects`). We still hold its id, so the overview can
  // offer the "…" action into the detail screen (where Repair lives) instead of
  // stranding the sessions with no way back.
  inactiveProjectId?: string;
  sessions: SessionSummary[];
};

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
  const { selected, targetMessageId, targetSearchQuery, retrySecret } = useLocalSearchParams<{
    selected?: string;
    targetMessageId?: string;
    targetSearchQuery?: string;
    retrySecret?: string;
  }>();
  const [selectedId, setSelectedId] = useState<string | null>(selected ?? null);
  if (selectedId) markFirstSessionRender(selectedId, 'selection-home-render-entry');
  const finishHomeWork = beginRenderWork('home-body', selectedId ?? undefined);
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
  const {
    sessions,
    loading,
    error,
    refresh,
    remove,
    setFavorite,
    sessionReordering,
    reorder: reorderSessions,
    providerLimitRows,
    serverAttention,
  } = useSessionList(client);
  const onToggleFavoriteSession = useCallback(
    (session: SessionSummary) => setFavorite(session.sessionId, session.favorite !== true),
    [setFavorite],
  );
  const onDeleteSession = useCallback(
    (session: SessionSummary) => confirmDeleteSession(session, remove),
    [remove],
  );
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
    previewUrls,
    publicPreviews,
  } = useProjects(client);
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
  // The order a drop chose, applied until a poll confirms the server has it.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const orderedGroups = useMemo(() => applyProjectOrder(groups, dragOrder), [groups, dragOrder]);
  const liveActiveGroups = useMemo(
    () => orderedGroups.filter((group) => !isPausedProjectGroup(group)),
    [orderedGroups],
  );
  const livePausedGroups = useMemo(
    () => orderedGroups.filter(isPausedProjectGroup),
    [orderedGroups],
  );
  const liveActiveGroupIds = useMemo(
    () => liveActiveGroups.map((group) => group.id),
    [liveActiveGroups],
  );
  const sortableGroupIds = useMemo(
    () => liveActiveGroups.flatMap((group) => (isReorderableGroup(group) ? [group.id] : [])),
    [liveActiveGroups],
  );
  // Saves run one after another: a second drag may start while the first is
  // still saving, and two requests in flight could land in either order.
  const reorderSave = useRef(Promise.resolve());
  const onDropProject = useCallback(
    (order: readonly string[]) => {
      // The drag saw the rows as they were at pickup; a poll since then may have
      // added or removed a project. Save the live set, in the dropped order, with
      // anything the drag never saw appended where a new project lands anyway.
      const dropped = new Set(order);
      const ids = [
        ...order.filter((id) => sortableGroupIds.includes(id)),
        ...sortableGroupIds.filter((id) => !dropped.has(id)),
      ];
      if (ids.every((id, i) => id === sortableGroupIds[i])) return;
      setDragOrder(ids);
      reorderSave.current = reorderSave.current
        .then(() => client.reorderProjects(ids))
        .then(() => refreshProjects())
        .catch((caught) => {
          Alert.alert(
            'Reorder failed',
            caught instanceof VerityApiError ? caught.message : 'Could not save project order.',
          );
          setDragOrder((current) => (current === ids ? null : current));
        });
    },
    [client, refreshProjects, sortableGroupIds],
  );
  const sessionOrders = useMemo(
    () =>
      sessionReordering
        ? Object.fromEntries(
            orderedGroups
              .filter((group) => !group.inactiveProjectId)
              .map((group) => [
                group.id,
                group.sessions.map((session) => `session:${session.sessionId}`),
              ]),
          )
        : {},
    [orderedGroups, sessionReordering],
  );
  const onDropSession = useCallback(
    (scope: string, order: readonly string[]) => {
      const group = orderedGroups.find((entry) => entry.id === scope);
      if (!group) return;
      const ids = order.map((id) => id.slice('session:'.length));
      void reorderSessions(group.project?.id ?? null, ids);
    },
    [orderedGroups, reorderSessions],
  );
  const reorder = useProjectReorder({
    order: liveActiveGroupIds,
    sortable: sortableGroupIds,
    onDrop: onDropProject,
    sessionOrders,
    onDropSession,
  });
  const draggingProjectId = reorder.draggingId;
  const draggingSessionId = reorder.draggingSessionId;
  const draggingAnything = draggingProjectId !== null || draggingSessionId !== null;
  // A poll landing mid-drag must not reshuffle the rows under the finger: the
  // list keeps the groups it was showing at pickup until the drop commits.
  const frozenActiveGroups = useRef(liveActiveGroups);
  useEffect(() => {
    if (!draggingAnything) frozenActiveGroups.current = liveActiveGroups;
  }, [draggingAnything, liveActiveGroups]);
  const activeGroups = draggingAnything ? frozenActiveGroups.current : liveActiveGroups;
  const frozenPausedGroups = useRef(livePausedGroups);
  useEffect(() => {
    if (!draggingAnything) frozenPausedGroups.current = livePausedGroups;
  }, [draggingAnything, livePausedGroups]);
  const pausedGroups = draggingAnything ? frozenPausedGroups.current : livePausedGroups;
  const floatingSessionGroup = [...activeGroups, ...pausedGroups].find(
    (group) => group.id === reorder.draggingSessionScope,
  );
  const floatingSession = floatingSessionGroup?.sessions.find(
    (session) => `session:${session.sessionId}` === draggingSessionId,
  );
  const activeGroupIds = useMemo(() => activeGroups.map((group) => group.id), [activeGroups]);
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
  const enqueueProjectCollapse = useMemo(
    () =>
      createProjectCollapseQueue((projectId, collapsed) =>
        client.setProjectCollapsed(projectId, collapsed),
      ),
    [client],
  );
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
  // Keep the optimistic order until a poll actually confirms it. Refresh can
  // fail silently, so completion of its promise does not prove reconciliation.
  useEffect(() => {
    if (draggingProjectId !== null || dragOrder === null) return;
    const expected = new Set(dragOrder);
    const actual = projects
      .filter((project) => expected.has(project.id))
      .map((project) => project.id);
    if (
      actual.length === dragOrder.length &&
      actual.every((id, index) => id === dragOrder[index])
    ) {
      setDragOrder(null);
    }
  }, [projects, draggingProjectId, dragOrder]);
  const [refreshingOverview, setRefreshingOverview] = useState(false);
  const [updatingProjectIds, setUpdatingProjectIds] = useState<Set<string>>(() => new Set());
  const updatingProjectIdsRef = useRef(new Set<string>());
  const [repairingProjectIds, setRepairingProjectIds] = useState<Set<string>>(() => new Set());
  // State drives rendering; the ref is the synchronous mutex. Two native press
  // events can arrive before React commits the first state update.
  const repairingProjectIdsRef = useRef(new Set<string>());
  // The session whose actions sheet is open (its long-press opened the modal), or
  // null when the modal is closed.
  const [moveGeneration, setMoveGeneration] = useState(0);
  const [renaming, setRenaming] = useState<(SessionSummary & { openLinks?: boolean }) | null>(null);

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
      if (client) {
        seedSessionBranches(client, session);
        prefetchBranches(client, session.sessionId);
      }
      // Let Link navigation or split-pane selection start before updating the list.
      setTimeout(() => {
        markSeen(session.sessionId, session.eventCount, session.eventCountVersion);
      }, 0);
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
      Alert.alert(
        // "Retry" is a claim about history and only one of these two has any:
        // a blocked update has never been attempted, it has been held back.
        update.turnBlocked ? 'Update waiting for a turn' : 'Retry sandbox update?',
        sandboxUpdateAlertMessage(project, update),
        // Dismiss-only while the turn holds it off. `updateProjectSandbox` posts
        // the same recreate the Server refuses for as long as a turn is running
        // (SBX-1), so an Update button here is an offer that cannot be accepted:
        // every press returns the 409 and surfaces as "Update failed", which reads
        // like a broken sandbox rather than a turn the operator has to end first.
        update.turnBlocked
          ? [{ text: 'OK', style: 'cancel' }]
          : [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Update', onPress: () => void updateProjectSandbox(project) },
            ],
      );
    },
    [updateProjectSandbox],
  );

  const renderGroup = useCallback(
    (item: SessionProjectGroup, floating = false) => {
      return (
        <ProjectGroup
          group={floating ? { ...item, sessions: [] } : item}
          floating={floating}
          wide={wide}
          collapsed={
            draggingProjectId !== null ||
            (collapsedOverride.get(item.id) ?? item.project?.collapsed ?? false)
          }
          onToggle={() => {
            if (draggingAnything) return;
            const nextValue = !(collapsedOverride.get(item.id) ?? item.project?.collapsed ?? false);
            setCollapsedOverride((current) => {
              const next = new Map(current);
              next.set(item.id, nextValue);
              return next;
            });
            const project = item.project;
            if (!project) return;
            enqueueProjectCollapse(project.id, nextValue, {
              // The override keeps holding the tapped value: the write's
              // response is not adopted, so a server answering from a list
              // memoised before the write cannot fold the group back. The
              // polled list clears the override once it reports the same value.
              success: () => void refreshProjects(),
              failure: (caught) => {
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
              },
            });
          }}
          reorder={reorder}
          renderedOrder={activeGroupIds}
          sortable={isReorderableGroup(item)}
          dragging={draggingProjectId === item.id}
          reordering={draggingAnything}
          sessionReordering={sessionReordering && !item.inactiveProjectId}
          onReorderSession={onDropSession}
          onRenameSession={setRenaming}
          onToggleFavoriteSession={onToggleFavoriteSession}
          onDeleteSession={onDeleteSession}
          onSelectSession={wide ? setSelectedId : undefined}
          onNewSession={wide ? createSessionInPane : undefined}
          onOpenSession={onOpenSession}
          onUpdateProject={confirmSandboxUpdate}
          onRepairProject={(projectId) => void repairProjectRow(projectId)}
          defaultNewSessionProject={defaultNewSessionProject}
          unread={unread}
          previewUrls={previewUrls}
          publicPreviews={publicPreviews}
          selectedId={wide ? selectedId : null}
          renamingId={renaming?.sessionId ?? null}
          updatingProjectIds={updatingProjectIds}
          repairingProjectIds={repairingProjectIds}
        />
      );
    },
    [
      activeGroupIds,
      collapsedOverride,
      draggingProjectId,
      draggingAnything,
      sessionReordering,
      onDropSession,
      enqueueProjectCollapse,
      reorder,
      wide,
      selectedId,
      unread,
      previewUrls,
      publicPreviews,
      onOpenSession,
      createSessionInPane,
      renaming,
      confirmSandboxUpdate,
      updatingProjectIds,
      repairProjectRow,
      repairingProjectIds,
      defaultNewSessionProject,
      refreshProjects,
      onToggleFavoriteSession,
      onDeleteSession,
    ],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SessionProjectGroup>) => renderGroup(item),
    [renderGroup],
  );

  useEffect(() => {
    if (!selectedId) return;
    return () => cancelPrefetchedBranches(client, selectedId);
  }, [client, selectedId]);

  // Wide layout: the session shown in the split pane is "open", so keep it marked
  // seen as new events stream in (markSeen no-ops when the count hasn't moved).
  useEffect(() => {
    if (!selectedId) return;
    const open = sessions.find((s) => s.sessionId === selectedId);
    if (open) markSeen(open.sessionId, open.eventCount, open.eventCountVersion);
  }, [selectedId, sessions, markSeen]);

  const onRefreshOverview = useCallback(async () => {
    setRefreshingOverview(true);
    try {
      await Promise.allSettled([refresh(), refreshProjects()]);
    } finally {
      setRefreshingOverview(false);
    }
  }, [refresh, refreshProjects]);

  // Delete is destructive + irreversible (drops history, removes the worktree),
  // so confirm with a native alert before firing. The optimistic removal + any
  // server error (e.g. 409 busy) are handled by the model and surface in the
  // stale banner.
  const onDeleteRenaming = useCallback(() => {
    if (!renaming) return;
    confirmDeleteSession(renaming, remove, () => setRenaming(null));
  }, [renaming, remove]);

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (error && sessions.length === 0) {
    const failure = sessionLoadError(error);
    return (
      <CenteredMessage
        title="Couldn't load sessions"
        subtitle={failure.summary}
        details={failure.details}
        onRetry={refresh}
      />
    );
  }

  // The list is shown as project groups. A poll error with known data is non-fatal
  // (keep the last list) but not silent.
  const master = (
    <View style={styles.flex}>
      {/* Above the stale banner on purpose: a poll that failed is a symptom, and
          this is the Server telling us the cause. */}
      {serverAttention ? <ServerAttentionBanner notice={serverAttention} /> : null}
      {error && sessions.length > 0 ? <StaleBanner message={error} onRetry={refresh} /> : null}
      {projectsError ? (
        <StaleBanner message={`Projects: ${projectsError}`} onRetry={refreshProjects} />
      ) : null}
      {/* Pinned above the list, not rendered as its header: the usage meters are
          the one thing on this screen that must not scroll, drag or fold away. */}
      {providerLimitRows.length > 0 ? <ProviderLimitMeters rows={providerLimitRows} /> : null}
      <GestureDetector gesture={reorder.gesture}>
        <Reanimated.View
          ref={reorder.hostRef}
          collapsable={false}
          style={styles.flex}
          onLayout={(event) => reorder.onViewportLayout(event.nativeEvent.layout.height)}
        >
          <ProjectOverviewList
            listRef={reorder.listRef}
            onContentSizeChange={reorder.onContentSizeChange}
            onScroll={reorder.onScroll}
            scrollEventThrottle={16}
            draggingProjectId={draggingProjectId ?? draggingSessionId}
            refreshing={refreshingOverview}
            onRefresh={onRefreshOverview}
            data={activeGroups}
            extraData={collapsedOverride}
            keyExtractor={(g) => g.id}
            renderItem={renderItem}
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
            ItemSeparatorComponent={GroupSeparator}
            ListEmptyComponent={
              pausedGroups.length === 0 ? (
                <View style={styles.emptyOverview}>
                  {projectsLoading ? <ActivityIndicator /> : null}
                  <Text style={styles.emptyTitle}>
                    {projectsLoading ? 'Loading projects' : 'Welcome to Verity'}
                  </Text>
                  <Text style={styles.emptySubtitle}>
                    Add an existing GitHub repository or create an empty project to get started.
                  </Text>
                  {!projectsLoading ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Add your first project"
                      onPress={() => router.push('/new-project')}
                      style={({ pressed }) => [
                        styles.emptyAction,
                        pressed ? styles.rowPressed : null,
                      ]}
                    >
                      <Text style={styles.emptyActionLabel}>Add your first project</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null
            }
            ListFooterComponent={
              <>
                {pausedGroups.length > 0 ? (
                  <View style={styles.pausedSection}>
                    <View style={styles.sectionHeaderRow}>
                      <Text style={styles.sectionHeader}>Paused</Text>
                      <Text style={styles.pausedCount}>{pausedGroups.length}</Text>
                    </View>
                    <View style={styles.pausedList}>
                      {pausedGroups.map((group) => (
                        <Fragment key={group.id}>{renderGroup(group)}</Fragment>
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
            }
          />
          {floatingSession && reorder.sessionDragToken !== null ? (
            <Reanimated.View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              key={reorder.sessionDragToken}
              onLayout={() => {
                if (reorder.sessionDragToken !== null)
                  reorder.confirmSessionOverlay(reorder.sessionDragToken);
              }}
              style={[reorder.overlayStyle, styles.sessionDragOverlay]}
            >
              <SessionRow
                session={floatingSession}
                onRename={() => {}}
                onToggleFavorite={() => {}}
                onDelete={() => {}}
                unread={unread.has(floatingSession.sessionId)}
                previewActive={previewUrls.has(floatingSession.sessionId)}
                previewPublic={publicPreviews.has(floatingSession.sessionId)}
                previewUrl={previewUrls.get(floatingSession.sessionId) ?? null}
                repo={
                  floatingSessionGroup?.project?.kind === 'github'
                    ? floatingSessionGroup.project
                    : undefined
                }
                selected={selectedId === floatingSession.sessionId}
                floating
              />
            </Reanimated.View>
          ) : null}
          {draggingProjectId !== null ? (
            <Reanimated.View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={reorder.overlayStyle}
            >
              {activeGroups
                .filter((group) => group.id === draggingProjectId)
                .map((group) => (
                  <Fragment key={group.id}>{renderGroup(group, true)}</Fragment>
                ))}
            </Reanimated.View>
          ) : null}
        </Reanimated.View>
      </GestureDetector>
      {renaming && client && (
        <SessionSettingsDialog
          key={renaming.sessionId}
          initialSection={renaming.openLinks ? 'links' : undefined}
          sessionId={renaming.sessionId}
          sessionName={renaming.name}
          displayName={sessionLabel(renaming)}
          projectId={renaming.projectId ?? null}
          projectName={
            projects.find((project) => project.id === renaming.projectId)?.repo ?? 'No project'
          }
          canMove={
            renaming.status !== 'running' &&
            projects.some(
              (project) => project.id === renaming.projectId && project.kind === 'local',
            )
          }
          moveDisabledReason={
            renaming.status === 'running'
              ? 'Finish the current turn before changing projects.'
              : 'Moving is available for normal sessions in local projects.'
          }
          client={client}
          projects={projects
            .filter((project) => project.kind === 'local')
            .map((project) => ({ id: project.id, name: project.repo }))}
          linkableSessions={sessions
            .filter((candidate) => isLinkableSession(candidate, renaming.sessionId, projects))
            .map((candidate) => ({
              id: candidate.sessionId,
              name: sessionLabel(candidate),
              projectId: candidate.projectId!,
              projectName:
                projects.find((project) => project.id === candidate.projectId)?.repo ??
                candidate.projectId!,
              detail: modelDisplayName(candidate.model),
            }))}
          onClose={() => setRenaming(null)}
          onDelete={onDeleteRenaming}
          onChanged={(moved) => {
            void refresh({ silent: true });
            if (moved && selectedId === renaming.sessionId) setMoveGeneration((value) => value + 1);
          }}
        />
      )}
    </View>
  );

  finishHomeWork();
  if (!wide) return master;

  return (
    <View style={styles.splitRow}>
      <View style={styles.leftPane}>{master}</View>
      <View style={styles.rightPane}>
        {selectedId && baseUrl ? (
          <SessionChat
            key={`${selectedId}:${moveGeneration}`}
            client={client}
            sessionId={selectedId}
            baseUrl={baseUrl}
            embedded
            initialTargetMessageId={targetMessageId}
            initialTargetSearchQuery={targetSearchQuery}
            retrySecret={retrySecret}
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
      status: projectOverviewStatus(project, detection),
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
    .filter((group) => group.project && rank.has(group.project.id))
    .sort((a, b) => {
      const aRank = rank.get(a.project!.id) ?? Number.MAX_SAFE_INTEGER;
      const bRank = rank.get(b.project!.id) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank;
    });
  let sortableIndex = 0;
  return groups.map((group) =>
    group.project && rank.has(group.project.id) ? sortable[sortableIndex++]! : group,
  );
}

function isPausedProjectGroup(group: SessionProjectGroup): boolean {
  return group.project?.state === 'absent';
}

/** A live project row the user may drag; the control plane and non-project rows keep their slot. */
function isReorderableGroup(group: SessionProjectGroup): boolean {
  return (
    group.project !== undefined &&
    group.project.state !== 'absent' &&
    !isVerityControlPlaneProject(group.project)
  );
}

/** Resolves the semantic status tone to the row's text style. Exhaustive over
 *  `ProjectOverviewStatus['tone']`, so a new tone cannot reach the row untyped. */
function statusToneStyle(tone: ProjectOverviewStatus['tone']) {
  switch (tone) {
    case 'working':
      return styles.projectStatusWorking;
    case 'attention':
      return styles.projectStatusAttention;
    case 'danger':
      return styles.projectStatusDanger;
    case 'idle':
      return styles.projectStatusIdle;
  }
}

function ProjectGroup({
  group,
  floating = false,
  wide,
  collapsed,
  onToggle,
  reorder,
  renderedOrder,
  sortable,
  dragging,
  reordering,
  sessionReordering,
  onReorderSession,
  onRenameSession,
  onToggleFavoriteSession,
  onDeleteSession,
  onSelectSession,
  onNewSession,
  onOpenSession,
  onUpdateProject,
  onRepairProject,
  defaultNewSessionProject,
  unread,
  previewUrls,
  publicPreviews,
  selectedId,
  renamingId,
  updatingProjectIds,
  repairingProjectIds,
}: {
  group: SessionProjectGroup;
  floating?: boolean;
  wide: boolean;
  collapsed: boolean;
  onToggle: () => void;
  reorder: ProjectReorderController;
  /** The row order the list is painting right now. */
  renderedOrder: readonly string[];
  sortable: boolean;
  dragging: boolean;
  reordering: boolean;
  sessionReordering: boolean;
  onReorderSession: (scope: string, order: readonly string[]) => void;
  onRenameSession: (session: SessionSummary & { openLinks?: boolean }) => void;
  onToggleFavoriteSession: (session: SessionSummary) => void;
  onDeleteSession: (session: SessionSummary) => void;
  onSelectSession?: (id: string) => void;
  // Wide layout only: create a session inline for this project (no /new route).
  // Undefined on narrow, where the "+" falls back to navigating to /new.
  onNewSession?: (project: ProjectRecord) => void;
  onOpenSession: (session: SessionSummary) => void;
  onUpdateProject: (project: ProjectRecord) => void;
  onRepairProject?: ((projectId: string) => void) | undefined;
  defaultNewSessionProject?: ProjectRecord | undefined;
  unread: ReadonlySet<string>;
  previewUrls: ReadonlyMap<string, string | null>;
  publicPreviews: ReadonlySet<string>;
  selectedId?: string | null;
  renamingId?: string | null;
  updatingProjectIds?: ReadonlySet<string>;
  repairingProjectIds?: ReadonlySet<string>;
}) {
  const finishGroupWork = beginRenderWork('sidebar-group-body');
  const { theme } = useUnistyles();
  const {
    slotRef,
    rowRef,
    handleCallbackRef,
    style: dragStyle,
  } = useProjectRowDrag({
    id: group.id,
    reorder,
    renderedOrder,
    enabled: sortable,
    floating,
  });
  const sessionDragOrder = useSessionDragOrder(group.sessions);
  const rowCallbacks = useSessionRowCallbacks({
    sessions: group.sessions,
    scope: group.id,
    reordering: sessionReordering,
    onRename: onRenameSession,
    onFavorite: onToggleFavoriteSession,
    onDelete: onDeleteSession,
    onSelect: onSelectSession,
    onOpen: onOpenSession,
    onReorder: onReorderSession,
  });
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
  // Both heights are reported as the row's pitch — the measured height plus the
  // gap to the next row and, on wide layouts, the card border — so that their
  // difference is exactly the session block a fold removes. The compact one is
  // the header alone: what the row occupies once every group is folded.
  const pitch = (height: number) => height + theme.spacing.md + (wide ? 2 : 0);
  const onHeaderLayout = (event: LayoutChangeEvent) => {
    if (!floating) reorder.reportCompactHeight(group.id, pitch(event.nativeEvent.layout.height));
  };
  finishGroupWork();
  return (
    <Reanimated.View ref={slotRef} collapsable={false}>
      <Reanimated.View
        style={[
          styles.projectGroup,
          !wide && styles.projectGroupFlat,
          dragging ? styles.projectGroupDragging : null,
          dragStyle,
          floating ? { marginHorizontal: 0 } : null,
        ]}
        ref={rowRef}
        collapsable={false}
      >
        <View
          onLayout={onHeaderLayout}
          style={[
            styles.projectHeader,
            headerHovered ? styles.projectHeaderHovered : null,
            !collapsed && sessionCount > 0 ? styles.projectHeaderOpen : null,
          ]}
        >
          {/* A held press on the header picks the row up; a tap still toggles it,
            and a swipe before the hold elapses scrolls the list as usual. */}
          <Pressable
            ref={handleCallbackRef}
            collapsable={false}
            style={({ pressed }) => [styles.projectToggle, pressed ? styles.rowPressed : null]}
            onHoverIn={() => setHeaderHovered(true)}
            onHoverOut={() => setHeaderHovered(false)}
            onPress={reordering ? undefined : onToggle}
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
              {group.portLinks.length > 0 || group.status || group.subtitle ? (
                <View style={styles.projectMetaRow}>
                  {group.portLinks.map((port) => (
                    <ProjectPortChip key={port.id} port={port} />
                  ))}
                  {/* Exactly one text: whatever is happening to the project wins
                    the slot outright, and its metadata (the release tag) is only
                    shown when nothing is. Both at once is what made a status
                    message and a version number share — and squeeze — one line. */}
                  {group.status ? (
                    <Text
                      style={[styles.projectStatusLabel, statusToneStyle(group.status.tone)]}
                      numberOfLines={1}
                    >
                      {group.status.label}
                    </Text>
                  ) : group.subtitle ? (
                    <Text style={styles.projectSubtitle} numberOfLines={1}>
                      {group.subtitle}
                    </Text>
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
                    href={{ pathname: '/project/[id]/settings', params: { id: group.project.id } }}
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
        {group.sessions.length > 0 ? (
          <ProjectSessionsCollapse collapsed={collapsed}>
            <View style={styles.projectSessions}>
              {group.sessions.map((session, index) => (
                <SessionDragSlot
                  key={session.sessionId}
                  id={`session:${session.sessionId}`}
                  scope={group.id}
                  order={sessionDragOrder}
                  reorder={reorder}
                  enabled={sessionReordering && !collapsed}
                >
                  {(handle, issue, markers) => (
                    <Fragment>
                      {/* Quiet inset hairline between sessions (never above the first — the
                  project header already draws its own bottom border). Inset to start
                  under the session title, leaving the dot gutter clear (iOS-style
                  leading inset), so adjacent session blocks read as separate without
                  the restless full-width line grid the group had before. */}
                      {index > 0 ? <View style={styles.sessionDivider} /> : null}
                      <SessionRow
                        session={session}
                        dragHandleRef={handle}
                        dragIssueRef={issue}
                        dragMarkersRef={markers}
                        reorderable={sessionReordering}
                        interactionsLocked={reordering}
                        {...rowCallbacks.get(session.sessionId)!}
                        unread={unread.has(session.sessionId)}
                        previewActive={previewUrls.has(session.sessionId)}
                        previewPublic={publicPreviews.has(session.sessionId)}
                        previewUrl={previewUrls.get(session.sessionId) ?? null}
                        repo={group.project?.kind === 'github' ? group.project : undefined}
                        selected={selectedId === session.sessionId}
                        renaming={renamingId === session.sessionId}
                      />
                    </Fragment>
                  )}
                </SessionDragSlot>
              ))}
            </View>
          </ProjectSessionsCollapse>
        ) : null}
      </Reanimated.View>
    </Reanimated.View>
  );
}

// Delete is destructive + irreversible (drops history, removes the worktree), so
// confirm with a native alert before firing. Called from the rename modal (opened
// by a row long-press) and from the row's swipe/context-menu action; `onConfirmed`
// lets the modal close itself after the delete.
function confirmDeleteSession(
  session: SessionSummary,
  remove: (sessionId: string, opts?: { force?: boolean }) => Promise<void>,
  onConfirmed?: () => void,
): void {
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

  Alert.alert(
    'Delete session?',
    `This permanently removes "${sessionLabel(session)}" — its history${session.automation ? ', its automation,' : ''} and worktree. This can't be undone.`,
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

function isVerityControlPlaneProject(project: ProjectRecord): boolean {
  return project.kind === 'control_plane';
}

function projectTitle(project: ProjectRecord): string {
  return isVerityControlPlaneProject(project) ? 'Verity Control' : project.repo;
}

const WIDE_PROVIDER_LIMIT_MIN_WIDTH = 700;

function ProviderLimitMeters({ rows }: { rows: ProviderLimitRow[] }) {
  return (
    <View style={styles.limitMeters}>
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
const SessionRow = memo(function SessionRow({
  session,
  onRename,
  onOpenLinks,
  onToggleFavorite,
  onDelete,
  onSelect,
  onOpen,
  unread,
  previewActive,
  previewPublic,
  previewUrl,
  repo,
  selected,
  renaming,
  dragHandleRef,
  dragIssueRef,
  dragMarkersRef,
  reorderable = false,
  interactionsLocked = false,
  floating = false,
  onMoveUp,
  onMoveDown,
}: {
  session: SessionSummary;
  onOpenLinks?: () => void;
  onRename: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onSelect?: () => void;
  onOpen?: () => void;
  unread?: boolean;
  previewActive?: boolean;
  /** An unexpired public share exists, whichever link the preview entry opens. */
  previewPublic?: boolean;
  /** Where the preview icon leads; null while a public share has no origin yet. */
  previewUrl?: string | null;
  /** The GitHub repo the issue number links into; absent for local projects. */
  repo?: RepoIdentity | undefined;
  selected?: boolean;
  renaming?: boolean;
  dragHandleRef?: RefCallback<View>;
  dragIssueRef?: RefCallback<View>;
  dragMarkersRef?: RefCallback<View>;
  reorderable?: boolean;
  interactionsLocked?: boolean;
  floating?: boolean;
  onMoveUp?: (() => void) | undefined;
  onMoveDown?: (() => void) | undefined;
}) {
  const finishRowWork = beginRenderWork('sidebar-row-body');
  const { theme } = useUnistyles();
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (selected)
      markSessionSwitch(sessionSwitchTiming(session.sessionId), 'selected-row-react-commit');
  }, [selected, session.sessionId]);
  const badge = sessionBadge(session.status);
  const toneColor = theme.colors.tone[badge.tone];
  const label = sessionLabel(session);
  const favorite = session.favorite === true;
  const subtitle = modelDisplayName(session.model);
  const running = session.status === 'running' || session.backgroundWorking === true;
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
  const edgeMarkers = sessionMarkers({
    favorite,
    linked: session.linked,
    automation: session.automation?.status,
    shared: previewActive ? (previewPublic ? 'online' : 'local') : undefined,
  });
  const a11yLabel = edgeMarkers.length
    ? `Open session ${label}, ${sessionMarkersLabel(edgeMarkers)}`
    : `Open session ${label}`;
  const hasIssue = parseBranchIssue(session.branch) !== null;
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
    <View ref={dragHandleRef} collapsable={false} style={styles.rowInner}>
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
      {/* Name with the lifecycle label at its right end; below it the model,
          followed by the issue and its PR status. Attached to the model, they use
          the room a short model name leaves free instead of competing with the
          marker column at the right end. */}
      <View style={[styles.titleBlock, styles.sessionTitleBlock]}>
        <View style={styles.sessionLine}>
          <View style={styles.sessionDragHandle}>
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {label}
            </Text>
          </View>
          {/* The lifecycle label is hidden while working since the left dot
              already conveys it. */}
          {showLabel ? (
            <View style={[styles.sessionLineEnd, styles.sessionTitleLineEnd]}>
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
            </View>
          ) : null}
        </View>
        <View style={styles.sessionLine}>
          <Text
            style={[
              styles.rowSub,
              styles.sessionSub,
              notice ? { color: theme.colors.tone.danger } : null,
            ]}
            numberOfLines={1}
            {...(notice ? { accessibilityRole: 'alert' as const } : {})}
          >
            {notice ? attentionNoticeText(notice) : subtitle}
          </Text>
          {/* The PR status sits after the issue it belongs to, not at the end of the
              title line, where it collided with the marker column. */}
          {hasIssue || drawsAttentionMarker(markers) ? (
            <View style={styles.sessionFeatures}>
              <Text style={styles.rowSub} accessible={false} importantForAccessibility="no">
                ·
              </Text>
              <SessionIssueRef branch={session.branch} repo={repo} dragExcludedRef={dragIssueRef} />
              <AttentionMarkers flags={markers} size={13} inline />
            </View>
          ) : null}
        </View>
      </View>
      {/* Favorite, automation and sharing: icon + short bar on the trailing edge,
          so the leading edge stays with the working/unread dot. */}
      <View
        ref={dragMarkersRef}
        collapsable={false}
        style={{ alignSelf: 'stretch', justifyContent: 'center' }}
      >
        <SessionMarkerColumn
          markers={edgeMarkers}
          previewUrl={previewUrl ?? null}
          onOpenLinks={interactionsLocked ? undefined : onOpenLinks}
        />
      </View>
    </View>
  );

  if (floating) return <View style={styles.row}>{rowBody}</View>;
  const moveActions = {
    accessibilityActions: [
      ...(onMoveUp ? [{ name: 'moveUp', label: 'Move up' }] : []),
      ...(onMoveDown ? [{ name: 'moveDown', label: 'Move down' }] : []),
    ],
    onAccessibilityAction: ({ nativeEvent }: { nativeEvent: { actionName: string } }) => {
      if (interactionsLocked) return;
      if (nativeEvent.actionName === 'moveUp') onMoveUp?.();
      if (nativeEvent.actionName === 'moveDown') onMoveDown?.();
    },
  };

  // Wide layout: select into the right pane instead of navigating. Narrow layout:
  // navigate to the full-screen session via the Link, exactly as before.
  const swipeable = (row: ReactNode) => (
    <SwipeableSessionRow
      favorite={favorite}
      label={label}
      onToggleFavorite={onToggleFavorite}
      onDelete={onDelete}
      onEdit={onRename}
      disabled={interactionsLocked}
    >
      {row}
    </SwipeableSessionRow>
  );

  finishRowWork();
  if (onSelect) {
    return swipeable(
      <Pressable
        style={({ pressed }) => [
          styles.row,
          hovered && !selected ? styles.rowHovered : null,
          selected ? styles.selectedRow : null,
          pressed ? styles.rowPressed : null,
        ]}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        disabled={interactionsLocked}
        {...moveActions}
        onTouchStart={(event) => beginRowTouch(session.sessionId, event.nativeEvent.timestamp)}
        onPressIn={() => markSessionSwitch(sessionSwitchTiming(session.sessionId), 'js-press-in')}
        onTouchCancel={() => cancelSessionSwitch(session.sessionId)}
        onPress={() => {
          if (interactionsLocked) return;
          rowPress(session.sessionId);
          markSessionSwitch(sessionSwitchTiming(session.sessionId), 'selection-dispatch');
          onSelect();
          onOpen?.();
        }}
        onLongPress={reorderable ? undefined : onRename}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityState={{ selected: !!selected }}
        accessibilityLabel={a11yLabel}
        accessibilityHint={
          reorderable
            ? 'Hold the session title to move it within this project. Swipe for settings.'
            : 'Long press to edit session settings'
        }
      >
        {rowBody}
      </Pressable>,
    );
  }

  return swipeable(
    <Link
      href={{ pathname: '/session/[id]', params: { id: session.sessionId } }}
      accessibilityLabel={a11yLabel}
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
        disabled={interactionsLocked}
        {...moveActions}
        onTouchStart={(event) => beginRowTouch(session.sessionId, event.nativeEvent.timestamp)}
        onPressIn={() => markSessionSwitch(sessionSwitchTiming(session.sessionId), 'js-press-in')}
        onTouchCancel={() => cancelSessionSwitch(session.sessionId)}
        onPress={() => {
          if (!interactionsLocked) {
            rowPress(session.sessionId);
            markSessionSwitch(sessionSwitchTiming(session.sessionId), 'link-navigation-dispatch');
            onOpen?.();
          }
        }}
        onLongPress={reorderable ? undefined : onRename}
        delayLongPress={300}
        accessibilityHint={
          reorderable
            ? 'Hold the session title to move it within this project. Swipe for settings.'
            : 'Long press to edit session settings'
        }
      >
        {rowBody}
      </Pressable>
    </Link>,
  );
});

function GroupSeparator() {
  return <View style={styles.separator} />;
}

function CenteredMessage({
  title,
  subtitle,
  details,
  onRetry,
}: {
  title: string;
  subtitle: string;
  details?: string;
  onRetry?: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
      {details ? (
        <>
          <Pressable
            onPress={() => setShowDetails((shown) => !shown)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetails }}
            accessibilityLabel={showDetails ? 'Hide technical details' : 'Show technical details'}
            style={styles.errorDetailsButton}
          >
            <Text style={styles.errorDetailsLabel}>
              {showDetails ? 'Hide technical details' : 'Show technical details'}
            </Text>
          </Pressable>
          {showDetails ? <Text style={styles.errorDetailsText}>{details}</Text> : null}
        </>
      ) : null}
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
  errorDetailsButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.sm,
  },
  errorDetailsLabel: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
  },
  errorDetailsText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    textAlign: 'center',
    maxWidth: 320,
  },
  emptyAction: {
    marginTop: theme.spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  emptyActionLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '700',
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
  // negative margin cancels listContent's side gutter; groups are separated by the black gap from
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
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  sectionHeader: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
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
  projectStatusLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  // Work in progress stays muted on purpose. The pulsing magenta dot in the
  // gutter is the signal that something is happening; painting the sentence the
  // same magenta would double it, and in the dark theme `accent` and
  // `tone.attention` are the same neon — a working row and a row that needs
  // looking at would become indistinguishable.
  projectStatusWorking: {
    color: theme.colors.textMuted,
  },
  projectStatusIdle: {
    color: theme.colors.textMuted,
  },
  // Attention, not danger: the project is running. A stale attestation verdict
  // means it needs re-checking, not that it is broken — `danger` here would put
  // a working project in the same colour as a stopped container.
  projectStatusAttention: {
    color: theme.colors.tone.attention,
  },
  // A failure reason has to be legible as a failure — muted grey made "Sandbox
  // container stopped" look like just another progress step.
  projectStatusDanger: {
    color: theme.colors.tone.danger,
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
  // The [chevron | dot | title] grid; the title block carries its own right ends.
  // Lives on a plain child View (not the Pressable) because `<Link asChild>` drops
  // the Pressable's style in the narrow layout; `flex: 1` fills the Pressable's
  // width in both layouts. paddingLeft == the project header's, so a session's
  // leading columns line up under the project's.
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
  rowSub: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  sessionDragHandle: { flex: 1, minWidth: 0 },
  sessionDragOverlay: { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radius.sm },
  sessionTitle: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
    lineHeight: 19 * theme.fontScale,
  },
  // The session row has no separate trail column: the title line carries its own
  // right end, so the block runs to the row's right edge.
  sessionTitleBlock: { paddingRight: theme.spacing.lg },
  sessionLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  // Shrinks never: the model name gives way first, so the features stay visible.
  sessionFeatures: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: theme.spacing.xs,
  },
  sessionSub: { minWidth: 0, flexShrink: 1 },
  // Held to the title's line height so the label, which is a hair taller, cannot
  // grow the row when it appears or hides on a working <-> idle switch; this list
  // re-measures rows on every poll.
  sessionTitleLineEnd: { height: 19 * theme.fontScale },
  sessionLineEnd: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
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
}));
