import { Icon } from './Icon';
import { taskContext, type ProjectRecord, type SessionSummary } from '@verity/mobile';
import * as Haptics from 'expo-haptics';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { createVerityClient, subscribeVerityBaseUrl } from '../lib/client';
import { subscribeAuthToken } from '../lib/authToken';
import { subscribeBrowserSession } from '../lib/browserSession';
import { subscribeMeeting } from '../lib/liveMeetingSession';
import { subscribeFollowedRemoteMeeting } from '../lib/liveMeetingSync';
import {
  loadTaskContextData,
  saveTaskContextData,
  taskAccountScope,
  refreshTasks,
  removeTask,
  startTasksStore,
  useTasks,
} from '../lib/tasksStore';
import { saveTaskPreferences, useTaskPreferences } from '../lib/taskPreferences';
import { subscribeTasksPanel } from '../lib/taskPanelEvents';
import { useLiveHints } from '../lib/liveConnection';
import { getVerityBaseUrl } from '../lib/client';
import { useCallback } from 'react';
import { QuickCaptureCard } from './QuickCaptureCard';
import { TasksPanel } from './TasksPanel';

export function QuickCaptureBubble() {
  const hintRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFromHint = useCallback(() => {
    if (hintRefresh.current) return;
    hintRefresh.current = setTimeout(() => {
      hintRefresh.current = null;
      void refreshTasks().catch(() => undefined);
    }, 2000);
  }, []);
  useEffect(
    () => () => {
      if (hintRefresh.current) clearTimeout(hintRefresh.current);
    },
    [],
  );
  useLiveHints(getVerityBaseUrl(), refreshFromHint);
  useEffect(
    () =>
      subscribeTasksPanel(() => {
        setPanel(true);
        void refreshTasks().catch(() => undefined);
      }),
    [],
  );
  const { theme } = useUnistyles();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; selected?: string }>();
  const preferences = useTaskPreferences();
  const { tasks } = useTasks();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [keyboard, setKeyboard] = useState(Keyboard.isVisible());
  const [meeting, setMeeting] = useState(false);
  const [remoteMeeting, setRemoteMeeting] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [capture, setCapture] = useState(false);
  const [panel, setPanel] = useState(false);
  const [saved, setSaved] = useState<{ id: string; label: string } | null>(null);
  const position = useRef(new Animated.ValueXY()).current;
  const origin = useRef({ x: 0, y: 0 });
  const loadGeneration = useRef(0);
  const context = taskContext(pathname, params, sessions);
  const recentProjects = [...projects].sort((a, b) => {
    const recent = (id: string) =>
      Math.max(
        0,
        ...tasks.filter((task) => task.projectId === id).map((task) => Date.parse(task.updatedAt)),
      );
    return recent(b.id) - recent(a.id);
  });
  const count = tasks.filter(
    (task) =>
      (task.status === 'open' || task.status === 'in_progress') &&
      (context.sessionId
        ? task.sessionId === context.sessionId ||
          (task.projectId === context.projectId && task.sessionId === null)
        : task.projectId === context.projectId),
  ).length;
  const top = insets.top + 52;
  const bottom = height - insets.bottom - 100;
  useEffect(() => {
    origin.current = {
      x: preferences.side === 'left' ? -26 : width - 26,
      y: Math.max(top, Math.min(bottom, height * preferences.fraction)),
    };
    position.setValue(origin.current);
  }, [preferences.side, preferences.fraction, width, height, top, bottom, position]);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: () => setDragging(true),
        onPanResponderMove: (_, g) =>
          position.setValue({
            x: Math.max(-26, Math.min(width - 26, origin.current.x + g.dx)),
            y: Math.max(top, Math.min(height - 52, origin.current.y + g.dy)),
          }),
        onPanResponderRelease: (_, g) => {
          setDragging(false);
          if (origin.current.y + g.dy > height - 110) {
            setHidden(true);
            return;
          }
          const side = origin.current.x + g.dx + 26 < width / 2 ? 'left' : 'right';
          const y = Math.max(top, Math.min(bottom, origin.current.y + g.dy));
          origin.current = { x: side === 'left' ? -26 : width - 26, y };
          position.setValue(origin.current);
          void saveTaskPreferences({ side, fraction: y / height });
          void Haptics.selectionAsync();
        },
        onPanResponderTerminate: () => {
          setDragging(false);
          position.setValue(origin.current);
        },
      }),
    [position, width, height, top, bottom],
  );
  useEffect(() => startTasksStore(), []);
  useEffect(() => {
    const load = async () => {
      const generation = ++loadGeneration.current;
      const expectedScope = taskAccountScope();
      const client = createVerityClient();
      if (!client || !expectedScope) {
        setProjects([]);
        setSessions([]);
        return;
      }
      try {
        const [nextProjects, nextSessions] = await Promise.all([
          client.listProjects(),
          client.listSessions(),
        ]);
        if (generation !== loadGeneration.current) return;
        setProjects(nextProjects);
        setSessions(nextSessions);
        await saveTaskContextData(
          { projects: nextProjects, sessions: nextSessions },
          expectedScope,
        );
      } catch {
        /* Capture remains available with cached project context. */
      }
    };
    const reset = () => {
      ++loadGeneration.current;
      setProjects([]);
      setSessions([]);
      setCapture(false);
      setPanel(false);
      setSaved(null);
      const generation = loadGeneration.current;
      void loadTaskContextData()
        .then((data) => {
          if (data && loadGeneration.current === generation) {
            setProjects(data.projects);
            setSessions(data.sessions);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          void load();
        });
    };
    const refresh = () => {
      void load();
      void refreshTasks().catch(() => undefined);
    };
    void loadTaskContextData()
      .then((data) => {
        if (data && loadGeneration.current === 0) {
          setProjects(data.projects);
          setSessions(data.sessions);
        }
      })
      .catch(() => undefined)
      .finally(refresh);
    const timer = setInterval(refresh, 15000);
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh();
        void refreshTasks(true).catch(() => undefined);
      }
    });
    const unsubscribe = [
      subscribeVerityBaseUrl(reset),
      subscribeAuthToken(reset),
      subscribeBrowserSession(reset),
      subscribeMeeting((value) => setMeeting(value !== null)),
      subscribeFollowedRemoteMeeting((value) => setRemoteMeeting(value !== null)),
    ];
    return () => {
      ++loadGeneration.current;
      clearInterval(timer);
      app.remove();
      for (const stop of unsubscribe) stop();
    };
  }, []);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboard(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboard(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 4000);
    return () => clearTimeout(timer);
  }, [saved]);
  const visible =
    preferences.enabled &&
    taskAccountScope() !== null &&
    !hidden &&
    !keyboard &&
    !meeting &&
    !remoteMeeting &&
    !capture &&
    !panel &&
    !pathname.startsWith('/onboarding') &&
    !pathname.startsWith('/search') &&
    !pathname.includes('unlock-device');
  return (
    <>
      {visible ? (
        <Animated.View
          {...pan.panHandlers}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: position.getTranslateTransform(),
          }}
        >
          <Pressable
            accessibilityLabel="Capture task"
            onPress={() => setCapture(true)}
            onLongPress={() => setPanel(true)}
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              backgroundColor: theme.colors.accent,
              opacity: 0.6,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Icon name="mic" size={24} color="#fff" />
          </Pressable>
          {count > 0 ? (
            <Pressable
              accessibilityLabel={`Open Tasks, ${count} open`}
              onPress={() => setPanel(true)}
              style={{
                position: 'absolute',
                top: -10,
                [preferences.side === 'right' ? 'left' : 'right']: -7,
                borderRadius: 12,
                minWidth: 24,
                padding: 4,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text style={{ color: '#fff', textAlign: 'center', fontSize: 12 }}>{count}</Text>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}
      {dragging ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: 30,
            alignSelf: 'center',
            padding: 20,
            borderRadius: 24,
            backgroundColor: theme.colors.surface,
          }}
        >
          <Text style={{ color: theme.colors.text }}>✕ Hide</Text>
        </View>
      ) : null}
      {capture ? (
        <QuickCaptureCard
          context={context}
          projects={recentProjects}
          onClose={() => setCapture(false)}
          onSaved={(id, label) => setSaved({ id, label })}
        />
      ) : null}
      {panel ? (
        <TasksPanel
          context={context}
          projects={projects}
          side={preferences.side}
          y={origin.current.y}
          onClose={() => setPanel(false)}
          onCapture={() => {
            setPanel(false);
            setCapture(true);
          }}
        />
      ) : null}
      {saved ? (
        <View
          style={{
            position: 'absolute',
            bottom: 50,
            alignSelf: 'center',
            flexDirection: 'row',
            gap: 16,
            padding: 16,
            borderRadius: 18,
            backgroundColor: theme.colors.surface,
          }}
        >
          <Text style={{ color: theme.colors.text }}>Saved · {saved.label}</Text>
          <Pressable
            onPress={() => {
              void removeTask(saved.id)
                .then(() => setSaved(null))
                .catch((error) =>
                  Alert.alert(
                    'Could not undo save',
                    error instanceof Error ? error.message : 'Try again',
                  ),
                );
            }}
          >
            <Text style={{ color: theme.colors.accent }}>Undo</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}
