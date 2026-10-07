import { Icon } from './Icon';
import {
  projectDisplayName,
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
import { useUnistyles } from 'react-native-unistyles';
import { openTaskAttachment } from '../lib/taskAttachments';
import { dispatchTasks } from '../lib/taskDispatch';
import {
  patchTask,
  refreshTasks,
  removeTask,
  resolveTaskConflict,
  useTasks,
} from '../lib/tasksStore';

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
  const fg = { color: theme.colors.text };
  const button = { padding: 10, backgroundColor: theme.colors.background, borderRadius: 14 };
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
  const done = tasks.filter((t) => t.status === 'done');
  const visible = tasks.filter(
    (task) =>
      task.status !== 'dropped' && (task.status !== 'done' || showDone || undo.includes(task.id)),
  );
  const inSession = visible.filter(
    (task) => context.sessionId !== null && task.sessionId === context.sessionId,
  );
  const groups = [
    ...(context.sessionId
      ? [
          {
            key: 'session',
            label: `This session · ${tasks.filter((t) => t.sessionId === context.sessionId && t.status === 'done').length}/${tasks.filter((t) => t.sessionId === context.sessionId).length}`,
            items: inSession,
            expanded: true,
          },
        ]
      : []),
    ...(context.projectId
      ? [
          {
            key: context.projectId,
            label: projects.find((p) => p.id === context.projectId)
              ? projectDisplayName(projects.find((p) => p.id === context.projectId)!)
              : 'Current project',
            items: visible.filter((t) => t.projectId === context.projectId && t.sessionId === null),
            expanded: true,
          },
        ]
      : []),
    {
      key: 'general',
      label: 'General',
      items: visible.filter((t) => t.projectId === null && !inSession.includes(t)),
      expanded: true,
    },
    ...[
      ...new Set(
        visible
          .filter(
            (t) =>
              t.projectId !== null &&
              !inSession.includes(t) &&
              !(t.projectId === context.projectId && t.sessionId === null),
          )
          .map((t) => t.projectId!),
      ),
    ].map((id) => ({
      key: `other-${id}`,
      label: projects.find((p) => p.id === id)
        ? projectDisplayName(projects.find((p) => p.id === id)!)
        : 'Project',
      items: visible.filter(
        (t) =>
          t.projectId === id &&
          !inSession.includes(t) &&
          !(t.projectId === context.projectId && t.sessionId === null),
      ),
      expanded: expanded.includes(id),
    })),
  ];
  const row = (task: Task) => {
    const pan = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 40) setActions(task.id);
      },
    });
    return (
      <View
        key={task.id}
        {...pan.panHandlers}
        style={{
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            disabled={busy}
            accessibilityLabel={task.status === 'done' ? 'Reopen task' : 'Complete task'}
            onPress={() => complete(task)}
          >
            <Text style={{ ...fg, fontSize: 24 }}>{task.status === 'done' ? '✓' : '○'}</Text>
          </Pressable>
          <Pressable
            style={{ flex: 1 }}
            onLongPress={() => {
              setEdit(task);
              setText(task.title);
            }}
            onPress={() =>
              setSelected((ids) =>
                ids.includes(task.id) ? ids.filter((id) => id !== task.id) : [...ids, task.id],
              )
            }
          >
            <Text
              style={{
                ...fg,
                fontSize: 16,
                textDecorationLine: task.status === 'done' ? 'line-through' : 'none',
              }}
            >
              {selected.includes(task.id) ? '☑ ' : ''}
              {task.title}
            </Text>
            <Text style={{ color: theme.colors.textMuted, fontSize: 12 }}>
              {task.origin === 'user' ? 'Capture' : 'Agent'} ·{' '}
              {Math.max(0, Math.floor((Date.now() - Date.parse(task.createdAt)) / 86400000))}d
              {task.attachments.length ? ` · ${task.attachments.length} attachments` : ''}
              {pending.some((op) => op.id === task.id) ? ' · Waiting to sync' : ''}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Task actions"
            onPress={() => setActions(actions === task.id ? null : task.id)}
          >
            <Text style={fg}>•••</Text>
          </Pressable>
        </View>
        {conflicts.includes(task.id) ? (
          <View>
            <Text accessibilityRole="alert" style={fg}>
              {errors?.[task.id] ?? 'Changed on another device. Your edit is kept locally.'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                style={button}
                onPress={() => {
                  void run(() => resolveTaskConflict(task.id, true));
                }}
              >
                <Text style={fg}>Keep my edit</Text>
              </Pressable>
              <Pressable
                style={button}
                onPress={() => {
                  void run(() => resolveTaskConflict(task.id, false));
                }}
              >
                <Text style={fg}>Use server version</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {undo.includes(task.id) ? (
          <Pressable onPress={() => complete(task)}>
            <Text style={{ color: theme.colors.accent }}>Undo</Text>
          </Pressable>
        ) : null}
        {task.attachments.map((attachment, index) => (
          <Pressable
            key={attachment.hash}
            onPress={() => {
              void run(() => openTaskAttachment(task, index, pending));
            }}
          >
            <Text style={{ color: theme.colors.accent }}>↗ {attachment.filename}</Text>
          </Pressable>
        ))}
        {task.sessionId ? (
          <Pressable
            onPress={() => {
              onClose();
              router.push({ pathname: '/session/[id]', params: { id: task.sessionId! } });
            }}
          >
            <Text style={{ color: theme.colors.accent }}>↳ Open session</Text>
          </Pressable>
        ) : null}
        {task.projectId && task.status !== 'done' ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {context.sessionId && task.projectId === context.projectId ? (
              <Pressable
                disabled={busy}
                style={button}
                onPress={() => implement([task], context.sessionId!)}
              >
                <Text style={fg}>↳ This Session</Text>
              </Pressable>
            ) : null}
            <Pressable disabled={busy} style={button} onPress={() => implement([task])}>
              <Text style={fg}>+ New Session</Text>
            </Pressable>
          </View>
        ) : null}
        {actions === task.id ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable style={button} onPress={() => complete(task)}>
              <Text style={fg}>Done</Text>
            </Pressable>
            <Pressable style={button} onPress={() => setMoving(task)}>
              <Text style={fg}>Move</Text>
            </Pressable>
            <Pressable
              style={button}
              onPress={() => {
                setEdit(task);
                setText(task.title);
              }}
            >
              <Text style={fg}>Edit</Text>
            </Pressable>
            <Pressable
              style={button}
              onPress={() =>
                Alert.alert('Delete task?', task.title, [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                      void run(() => removeTask(task.id));
                    },
                  },
                ])
              }
            >
              <Text style={fg}>Delete</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };
  const selectedTasks = tasks.filter((task) => selected.includes(task.id));
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: width >= 900 ? 'flex-start' : 'flex-end',
          backgroundColor: '#0004',
        }}
      >
        <Pressable
          accessibilityLabel="Close Tasks"
          onPress={onClose}
          style={{ position: 'absolute', width: '100%', height: '100%' }}
        />
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: 24,
            padding: 18,
            height: height * 0.7,
            ...(width >= 900
              ? {
                  width: 380,
                  marginTop: Math.min(y, height * 0.25),
                  marginLeft: side === 'left' ? 38 : width - 418,
                }
              : { margin: 10, marginBottom: 24 }),
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={{ ...fg, fontSize: 24 }}>Tasks</Text>
            <Pressable accessibilityLabel="Capture task" onPress={onCapture}>
              <Icon name="mic" color={theme.colors.text} />
            </Pressable>
            <Pressable
              accessibilityLabel="Refresh Tasks"
              onPress={() => {
                void run(() => refreshTasks(true));
              }}
            >
              <Text style={fg}>↻</Text>
            </Pressable>
            <Pressable onPress={onClose}>
              <Text style={fg}>✕</Text>
            </Pressable>
          </View>
          {edit ? (
            <View>
              <TextInput
                accessibilityLabel="Edit task text"
                value={text}
                onChangeText={setText}
                multiline
                style={{ ...fg, minHeight: 80 }}
              />
              <Pressable
                style={button}
                onPress={() => {
                  void run(async () => {
                    await patchTask(edit, { title: text.trim() });
                    setEdit(null);
                  });
                }}
              >
                <Text style={fg}>Save</Text>
              </Pressable>
              <Pressable onPress={() => setEdit(null)}>
                <Text style={fg}>Cancel</Text>
              </Pressable>
            </View>
          ) : moving ? (
            <ScrollView>
              <Text style={fg}>Move to</Text>
              {[
                { id: null, label: 'General' },
                ...projects.map((p) => ({ id: p.id, label: projectDisplayName(p) })),
              ].map((project) => (
                <Pressable
                  key={project.id ?? 'general'}
                  style={button}
                  onPress={() => {
                    void run(async () => {
                      await patchTask(moving, { projectId: project.id, sessionId: null });
                      setMoving(null);
                    });
                  }}
                >
                  <Text style={fg}>{project.label}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => setMoving(null)}>
                <Text style={fg}>Cancel</Text>
              </Pressable>
            </ScrollView>
          ) : (
            <ScrollView>
              {groups.map((group) => (
                <View key={group.key}>
                  <Pressable
                    onPress={() => {
                      const id = group.key.replace('other-', '');
                      setExpanded((ids) =>
                        ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
                      );
                    }}
                    style={{ paddingTop: 18, paddingBottom: 6 }}
                  >
                    <Text style={{ ...fg, fontWeight: '600' }}>
                      {group.expanded ? '⌄' : '›'} {group.label} · {group.items.length}
                    </Text>
                  </Pressable>
                  {group.expanded ? group.items.map(row) : null}
                </View>
              ))}
              {!tasks.length ? (
                <Text style={fg}>
                  Capture a thought, or ask your agent to save agreed work here.
                </Text>
              ) : null}
            </ScrollView>
          )}
          {selectedTasks.length ? (
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Pressable onPress={() => setSelected([])}>
                <Text style={fg}>Clear ({selectedTasks.length})</Text>
              </Pressable>
              {selectedTasks.every(
                (task) => task.projectId !== null && task.projectId === selectedTasks[0]?.projectId,
              ) ? (
                <>
                  <Pressable disabled={busy} onPress={() => implement(selectedTasks)}>
                    <Text style={fg}>New Session</Text>
                  </Pressable>
                  {context.sessionId && selectedTasks[0]?.projectId === context.projectId ? (
                    <Pressable
                      disabled={busy}
                      onPress={() => implement(selectedTasks, context.sessionId!)}
                    >
                      <Text style={fg}>This Session</Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : null}
          <Pressable onPress={() => setShowDone(!showDone)} style={{ paddingTop: 12 }}>
            <Text style={{ color: theme.colors.textMuted }}>
              {showDone ? 'Hide done' : `Show done (${done.length})`}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
