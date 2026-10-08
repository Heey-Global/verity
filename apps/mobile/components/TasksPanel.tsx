import { Icon } from './Icon';
import { TaskIssuesList } from './TaskIssuesList';
import { createVerityClient } from '../lib/client';
import {
  projectDisplayName,
  taskAge,
  type ProjectRecord,
  type Task,
  type TaskContext,
  type SessionSummary,
  type ProjectGitHubIssues,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  PanResponder,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView, KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { saveTaskPreferences, useTaskPreferences } from '../lib/taskPreferences';
import { openTaskAttachment } from '../lib/taskAttachments';
import type { AttachAnchor } from '../lib/attachMenu';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { dispatchTasks } from '../lib/taskDispatch';
import { patchTask, removeTask, resolveTaskConflict, useTasks } from '../lib/tasksStore';

interface TaskGroup {
  key: string;
  label: string;
  current: boolean;
  items: Task[];
  expanded: boolean;
  collapsible: boolean;
}

/** One task view at a time, with projects and sessions sharing the same row anatomy. */
export function TasksPanel({
  context,
  projects,
  sessions = [],
  side,
  y,
  onClose,
  onCapture,
}: {
  context: TaskContext;
  projects: ProjectRecord[];
  sessions?: SessionSummary[];
  side: 'left' | 'right';
  y: number;
  onClose(): void;
  onCapture(): void;
}) {
  const { theme } = useUnistyles();
  const { width, height } = useWindowDimensions();
  const { tasks, pending, conflicts, errors } = useTasks();
  const [showDone, setShowDone] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [moving, setMoving] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dispatching, setDispatching] = useState<'new' | 'existing' | null>(null);
  const [undo, setUndo] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ task: Task; anchor: AttachAnchor } | null>(null);
  const anchors = useRef(new Map<string, View>());
  // The "…" card opens pinned to the row's own button, like the chat's message menu.
  const openMenu = (task: Task) =>
    anchors.current
      .get(task.id)
      ?.measureInWindow((x, y, width, height) =>
        setMenu({ task, anchor: { x, y, width, height } }),
      );
  const preferences = useTaskPreferences();
  const [github, setGithub] = useState<{ projectId: string; data: ProjectGitHubIssues } | null>(
    null,
  );
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubRetry, setGithubRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setGithub(null);
    setGithubError(null);
    if (context.projectId) {
      const projectId = context.projectId;
      const client = createVerityClient();
      if (client)
        void client
          .listProjectGitHubIssues(projectId)
          .then((data) => {
            if (active) setGithub({ projectId, data });
          })
          .catch(() => {
            if (active) setGithubError('Could not load GitHub issues');
          });
    }
    return () => {
      active = false;
    };
  }, [context.projectId, githubRetry]);
  const githubData = github?.projectId === context.projectId ? github.data : null;
  const githubConnected = githubData?.connected === true;
  const tab = preferences.tab === 'issues' && !githubConnected ? 'mine' : preferences.tab;
  const selectTab = (value: 'mine' | 'agent' | 'issues') => {
    setMoving(null);
    void saveTaskPreferences({ tab: value }).catch(() =>
      Alert.alert('Could not remember task view', 'Try again'),
    );
  };
  const wide = width >= 900;
  const run = async (work: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      Alert.alert('Task action failed', error instanceof Error ? error.message : 'Try again');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const implement = (items: Task[], sessionId?: string) => {
    void run(async () => {
      if (items.some((task) => pending.some((op) => op.id === task.id)))
        throw new Error('Wait for these tasks to sync before starting');
      setDispatching(sessionId ? 'existing' : 'new');
      try {
        const id = await dispatchTasks(items, sessionId);
        onClose();
        router.push({ pathname: '/session/[id]', params: { id } });
      } finally {
        setDispatching(null);
      }
    });
  };
  const complete = (task: Task) => {
    void run(async () => {
      await patchTask(task, { status: task.status === 'done' ? 'open' : 'done' });
      if (task.status !== 'done') {
        setUndo((ids) => [...ids, task.id]);
        setTimeout(() => setUndo((ids) => ids.filter((id) => id !== task.id)), 4000);
      }
    });
  };
  const projectName = (id: string) => {
    const project = projects.find((p) => p.id === id);
    return project ? projectDisplayName(project) : 'Project';
  };
  // Everything the agent recorded is its working plan, never the operator's
  // list — also after its session has ended. Adopting moves a step across.
  const isStep = (task: Task) => task.origin === 'agent';
  const done = tasks.filter((t) => t.status === 'done' && !isStep(t));
  const visible = tasks.filter(
    (task) =>
      task.status !== 'dropped' && (task.status !== 'done' || showDone || undo.includes(task.id)),
  );
  const mine = visible.filter((task) => !isStep(task));
  const agentAll = tasks.filter(
    (task) => isStep(task) && task.sessionId !== null && task.status !== 'dropped',
  );
  const agentDone = agentAll.filter((task) => task.status === 'done').length;
  const groups: TaskGroup[] = [
    ...(context.projectId
      ? [
          {
            key: context.projectId,
            label: projectName(context.projectId),
            current: true,
            items: mine.filter((t) => t.projectId === context.projectId),
            expanded: true,
            collapsible: false,
          },
        ]
      : []),
    {
      key: 'general',
      label: 'General',
      current: context.projectId === null,
      items: mine.filter((t) => t.projectId === null),
      expanded: context.projectId === null || expanded.includes('general'),
      collapsible: context.projectId !== null,
    },
    ...[
      ...new Set(
        mine
          .filter((t) => t.projectId !== null && t.projectId !== context.projectId)
          .map((t) => t.projectId!),
      ),
    ].map((id) => ({
      key: id,
      label: projectName(id),
      current: false,
      items: mine.filter((t) => t.projectId === id),
      expanded: expanded.includes(id),
      collapsible: true,
    })),
  ].filter((group) => group.items.length > 0);
  const sessionIds = [...new Set(agentAll.map((task) => task.sessionId!))];
  sessionIds.sort((a, b) => (a === context.sessionId ? -1 : b === context.sessionId ? 1 : 0));
  const agentGroups: TaskGroup[] = sessionIds.map((id) => ({
    key: `session-${id}`,
    label:
      id === context.sessionId
        ? 'This session'
        : sessions.find((session) => session.sessionId === id)?.name || 'Session',
    current: id === context.sessionId,
    items: agentAll.filter((task) => task.sessionId === id),
    expanded: id === context.sessionId || expanded.includes(`session-${id}`),
    collapsible: id !== context.sessionId,
  }));
  // Unassigned, not yet done, with a project to run in: the only tasks an
  // implement action may dispatch, whether from a row or from the selection.
  const implementable = (task: Task) =>
    task.projectId !== null && task.sessionId === null && task.status !== 'done';
  const chip = (
    label: string,
    onPress: () => void,
    options: { accent?: boolean; disabled?: boolean; whileBusy?: boolean } = {},
  ) => (
    <Pressable
      key={label}
      disabled={(busy && !options.whileBusy) || options.disabled}
      accessibilityState={{ disabled: (busy && !options.whileBusy) || !!options.disabled }}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        options.accent ? styles.chipAccent : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.chipLabel, options.accent ? styles.chipLabelAccent : null]}>
        {label}
      </Text>
    </Pressable>
  );
  const row = (task: Task) => {
    const pan = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 40) openMenu(task);
      },
    });
    const isDone = task.status === 'done';
    const syncing = pending.some((op) => op.id === task.id);
    const meta = [
      taskAge(task.createdAt),
      ...(task.attachments.length
        ? [
            `${String(task.attachments.length)} attachment${task.attachments.length === 1 ? '' : 's'}`,
          ]
        : []),
      ...(task.sessionId !== null && task.sessionId === context.sessionId
        ? ['in this session']
        : task.status === 'in_progress'
          ? ['in progress']
          : []),
      ...(syncing ? ['waiting to sync'] : []),
    ].join(' · ');
    // Implement buttons belong to unassigned project tasks only: an assigned
    // task already has its session, and a General task has no project to run in.
    const canImplement = implementable(task);
    const inThisProject = context.sessionId !== null && task.projectId === context.projectId;
    return (
      <View key={task.id} {...pan.panHandlers} style={styles.row}>
        <View style={styles.rowMain}>
          <Pressable
            disabled={busy}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isDone }}
            accessibilityLabel={isDone ? 'Reopen task' : 'Complete task'}
            hitSlop={8}
            onPress={() => complete(task)}
            style={styles.check}
          >
            <Icon
              name={isDone ? 'check-circle' : task.status === 'in_progress' ? 'loader' : 'circle'}
              size={20}
              color={
                isDone
                  ? theme.colors.tone.done
                  : task.status === 'in_progress'
                    ? theme.colors.primary
                    : theme.colors.textFaint
              }
            />
          </Pressable>
          {/* The text is the editor: tap to change it, leave the field to save. */}
          <View style={styles.rowBody}>
            {isDone ? (
              <Text style={[styles.title, styles.titleDone]}>{task.title}</Text>
            ) : (
              <TaskTitleInput
                task={task}
                onSave={(title) =>
                  patchTask(task, { title }).catch((error: unknown) => {
                    Alert.alert(
                      'Could not save task',
                      error instanceof Error ? error.message : 'Try again',
                    );
                    throw error;
                  })
                }
              />
            )}
            <Text style={styles.meta}>{meta}</Text>
          </View>
          <Pressable
            ref={(node) => {
              if (node) anchors.current.set(task.id, node);
              else anchors.current.delete(task.id);
            }}
            accessibilityRole="button"
            accessibilityLabel="Task actions"
            hitSlop={8}
            onPress={() => openMenu(task)}
            style={styles.more}
          >
            <Icon name="more-horizontal" size={18} color={theme.colors.textMuted} />
          </Pressable>
        </View>
        {conflicts.includes(task.id) ? (
          <View style={styles.indent}>
            <Text accessibilityRole="alert" style={styles.conflict}>
              {errors?.[task.id] ?? 'Changed on another device. Your edit is kept locally.'}
            </Text>
            <View style={styles.chips}>
              {chip('Keep my edit', () => {
                void run(() => resolveTaskConflict(task.id, true));
              })}
              {chip('Use server version', () => {
                void run(() => resolveTaskConflict(task.id, false));
              })}
            </View>
          </View>
        ) : null}
        {undo.includes(task.id) ? (
          <Pressable style={styles.indent} onPress={() => complete(task)}>
            <Text style={styles.link}>Undo</Text>
          </Pressable>
        ) : null}
        {task.attachments.map((attachment, index) => (
          <Pressable
            key={attachment.hash}
            style={styles.indent}
            onPress={() => {
              void run(() => openTaskAttachment(task, index, pending));
            }}
          >
            <Text style={styles.link} numberOfLines={1}>
              ↗ {attachment.filename}
            </Text>
          </Pressable>
        ))}
        {task.sessionId && task.sessionId !== context.sessionId ? (
          <Pressable
            style={styles.indent}
            onPress={() => {
              onClose();
              router.push({ pathname: '/session/[id]', params: { id: task.sessionId! } });
            }}
          >
            <Text style={styles.link}>↳ Open session</Text>
          </Pressable>
        ) : null}
        {canImplement ? (
          <View style={[styles.chips, styles.indent]}>
            {inThisProject
              ? chip('↳ This Session', () => implement([task], context.sessionId!), {
                  accent: true,
                })
              : null}
            {chip('+ New Session', () => implement([task]))}
          </View>
        ) : null}
      </View>
    );
  };
  const agentRow = (task: Task) => {
    const isDone = task.status === 'done';
    return (
      <View key={task.id} style={styles.row}>
        <View style={styles.rowMain}>
          <View style={styles.check}>
            <Icon
              name={isDone ? 'check-circle' : task.status === 'in_progress' ? 'loader' : 'circle'}
              size={20}
              color={
                isDone
                  ? theme.colors.tone.done
                  : task.status === 'in_progress'
                    ? theme.colors.primary
                    : theme.colors.textFaint
              }
            />
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.title, isDone ? styles.titleDone : null]}>{task.title}</Text>
            <Text style={styles.meta}>
              {isDone ? 'done' : task.status === 'in_progress' ? 'in progress' : 'open'} ·{' '}
              {taskAge(task.createdAt)}
            </Text>
          </View>
          <Pressable
            ref={(node) => {
              if (node) anchors.current.set(task.id, node);
              else anchors.current.delete(task.id);
            }}
            accessibilityRole="button"
            accessibilityLabel="Step actions"
            accessibilityHint="Opens step actions"
            onPress={() => openMenu(task)}
            style={styles.more}
            hitSlop={8}
          >
            <Icon name="more-horizontal" size={18} color={theme.colors.textMuted} />
          </Pressable>
        </View>
        {undo.includes(task.id) ? (
          <Pressable style={styles.indent} onPress={() => complete(task)}>
            <Text style={styles.link}>Undo</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
  // iOS will not present an alert while the menu's modal is still fading out,
  // so the confirmation waits for the dismissal to finish.
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );
  const confirm = (title: string, verb: string, task: Task, work: () => Promise<unknown>) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(
      () =>
        Alert.alert(title, task.title, [
          { text: 'Cancel', style: 'cancel' },
          { text: verb, style: 'destructive', onPress: () => void run(work) },
        ]),
      350,
    );
  };
  const menuItems = (task: Task): ActionMenuItem[] => {
    const isDone = task.status === 'done';
    const close = (work: () => void) => () => {
      setMenu(null);
      work();
    };
    if (task.origin === 'agent')
      return [
        ...(isDone
          ? []
          : [
              {
                icon: 'check-circle' as const,
                title: 'Mark done',
                subtitle: 'The agent no longer needs to do this',
                onPress: close(() => complete(task)),
              },
            ]),
        {
          icon: 'corner-up-left',
          title: 'Move to my tasks',
          subtitle: 'Keep it in your own list',
          onPress: close(() => {
            void run(() =>
              patchTask(task, {
                origin: 'user',
                sessionId: null,
                // Adopted work starts fresh in the operator's list.
                ...(isDone ? {} : { status: 'open' as const }),
              }),
            );
          }),
        },
        {
          icon: 'x-circle',
          title: 'Drop step',
          subtitle: 'Remove it from the agent’s plan',
          destructive: true,
          onPress: close(() =>
            confirm('Drop this step?', 'Drop', task, () => patchTask(task, { status: 'dropped' })),
          ),
        },
      ];
    return [
      {
        icon: isDone ? 'rotate-ccw' : 'check-circle',
        title: isDone ? 'Reopen' : 'Mark done',
        subtitle: isDone ? 'Put it back on your list' : 'Tick it off your list',
        onPress: close(() => complete(task)),
      },
      {
        icon: 'folder',
        title: 'Move',
        subtitle: 'To another project or General',
        onPress: close(() => setMoving(task)),
      },
      {
        icon: 'trash-2',
        title: 'Delete',
        subtitle: 'Remove the task for good',
        destructive: true,
        onPress: close(() => confirm('Delete task?', 'Delete', task, () => removeTask(task.id))),
      },
    ];
  };
  const headerButton = (label: string, icon: 'mic' | 'x', onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
    >
      <Icon name={icon} size={19} color={theme.colors.textMuted} />
    </Pressable>
  );
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.backdrop, wide ? styles.backdropWide : null]}
      >
        <Pressable
          accessibilityLabel="Close Tasks"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            styles.panel,
            { height: height * 0.7, maxHeight: '100%' },
            wide
              ? {
                  width: 380,
                  marginTop: Math.min(y, height * 0.25),
                  marginLeft: side === 'left' ? 38 : width - 418,
                }
              : styles.panelSheet,
          ]}
        >
          {wide ? null : <View style={styles.grabber} />}
          <View style={styles.head}>
            <Text style={styles.heading} accessibilityRole="header">
              Tasks
            </Text>
            {headerButton('Capture task', 'mic', onCapture)}
            {headerButton('Close', 'x', onClose)}
          </View>
          <View style={styles.tabs} accessibilityRole="tablist">
            {(['mine', 'agent', ...(githubConnected ? (['issues'] as const) : [])] as const).map(
              (value) => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  disabled={preferences.loaded === false}
                  accessibilityLabel={
                    value === 'mine' ? 'Mine' : value === 'agent' ? 'Agent' : 'GitHub Issues'
                  }
                  accessibilityState={{ selected: tab === value }}
                  onPress={() => selectTab(value)}
                  style={[styles.tab, tab === value ? styles.tabSelected : null]}
                >
                  <Text style={[styles.tabLabel, tab === value ? styles.tabLabelSelected : null]}>
                    {value === 'mine' ? 'Mine' : value === 'agent' ? 'Agent' : 'Issues'}
                  </Text>
                  <View style={[styles.count, tab === value ? styles.tabCountSelected : null]}>
                    <Text
                      style={[
                        styles.countLabel,
                        tab === value ? styles.tabCountLabelSelected : null,
                      ]}
                    >
                      {value === 'mine'
                        ? String(
                            tasks.filter(
                              (task) =>
                                !isStep(task) &&
                                task.status !== 'done' &&
                                task.status !== 'dropped',
                            ).length,
                          )
                        : value === 'agent'
                          ? `${String(agentDone)}/${String(agentAll.length)}`
                          : String(githubData?.issues.length ?? 0)}
                    </Text>
                  </View>
                </Pressable>
              ),
            )}
          </View>
          {githubError ? (
            <View style={styles.footer}>
              <Text accessibilityRole="alert" style={styles.meta}>
                {githubError}
              </Text>
              {chip('Retry GitHub', () => setGithubRetry((value) => value + 1))}
            </View>
          ) : null}
          {dispatching ? (
            <View style={styles.dispatchStatus} accessibilityLiveRegion="polite">
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text style={styles.meta}>
                {dispatching === 'new' ? 'Starting new session…' : 'Sending task to session…'}
              </Text>
            </View>
          ) : null}
          {moving ? (
            <KeyboardAwareScrollView bottomOffset={24}>
              <Text style={styles.sectionLabel}>Move to</Text>
              {[
                { id: null, label: 'General' },
                ...projects.map((p) => ({ id: p.id, label: projectDisplayName(p) })),
              ].map((project) => (
                <Pressable
                  key={project.id ?? 'general'}
                  style={({ pressed }) => [styles.moveTarget, pressed ? styles.pressed : null]}
                  onPress={() => {
                    void run(async () => {
                      await patchTask(moving, { projectId: project.id, sessionId: null });
                      setMoving(null);
                    });
                  }}
                >
                  <Text style={styles.title}>{project.label}</Text>
                </Pressable>
              ))}
              <View style={styles.chips}>
                {chip('Cancel', () => setMoving(null), { whileBusy: true })}
              </View>
            </KeyboardAwareScrollView>
          ) : (
            <KeyboardAwareScrollView bottomOffset={24}>
              {tab === 'issues' && context.projectId && githubData ? (
                <TaskIssuesList
                  key={context.projectId}
                  projectId={context.projectId}
                  projectName={projectName(context.projectId)}
                  currentSessionId={context.sessionId ?? undefined}
                  issues={githubData.issues}
                  viewerLogin={githubData.viewerLogin}
                  onOpenSession={(id) => {
                    onClose();
                    router.push({ pathname: '/session/[id]', params: { id } });
                  }}
                />
              ) : null}
              {(tab === 'issues' ? [] : tab === 'agent' ? agentGroups : groups).map((group) => (
                <View key={group.key}>
                  <Pressable
                    disabled={!group.collapsible}
                    accessibilityRole={group.collapsible ? 'button' : undefined}
                    accessibilityLabel={`${group.label} · ${String(group.items.length)}`}
                    accessibilityState={
                      group.collapsible ? { expanded: group.expanded } : undefined
                    }
                    onPress={() =>
                      setExpanded((ids) =>
                        ids.includes(group.key)
                          ? ids.filter((id) => id !== group.key)
                          : [...ids, group.key],
                      )
                    }
                    style={styles.section}
                  >
                    {group.current ? (
                      <View style={styles.currentDot} />
                    ) : (
                      <Icon
                        name={group.expanded ? 'chevron-down' : 'chevron-right'}
                        size={16}
                        color={theme.colors.textFaint}
                      />
                    )}
                    <Text
                      style={[
                        styles.sectionLabel,
                        !group.expanded ? styles.sectionLabelCollapsed : null,
                      ]}
                    >
                      {group.label}
                    </Text>
                    <View style={styles.count}>
                      <Text style={styles.countLabel}>
                        {tab === 'agent'
                          ? `${String(group.items.filter((task) => task.status === 'done').length)}/${String(group.items.length)}`
                          : String(group.items.length)}
                      </Text>
                    </View>
                    {tab === 'agent' && group.current ? (
                      <View style={styles.bar}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              width:
                                `${String(Math.round((group.items.filter((task) => task.status === 'done').length / group.items.length) * 100))}%` as `${number}%`,
                            },
                          ]}
                        />
                      </View>
                    ) : null}
                  </Pressable>
                  {group.expanded ? group.items.map(tab === 'agent' ? agentRow : row) : null}
                </View>
              ))}
            </KeyboardAwareScrollView>
          )}
          {tab === 'mine' ? (
            <Pressable
              onPress={() => setShowDone(!showDone)}
              accessibilityRole="button"
              style={styles.footer}
            >
              <Text style={styles.meta}>
                {showDone ? 'Hide done' : `Show done (${String(done.length)})`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
      {menu ? (
        <ActionMenu
          anchor={menu.anchor}
          label="Task actions"
          items={menuItems(tasks.find((task) => task.id === menu.task.id) ?? menu.task)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </Modal>
  );
}

/**
 * A task's text, editable in place. It saves when the field loses focus and
 * the text actually changed; an emptied field snaps back instead of saving.
 */
function TaskTitleInput({ task, onSave }: { task: Task; onSave(title: string): Promise<unknown> }) {
  const [value, setValue] = useState(task.title);
  const focused = useRef(false);
  // Keep the original revision through the save callback to detect concurrent edits.
  const baseline = useRef({ title: task.title, onSave });
  const dirty = useRef(false);
  const editGeneration = useRef(0);
  const latest = useRef(value);
  latest.current = value;
  // Follow edits from elsewhere (another device, the agent) unless typing.
  useEffect(() => {
    if (!focused.current) setValue(task.title);
  }, [task.title]);
  const commit = (next: string, title: string, save: (title: string) => Promise<unknown>) => {
    const trimmed = next.trim();
    if (!trimmed) {
      setValue(title);
      return;
    }
    if (trimmed === title) return;
    // A failed save puts the stored text back rather than showing unsaved text.
    const generation = editGeneration.current;
    save(trimmed).catch(() => {
      if (editGeneration.current === generation) setValue(title);
    });
  };
  // Closing the panel or switching views can unmount a focused field before
  // blur arrives; save what was typed instead of dropping it.
  useEffect(
    () => () => {
      if (!focused.current || !dirty.current) return;
      const { title, onSave: save } = baseline.current;
      const trimmed = latest.current.trim();
      if (trimmed && trimmed !== title) void save(trimmed).catch(() => undefined);
    },
    [],
  );
  return (
    <TextInput
      accessibilityLabel="Task text"
      value={value}
      onChangeText={(next) => {
        editGeneration.current++;
        dirty.current = true;
        setValue(next);
      }}
      onFocus={() => {
        editGeneration.current++;
        baseline.current = { title: task.title, onSave };
        dirty.current = false;
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (dirty.current) commit(value, baseline.current.title, baseline.current.onSave);
        else setValue(task.title);
      }}
      multiline
      scrollEnabled={false}
      blurOnSubmit
      returnKeyType="done"
      style={[styles.title, styles.titleInput]}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdropWide: {
    justifyContent: 'flex-start',
  },
  panel: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg + 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
  },
  panelSheet: {
    marginHorizontal: theme.spacing.sm,
    marginBottom: theme.spacing.xl,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.xs,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  },
  heading: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.pill,
  },
  pressed: {
    opacity: 0.6,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: 3,
    gap: 3,
    marginBottom: theme.spacing.xs,
  },
  tab: {
    flex: 1,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md - 2,
  },
  tabSelected: { backgroundColor: theme.colors.surface },
  tabLabel: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '500' },
  tabLabelSelected: { color: theme.colors.text, fontWeight: '600' },
  tabCountSelected: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tabCountLabelSelected: { color: theme.colors.onPrimary },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
  sectionLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionLabelCollapsed: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '500',
    letterSpacing: 0,
    textTransform: 'none',
  },
  currentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
  },
  count: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 1,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  countLabel: {
    color: theme.colors.text,
    fontSize: theme.text.micro,
    fontWeight: '600',
  },
  row: {
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  check: {
    paddingTop: 2,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 21 * theme.fontScale,
  },
  titleInput: {
    padding: 0,
    margin: 0,
    textAlignVertical: 'top',
  },
  titleDone: {
    color: theme.colors.textFaint,
    textDecorationLine: 'line-through',
  },
  meta: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
  },
  more: {
    width: 32,
    height: 24,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  indent: {
    marginLeft: 28,
  },
  link: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
  },
  conflict: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    marginBottom: theme.spacing.xs,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  chipAccent: {
    borderColor: theme.colors.primary,
  },
  chipLabel: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '500',
  },
  chipLabelAccent: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  moveTarget: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  bar: {
    flex: 1,
    maxWidth: 56,
    height: 3,
    marginLeft: 'auto',
    borderRadius: 2,
    backgroundColor: theme.colors.border,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: theme.colors.tone.done,
  },
  footer: {
    paddingTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  dispatchStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
}));
