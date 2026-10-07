import { Icon } from './Icon';
import {
  projectDisplayName,
  taskAge,
  type ProjectRecord,
  type Task,
  type TaskContext,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
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
  const [menu, setMenu] = useState<{ task: Task; anchor: AttachAnchor } | null>(null);
  const anchors = useRef(new Map<string, View>());
  // The "…" card opens pinned to the row's own button, like the chat's message menu.
  const openMenu = (task: Task) =>
    anchors.current
      .get(task.id)
      ?.measureInWindow((x, y, width, height) =>
        setMenu({ task, anchor: { x, y, width, height } }),
      );
  const [agentOpen, setAgentOpen] = useState(false);
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
  // Everything the agent recorded is its working plan, never the operator's
  // list — also after its session has ended. Adopting moves a step across.
  const isStep = (task: Task) => task.origin === 'agent';
  const done = tasks.filter((t) => t.status === 'done' && !isStep(t));
  const visible = tasks.filter(
    (task) =>
      task.status !== 'dropped' && (task.status !== 'done' || showDone || undo.includes(task.id)),
  );
  // The operator's own captures are the list; the agent's steps sit in a
  // separate, quieter section below.
  const mine = visible.filter((task) => !isStep(task));
  const agentScope = (task: Task) =>
    isStep(task) &&
    (context.sessionId !== null
      ? task.sessionId === context.sessionId
      : context.projectId !== null
        ? task.projectId === context.projectId
        : true);
  const agentSteps = visible.filter(agentScope);
  const agentAll = tasks.filter((task) => agentScope(task) && task.status !== 'dropped');
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
      expanded: true,
      collapsible: false,
    },
    ...[
      ...new Set(
        mine
          .filter((t) => t.projectId !== null && t.projectId !== context.projectId)
          .map((t) => t.projectId!),
      ),
    ].map((id) => ({
      key: `other-${id}`,
      label: projectName(id),
      current: false,
      items: mine.filter((t) => t.projectId === id),
      expanded: expanded.includes(id),
      collapsible: true,
    })),
  ];
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
    const isSelected = selected.includes(task.id);
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
  // An agent step: compact, muted, no implement buttons — the agent is already
  // on it. Tap opens the same "…" card; adopting moves it into the list above.
  const agentRow = (task: Task) => {
    const isDone = task.status === 'done';
    return (
      <View key={task.id} style={styles.agentRow}>
        <Pressable
          ref={(node) => {
            if (node) anchors.current.set(task.id, node);
            else anchors.current.delete(task.id);
          }}
          accessibilityRole="button"
          accessibilityHint="Opens step actions"
          onPress={() => openMenu(task)}
          style={styles.agentMain}
        >
          <Icon
            name={isDone ? 'check-circle' : 'circle'}
            size={16}
            color={isDone ? theme.colors.tone.done : theme.colors.textFaint}
          />
          <View style={styles.rowBody}>
            <Text style={[styles.agentTitle, isDone ? styles.titleDone : null]}>{task.title}</Text>
            <Text style={styles.agentMeta}>
              {isDone
                ? `done${task.result ? ` · ${task.result}` : ''}`
                : task.status === 'in_progress'
                  ? 'in progress'
                  : 'open'}
              {' · '}
              {taskAge(task.createdAt)}
            </Text>
          </View>
        </Pressable>
        {undo.includes(task.id) ? (
          <Pressable style={styles.agentIndent} onPress={() => complete(task)}>
            <Text style={styles.link}>Undo</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
  // iOS will not present an alert while the menu's modal is still fading out,
  // so the confirmation waits for the dismissal to finish.
  const confirm = (title: string, verb: string, task: Task, work: () => Promise<unknown>) =>
    setTimeout(
      () =>
        Alert.alert(title, task.title, [
          { text: 'Cancel', style: 'cancel' },
          { text: verb, style: 'destructive', onPress: () => void run(work) },
        ]),
      350,
    );
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
        icon: 'edit-2',
        title: 'Edit',
        subtitle: 'Change the text',
        onPress: close(() => {
          setEdit(task);
          setText(task.title);
        }),
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
  const selectedTasks = tasks.filter((task) => selected.includes(task.id));
  const dispatchable = selectedTasks.filter(implementable);
  const bulkProject =
    dispatchable.length === selectedTasks.length &&
    dispatchable.length > 0 &&
    dispatchable.every((task) => task.projectId === dispatchable[0]?.projectId)
      ? dispatchable[0]!.projectId
      : null;
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
                {chip('Cancel', () => setEdit(null), { whileBusy: true })}
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
              <View style={styles.chips}>
                {chip('Cancel', () => setMoving(null), { whileBusy: true })}
              </View>
            </ScrollView>
          ) : (
            <ScrollView>
              {groups.map((group) => (
                <View key={group.key}>
                  <Pressable
                    disabled={!group.collapsible}
                    accessibilityRole={group.collapsible ? 'button' : undefined}
                    accessibilityLabel={`${group.label} · ${String(group.items.length)}`}
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
                      <Text style={styles.countLabel}>{String(group.items.length)}</Text>
                    </View>
                  </Pressable>
                  {group.expanded ? group.items.map(row) : null}
                </View>
              ))}
              {agentAll.length ? (
                <View style={styles.agentSection}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: agentOpen }}
                    accessibilityLabel={`Agent steps · ${String(agentDone)}/${String(agentAll.length)}`}
                    onPress={() => setAgentOpen(!agentOpen)}
                    style={styles.section}
                  >
                    <Icon
                      name={agentOpen ? 'chevron-down' : 'chevron-right'}
                      size={16}
                      color={theme.colors.textFaint}
                    />
                    <Text style={styles.agentLabel}>
                      {context.sessionId ? 'Agent’s steps in this session' : 'Agent’s steps'}
                    </Text>
                    <View style={styles.count}>
                      <Text style={styles.countLabel}>
                        {String(agentDone)}/{String(agentAll.length)}
                      </Text>
                    </View>
                    <View style={styles.bar}>
                      <View
                        style={[
                          styles.barFill,
                          {
                            width:
                              `${String(Math.round((agentDone / agentAll.length) * 100))}%` as `${number}%`,
                          },
                        ]}
                      />
                    </View>
                  </Pressable>
                  {agentOpen ? agentSteps.map(agentRow) : null}
                  {agentOpen && agentSteps.length === 0 ? (
                    <Text style={styles.agentMeta}>Every step is done.</Text>
                  ) : null}
                </View>
              ) : null}
              {!mine.length && !done.length ? (
                <Text style={styles.empty}>
                  {agentAll.length
                    ? 'Nothing captured yet. Tap the bubble to add a task.'
                    : 'Nothing here yet. Tap the bubble and say what needs doing.'}
                </Text>
              ) : null}
            </ScrollView>
          )}
          {selectedTasks.length ? (
            <View style={styles.footer}>
              <Text style={styles.meta}>{String(selectedTasks.length)} selected</Text>
              <View style={styles.chips}>
                {chip('Clear', () => setSelected([]), { whileBusy: true })}
                {bulkProject !== null ? (
                  <>
                    {context.sessionId && bulkProject === context.projectId
                      ? chip('↳ This Session', () => implement(dispatchable, context.sessionId!), {
                          accent: true,
                        })
                      : null}
                    {chip('+ New Session', () => implement(dispatchable))}
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
      {menu ? (
        <ActionMenu
          anchor={menu.anchor}
          label="Task actions"
          items={menuItems(menu.task)}
          onClose={() => setMenu(null)}
        />
      ) : null}
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
  agentSection: {
    marginTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  agentLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
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
  agentRow: {
    paddingVertical: theme.spacing.xs,
    gap: theme.spacing.xs,
  },
  agentMain: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    paddingTop: 2,
  },
  agentTitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
  },
  agentMeta: {
    color: theme.colors.textFaint,
    fontSize: theme.text.micro + 1,
  },
  agentIndent: {
    marginLeft: 24,
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
