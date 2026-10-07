import { Icon } from './Icon';
import {
  projectDisplayName,
  taskAge,
  type ProjectRecord,
  type Task,
  type TaskContext,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { openTaskAttachment } from '../lib/taskAttachments';
import { dispatchTasks } from '../lib/taskDispatch';
import {
  patchTask,
  refreshTasks,
  removeTask,
  resolveTaskConflict,
  useTasks,
} from '../lib/tasksStore';

interface TaskGroup {
  key: string;
  label: string;
  /** Right-hand detail of the header: done/total for the session group. */
  detail?: string;
  current: boolean;
  items: Task[];
  expanded: boolean;
  collapsible: boolean;
}

/**
 * The task list (docs/TASKS_AND_QUICK_CAPTURE_CONCEPT.md §4.3): a bottom sheet
 * on the phone, a floating panel beside the bubble on wide layouts. Sections run
 * this session → current project → General → other projects collapsed. A task
 * already assigned to a session shows where it went instead of implement
 * buttons; General tasks have no session to run in and show none.
 */
export function TasksPanel({
  context,
  projects,
  side,
  y,
  onClose,
  onCapture,
}: {
  context: TaskContext;
  projects: ProjectRecord[];
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
  const [selected, setSelected] = useState<string[]>([]);
  const [edit, setEdit] = useState<Task | null>(null);
  const [text, setText] = useState('');
  const [moving, setMoving] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<string[]>([]);
  const [actions, setActions] = useState<string | null>(null);
  const wide = width >= 900;
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      Alert.alert('Task action failed', error instanceof Error ? error.message : 'Try again');
    } finally {
      setBusy(false);
    }
  };
  const implement = (items: Task[], sessionId?: string) => {
    void run(async () => {
      if (items.some((task) => pending.some((op) => op.id === task.id)))
        throw new Error('Wait for these tasks to sync before starting');
      const id = await dispatchTasks(items, sessionId);
      onClose();
      router.push({ pathname: '/session/[id]', params: { id } });
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
  const done = tasks.filter((t) => t.status === 'done');
  const visible = tasks.filter(
    (task) =>
      task.status !== 'dropped' && (task.status !== 'done' || showDone || undo.includes(task.id)),
  );
  const inSession = visible.filter(
    (task) => context.sessionId !== null && task.sessionId === context.sessionId,
  );
  // Everything in the current project that is not this session's own work,
  // including tasks running in a sibling session — those show where they went.
  const inCurrentProject = (task: Task) =>
    task.projectId === context.projectId && !inSession.includes(task);
  const sessionTasks = tasks.filter((t) => t.sessionId === context.sessionId);
  const groups: TaskGroup[] = [
    ...(context.sessionId
      ? [
          {
            key: 'session',
            label: 'This session',
            detail: `${String(sessionTasks.filter((t) => t.status === 'done').length)}/${String(sessionTasks.length)}`,
            current: true,
            items: inSession,
            expanded: true,
            collapsible: false,
          },
        ]
      : []),
    ...(context.projectId
      ? [
          {
            key: context.projectId,
            label: projectName(context.projectId),
            current: context.sessionId === null,
            items: visible.filter(inCurrentProject),
            expanded: true,
            collapsible: false,
          },
        ]
      : []),
    {
      key: 'general',
      label: 'General',
      current: context.projectId === null && context.sessionId === null,
      items: visible.filter((t) => t.projectId === null && !inSession.includes(t)),
      expanded: true,
      collapsible: false,
    },
    ...[
      ...new Set(
        visible
          .filter((t) => t.projectId !== null && !inSession.includes(t) && !inCurrentProject(t))
          .map((t) => t.projectId!),
      ),
    ].map((id) => ({
      key: `other-${id}`,
      label: projectName(id),
      current: false,
      items: visible.filter(
        (t) => t.projectId === id && !inSession.includes(t) && !inCurrentProject(t),
      ),
      expanded: expanded.includes(id),
      collapsible: true,
    })),
  ];
  const chip = (
    label: string,
    onPress: () => void,
    options: { accent?: boolean; disabled?: boolean } = {},
  ) => (
    <Pressable
      key={label}
      disabled={busy || options.disabled}
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
  const row = (task: Task, group: TaskGroup) => {
    const pan = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 40) setActions(task.id);
      },
    });
    const isDone = task.status === 'done';
    const isSelected = selected.includes(task.id);
    const syncing = pending.some((op) => op.id === task.id);
    const meta = [
      task.origin === 'agent' ? 'Agent' : 'You',
      taskAge(task.createdAt),
      ...(task.attachments.length
        ? [
            `${String(task.attachments.length)} attachment${task.attachments.length === 1 ? '' : 's'}`,
          ]
        : []),
      ...(task.status === 'in_progress' ? ['in progress'] : []),
      ...(syncing ? ['waiting to sync'] : []),
    ].join(' · ');
    // Implement buttons belong to unassigned project tasks only: an assigned
    // task already has its session, and a General task has no project to run in.
    const canImplement = task.projectId !== null && task.sessionId === null && !isDone;
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
              name={isDone ? 'check-circle' : 'circle'}
              size={20}
              color={isDone ? theme.colors.tone.done : theme.colors.textFaint}
            />
          </Pressable>
          <Pressable
            style={styles.rowBody}
            onLongPress={() => {
              setEdit(task);
              setText(task.title);
            }}
            onPress={() =>
              setSelected((ids) =>
                ids.includes(task.id) ? ids.filter((id) => id !== task.id) : [...ids, task.id],
              )
            }
            accessibilityState={{ selected: isSelected }}
          >
            <Text style={[styles.title, isDone ? styles.titleDone : null]}>
              {isSelected ? '☑ ' : ''}
              {task.title}
            </Text>
            <Text style={styles.meta}>{meta}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Task actions"
            hitSlop={8}
            onPress={() => setActions(actions === task.id ? null : task.id)}
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
        {task.sessionId && group.key !== 'session' ? (
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
        {actions === task.id ? (
          <View style={[styles.chips, styles.indent]}>
            {chip(isDone ? 'Reopen' : 'Done', () => complete(task))}
            {chip('Move', () => setMoving(task))}
            {chip('Edit', () => {
              setEdit(task);
              setText(task.title);
            })}
            {chip('Delete', () =>
              Alert.alert('Delete task?', task.title, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => {
                    void run(() => removeTask(task.id));
                  },
                },
              ]),
            )}
          </View>
        ) : null}
      </View>
    );
  };
  const selectedTasks = tasks.filter((task) => selected.includes(task.id));
  const headerButton = (label: string, icon: 'mic' | 'refresh-cw' | 'x', onPress: () => void) => (
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
      <View style={[styles.backdrop, wide ? styles.backdropWide : null]}>
        <Pressable
          accessibilityLabel="Close Tasks"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            styles.panel,
            { height: height * 0.7 },
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
            {headerButton('Refresh Tasks', 'refresh-cw', () => {
              void run(() => refreshTasks(true));
            })}
            {headerButton('Close', 'x', onClose)}
          </View>
          {edit ? (
            <View style={styles.editor}>
              <TextInput
                accessibilityLabel="Edit task text"
                value={text}
                onChangeText={setText}
                multiline
                style={styles.editorInput}
              />
              <View style={styles.chips}>
                {chip(
                  'Save',
                  () => {
                    void run(async () => {
                      await patchTask(edit, { title: text.trim() });
                      setEdit(null);
                    });
                  },
                  { accent: true, disabled: text.trim().length === 0 },
                )}
                {chip('Cancel', () => setEdit(null))}
              </View>
            </View>
          ) : moving ? (
            <ScrollView>
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
              <View style={styles.chips}>{chip('Cancel', () => setMoving(null))}</View>
            </ScrollView>
          ) : (
            <ScrollView>
              {groups.map((group) => (
                <View key={group.key}>
                  <Pressable
                    disabled={!group.collapsible}
                    accessibilityRole={group.collapsible ? 'button' : undefined}
                    accessibilityLabel={`${group.label} · ${group.detail ?? String(group.items.length)}`}
                    accessibilityState={
                      group.collapsible ? { expanded: group.expanded } : undefined
                    }
                    onPress={() => {
                      const id = group.key.replace('other-', '');
                      setExpanded((ids) =>
                        ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
                      );
                    }}
                    style={styles.section}
                  >
                    {group.collapsible ? (
                      <Icon
                        name={group.expanded ? 'chevron-down' : 'chevron-right'}
                        size={16}
                        color={theme.colors.textFaint}
                      />
                    ) : group.current ? (
                      <View style={styles.currentDot} />
                    ) : null}
                    <Text
                      style={[
                        styles.sectionLabel,
                        group.collapsible ? styles.sectionLabelCollapsed : null,
                      ]}
                    >
                      {group.label}
                    </Text>
                    <View style={styles.count}>
                      <Text style={styles.countLabel}>
                        {group.detail ?? String(group.items.length)}
                      </Text>
                    </View>
                  </Pressable>
                  {group.expanded ? group.items.map((task) => row(task, group)) : null}
                </View>
              ))}
              {!tasks.length ? (
                <Text style={styles.empty}>
                  Capture a thought, or ask your agent to save agreed work here.
                </Text>
              ) : null}
            </ScrollView>
          )}
          {selectedTasks.length ? (
            <View style={styles.footer}>
              <Text style={styles.meta}>{String(selectedTasks.length)} selected</Text>
              <View style={styles.chips}>
                {chip('Clear', () => setSelected([]))}
                {selectedTasks.every(
                  (task) =>
                    task.projectId !== null && task.projectId === selectedTasks[0]?.projectId,
                ) ? (
                  <>
                    {context.sessionId && selectedTasks[0]?.projectId === context.projectId
                      ? chip('↳ This Session', () => implement(selectedTasks, context.sessionId!), {
                          accent: true,
                        })
                      : null}
                    {chip('+ New Session', () => implement(selectedTasks))}
                  </>
                ) : null}
              </View>
            </View>
          ) : null}
          <Pressable
            onPress={() => setShowDone(!showDone)}
            accessibilityRole="button"
            style={styles.footer}
          >
            <Text style={styles.meta}>
              {showDone ? 'Hide done' : `Show done (${String(done.length)})`}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
  editor: {
    gap: theme.spacing.sm,
  },
  editorInput: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    minHeight: 80,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  moveTarget: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  empty: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.lg,
  },
  footer: {
    paddingTop: theme.spacing.md,
    gap: theme.spacing.sm,
  },
}));
