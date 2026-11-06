import { refreshTaskContext, startTaskContext, useTaskContext } from '../lib/sharedTaskContext';
import { bubbleRestingPlace, taskContext } from '@verity/mobile';
import * as Haptics from 'expo-haptics';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { subscribeVerityBaseUrl } from '../lib/client';
import { subscribeAuthToken } from '../lib/authToken';
import { subscribeBrowserSession } from '../lib/browserSession';
import { subscribeMeeting } from '../lib/liveMeetingSession';
import { subscribeFollowedRemoteMeeting } from '../lib/liveMeetingSync';
import { taskAccountScope, refreshTasks, startTasksStore, useTasks } from '../lib/tasksStore';
import { saveTaskPreferences, useTaskPreferences } from '../lib/taskPreferences';
import { subscribeVerityShortcut } from '../lib/voiceShortcut';
import { useVerity } from '../lib/verityConversation';
import { subscribeTasksPanel } from '../lib/taskPanelEvents';
import { VerityPanel } from './VerityPanel';
import { startWatchInbox } from '../lib/watchCapture';
import { TasksPanel } from './TasksPanel';
import { tint } from './ui/tint';
import { VerityMark } from './VerityMark';
import { useHomeShowsVerity } from '../lib/homeVerity';
import { useTaskCaptureGesture } from '../hooks/useTaskCaptureGesture';

/** Bubble diameter: a whole circle, a full touch target on its own. */
const BUBBLE = 52;
/** Distance from the screen edge it docks to. */
const INSET = 12;

/**
 * The V: the one way to reach Verity from any screen (docs/assistant.md). A tap
 * opens her panel listening, a hold opens it for typing, a drag docks it on the
 * other edge. A badge shows when she waits for an answer or an approval.
 */
/** Where the bubble rests on `side`, a little in from the edge. */
export function dockedX(side: 'left' | 'right', width: number): number {
  return side === 'left' ? INSET : width - BUBBLE - INSET;
}

