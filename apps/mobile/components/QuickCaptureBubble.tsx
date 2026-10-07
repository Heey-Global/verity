import { Icon } from './Icon';
import {
  bubbleRestingPlace,
  taskContext,
  type ProjectRecord,
  type SessionSummary,
} from '@verity/mobile';
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
import { QuickCaptureIntro } from './QuickCaptureIntro';
import { TasksPanel } from './TasksPanel';

/** Bubble diameter; half of it sits outside the screen edge. */
const BUBBLE = 44;
/** Extra touch area on the visible side, so the target is a full 44pt. */
const EXTEND = 22;

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
  const [intro, setIntro] = useState(false);
  const [panel, setPanel] = useState(false);
  const [saved, setSaved] = useState<{ id: string; label: string } | null>(null);
  const position = useRef(new Animated.ValueXY()).current;
  const squash = useRef(new Animated.Value(1)).current;
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
  // Only what the operator captured counts: the agent's own steps live in
  // their own section of the panel and must not nag from the badge.
  const count = tasks.filter(
    (task) =>
      (task.origin === 'user' || task.sessionId === null) &&
      (task.status === 'open' || task.status === 'in_progress') &&
      (context.sessionId
        ? task.sessionId === context.sessionId ||
          (task.projectId === context.projectId && task.sessionId === null)
        : task.projectId === context.projectId),
  ).length;
  const top = insets.top + 52;
  const bottom = height - insets.bottom - 100;
  useEffect(() => {
    const next = {
      x: preferences.side === 'left' ? -BUBBLE / 2 : width - BUBBLE / 2,
      y: Math.max(top, Math.min(bottom, height * preferences.fraction)),
    };
    // A release saves its own resting place, which re-runs this effect while
    // the spring is still flying; jumping to the same spot would cut it short.
    if (Math.abs(next.x - origin.current.x) < 0.5 && Math.abs(next.y - origin.current.y) < 0.5)
      return;
    origin.current = next;
    position.setValue(origin.current);
  }, [preferences.side, preferences.fraction, width, height, top, bottom, position]);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: () => {
          // Grabbing a bubble mid-flight: freeze it where it is and drag from there.
          position.stopAnimation((value) => {
            origin.current = value;
          });
          squash.stopAnimation(() => squash.setValue(1));
          setDragging(true);
        },
        onPanResponderMove: (_, g) =>
          position.setValue({
            x: Math.max(-BUBBLE / 2, Math.min(width - BUBBLE / 2, origin.current.x + g.dx)),
            y: Math.max(top, Math.min(height - BUBBLE, origin.current.y + g.dy)),
          }),
        onPanResponderRelease: (_, g) => {
          setDragging(false);
          if (origin.current.y + g.dy > height - 110) {
            setHidden(true);
            return;
          }
          // A throw keeps its momentum: the spring starts at the finger's
          // velocity, so a hard fling overshoots the edge and bounces back,
          // while a gentle release just glides home.
          const rest = bubbleRestingPlace({
            x: origin.current.x + g.dx + BUBBLE / 2,
            y: origin.current.y + g.dy,
            vx: g.vx,
            vy: g.vy,
            width,
            top,
            bottom,
          });
          origin.current = {
            x: rest.side === 'left' ? -BUBBLE / 2 : width - BUBBLE / 2,
            y: rest.y,
          };
          position.stopAnimation();
          Animated.spring(position, {
            toValue: origin.current,
            velocity: { x: g.vx * 1000, y: g.vy * 1000 },
            speed: 14,
            bounciness: Math.min(18, 6 + Math.abs(g.vx) * 10),
            useNativeDriver: false,
          }).start(({ finished }) => {
            if (!finished) return;
            // Arrival: a short squash against the edge, like a ball landing.
            squash.setValue(Math.max(0.82, 1 - Math.abs(g.vx) * 0.12));
            Animated.spring(squash, {
              toValue: 1,
              speed: 30,
              bounciness: 14,
              useNativeDriver: false,
            }).start();
          });
          void saveTaskPreferences({ side: rest.side, fraction: rest.y / height });
          void Haptics.impactAsync(
            Math.abs(g.vx) > 0.6
              ? Haptics.ImpactFeedbackStyle.Medium
              : Haptics.ImpactFeedbackStyle.Light,
          );
        },
        onPanResponderTerminate: () => {
          // Something else took the gesture: dock where the saved place says,
          // not at whatever mid-flight point the grab froze.
          setDragging(false);
          origin.current = {
            x: preferences.side === 'left' ? -BUBBLE / 2 : width - BUBBLE / 2,
            y: Math.max(top, Math.min(bottom, height * preferences.fraction)),
          };
          Animated.spring(position, { toValue: origin.current, useNativeDriver: false }).start();
        },
      }),
    [position, squash, width, height, top, bottom, preferences.side, preferences.fraction],
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
    !intro &&
    !panel &&
    !pathname.startsWith('/onboarding') &&
    !pathname.startsWith('/search') &&
    !pathname.includes('unlock-device');
  return (
    <>
      {visible ? (
        <Animated.View
          {...pan.panHandlers}
          // The wrapper extends 22pt onto the screen past the bubble so the
          // touch target is 44pt wide where it can be hit; children outside
          // a parent's bounds get no touches on Android, so slop would not do.
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: [
              {
                translateX: Animated.subtract(
                  position.x,
                  preferences.side === 'right' ? EXTEND : 0,
                ),
              },
              { translateY: position.y },
              { scaleX: squash },
              { scaleY: Animated.divide(1, squash) },
            ],
          }}
        >
          {/* Half tucked into the edge and translucent, so it reads as a handle
              rather than a button; it only comes forward while being dragged. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Capture task"
            accessibilityHint="Double tap to record a task; long press to open the task list"
            onPress={() =>
              preferences.introSeen || !preferences.loaded ? setCapture(true) : setIntro(true)
            }
            onLongPress={() => setPanel(true)}
            // The pressable spans the bubble plus the extension on the visible
            // side, so the whole 44pt the finger can reach records on tap.
            style={{
              paddingLeft: preferences.side === 'right' ? EXTEND : 0,
              paddingRight: preferences.side === 'left' ? EXTEND : 0,
            }}
          >
            <View
              style={{
                width: BUBBLE,
                height: BUBBLE,
                borderRadius: BUBBLE / 2,
                backgroundColor: theme.colors.surfaceAlt,
                borderWidth: 1,
                borderColor: theme.colors.border,
                opacity: dragging ? 1 : 0.55,
                justifyContent: 'center',
                alignItems: 'center',
                // Keep the glyph on the visible half.
                paddingLeft: preferences.side === 'right' ? 0 : BUBBLE / 2 - 2,
                paddingRight: preferences.side === 'right' ? BUBBLE / 2 - 2 : 0,
              }}
            >
              <Icon name="mic" size={16} color={theme.colors.textMuted} />
            </View>
          </Pressable>
          {count > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open Tasks, ${String(count)} open`}
              hitSlop={6}
              onPress={() => setPanel(true)}
              style={{
                position: 'absolute',
                top: -6,
                [preferences.side === 'right' ? 'left' : 'right']: EXTEND - 4,
                minWidth: 18,
                height: 18,
                paddingHorizontal: 5,
                borderRadius: 9,
                backgroundColor: theme.colors.primary,
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  color: theme.colors.onPrimary,
                  textAlign: 'center',
                  fontSize: 11,
                  fontWeight: '700',
                }}
              >
                {count}
              </Text>
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
      {intro ? (
        <QuickCaptureIntro
          onClose={() => {
            setIntro(false);
            void saveTaskPreferences({ introSeen: true });
          }}
          onStart={() => {
            setIntro(false);
            void saveTaskPreferences({ introSeen: true });
            setCapture(true);
          }}
        />
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