export function VerityBubble() {
  useEffect(
    () =>
      subscribeTasksPanel(() => {
        setTasksOpen(true);
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
  const homeShowsVerity = useHomeShowsVerity();
  const { tasks } = useTasks();
  const { projects, sessions, projectsScope } = useTaskContext();
  const [keyboard, setKeyboard] = useState(Keyboard.isVisible());
  const [meeting, setMeeting] = useState(false);
  const [remoteMeeting, setRemoteMeeting] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Verity's panel and how it opened; null while minimised. */
  const [verity, setVerity] = useState<'voice' | 'text' | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const gesture = useTaskCaptureGesture(
    () => setVerity('voice'),
    () => setVerity('text'),
  );
  const conversation = useVerity(false);
  const position = useRef(new Animated.ValueXY()).current;
  const origin = useRef({ x: 0, y: 0 });
  const context = taskContext(pathname, params, sessions);
  // What waits for the user: her open question, approvals, and words not sent yet.
  const count =
    (conversation.conversation?.question ? 1 : 0) +
    (conversation.conversation?.approvals.length ?? 0) +
    conversation.outbox.filter((entry) => entry.held === true).length;
  const top = insets.top + 52;
  const bottom = height - insets.bottom - 100;
  useEffect(() => {
    const next = {
      x: dockedX(preferences.side, width),
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
        onMoveShouldSetPanResponderCapture: (_, g) => gesture.claimDrag(g.dx, g.dy),
        onPanResponderGrant: () => {
          // Grabbing a bubble mid-flight: freeze it where it is and drag from there.
          position.stopAnimation((value) => {
            origin.current = value;
          });
          setDragging(true);
        },
        onPanResponderMove: (_, g) =>
          position.setValue({
            x: Math.max(0, Math.min(width - BUBBLE, origin.current.x + g.dx)),
            y: Math.max(top, Math.min(height - BUBBLE, origin.current.y + g.dy)),
          }),
        onPanResponderRelease: (_, g) => {
          setDragging(false);
          // Keep the release velocity while bringing the circle and glyph
          // to their resting position together.
          const rest = bubbleRestingPlace({
            x: origin.current.x + g.dx + BUBBLE / 2,
            y: origin.current.y + g.dy,
            vx: g.vx,
            vy: g.vy,
            width,
            top,
            bottom,
          });
          origin.current = { x: dockedX(rest.side, width), y: rest.y };
          position.stopAnimation();
          Animated.spring(position, {
            toValue: origin.current,
            velocity: { x: g.vx * 1000, y: g.vy * 1000 },
            // Stop at the edge without overshoot or a second landing animation.
            tension: 38,
            friction: 12,
            overshootClamping: true,
            useNativeDriver: false,
          }).start();
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
            x: dockedX(preferences.side, width),
            y: Math.max(top, Math.min(bottom, height * preferences.fraction)),
          };
          Animated.spring(position, {
            toValue: origin.current,
            tension: 38,
            friction: 12,
            overshootClamping: true,
            useNativeDriver: false,
          }).start();
        },
      }),
    [
      position,
      width,
      height,
      top,
      bottom,
      preferences.side,
      preferences.fraction,
      gesture.claimDrag,
    ],
  );
  useEffect(() => startTasksStore(), []);
  // The Apple Watch talks to the same Verity conversation through this phone.
  useEffect(() => startWatchInbox(), []);
  useEffect(() => startTaskContext(), []);
  useEffect(() => {
    if (verity !== null || tasksOpen) void refreshTaskContext().catch(() => undefined);
  }, [verity, tasksOpen]);
  useEffect(() => {
    const reset = () => {
      setVerity(null);
      setTasksOpen(false);
    };

    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshTaskContext().catch(() => undefined);
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
  useEffect(
    () =>
      subscribeVerityShortcut((request) => {
        if (
          verity !== null ||
          taskAccountScope() === null ||
          meeting ||
          remoteMeeting ||
          pathname.startsWith('/onboarding') ||
          pathname.includes('unlock-device')
        )
          return;
        setTasksOpen(false);
        setVerity(request.mode ?? 'voice');
      }),
    [verity, meeting, remoteMeeting, pathname],
  );
  const visible =
    preferences.enabled &&
    taskAccountScope() !== null &&
    !keyboard &&
    !meeting &&
    !remoteMeeting &&
    verity === null &&
    !tasksOpen &&
    !pathname.startsWith('/onboarding') &&
    !pathname.startsWith('/search') &&
    !pathname.includes('unlock-device') &&
    // Home has her header and "Tell Verity"; a second V would sit on its cards.
    !(homeShowsVerity && pathname === '/');
  return (
    <>
      {visible ? (
        <Animated.View
          {...pan.panHandlers}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: [{ translateX: position.x }, { translateY: position.y }],
          }}
          testID="verity-bubble"
        >
          {/* A whole circle with room to the edge: Verity's V on its halo, on the
              app's surface (§ 5.8), not a cyan control tucked into the edge. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={count > 0 ? `Verity, ${String(count)} waiting for you` : 'Verity'}
            accessibilityHint="Double tap to talk to Verity; long press to type instead"
            onPressIn={gesture.onPressIn}
            onPress={gesture.onPress}
            onLongPress={gesture.onLongPress}
            delayLongPress={600}
          >
            <View
              testID="verity-bubble-circle"
              style={{
                width: BUBBLE,
                height: BUBBLE,
                borderRadius: BUBBLE / 2,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: dragging
                  ? tint(theme.colors.signature, 'border')
                  : theme.colors.border,
                justifyContent: 'center',
                alignItems: 'center',
                ...theme.elevation.floating,
              }}
            >
              <VerityMark size={40} glow={false} />
            </View>
            {count > 0 ? (
              <View
                pointerEvents="none"
                accessible={false}
                style={{
                  position: 'absolute',
                  top: 0,
                  [preferences.side === 'right' ? 'left' : 'right']: -4,
                  minWidth: 18,
                  height: 18,
                  paddingHorizontal: 5,
                  borderRadius: 9,
                  backgroundColor: theme.colors.action,
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    color: theme.colors.onAction,
                    textAlign: 'center',
                    fontSize: theme.typography.caption.fontSize,
                    fontFamily: theme.fonts.bold,
                  }}
                >
                  {count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </Animated.View>
      ) : null}
      {verity !== null ? (
        <VerityPanel mode={verity} projectId={context.projectId} onClose={() => setVerity(null)} />
      ) : null}
      {tasksOpen ? (
        <TasksPanel
          context={context}
          projects={projects}
          sessions={sessions}
          side={preferences.side}
          y={origin.current.y}
          onClose={() => setTasksOpen(false)}
          onCapture={() => {
            setTasksOpen(false);
            setVerity('text');
          }}
        />
      ) : null}
    </>
  );
}
