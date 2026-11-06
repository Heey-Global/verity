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
  Image,
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
import { useTaskCaptureGesture } from '../hooks/useTaskCaptureGesture';
import { taskCaptureGlyphOffset } from '../lib/taskCaptureMotion';

const MARK = require('../assets/brand/verity-v-mark.png') as number;
const MARK_RATIO = 240 / 168;

/** Bubble diameter; half of it sits outside the screen edge. */
const BUBBLE = 60;
/** Extra touch area on the visible side, so the target is a full 52pt. */
const EXTEND = 22;

/**
 * The V: the one way to reach Verity from any screen (docs/assistant.md). A tap
 * opens her panel listening, a hold opens it for typing, a drag docks it on the
 * other edge. A badge shows when she waits for an answer or an approval.
 */
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
            x: Math.max(-BUBBLE / 2, Math.min(width - BUBBLE / 2, origin.current.x + g.dx)),
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
          origin.current = {
            x: rest.side === 'left' ? -BUBBLE / 2 : width - BUBBLE / 2,
            y: rest.y,
          };
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
            x: preferences.side === 'left' ? -BUBBLE / 2 : width - BUBBLE / 2,
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
    !pathname.includes('unlock-device');
  return (
    <>
      {visible ? (
        <Animated.View
          {...pan.panHandlers}
          // The wrapper extends 22pt onto the screen past the bubble so the
          // touch target is 52pt wide where it can be hit; children outside
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
            ],
          }}
        >
          {/* Half tucked into the edge and translucent, so it reads as a handle
              rather than a button; it only comes forward while being dragged. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={count > 0 ? `Verity, ${String(count)} waiting for you` : 'Verity'}
            accessibilityHint="Double tap to talk to Verity; long press to type instead"
            onPressIn={gesture.onPressIn}
            onPress={gesture.onPress}
            onLongPress={gesture.onLongPress}
            delayLongPress={600}
            // The pressable spans the bubble plus the extension on the visible
            // side, so the whole 52pt the finger can reach records on tap.
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
                // A primary tint reads as a control without shouting like a
                // filled button; full strength only while it is in the hand.
                backgroundColor: tint(theme.colors.action, dragging ? 'ring' : 'fill'),
                borderWidth: 1,
                borderColor: dragging ? theme.colors.action : tint(theme.colors.action, 'border'),
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Animated.View
                style={{
                  transform: [
                    {
                      // Center within the visible portion as the circle crosses
                      // an edge; no preference change or delayed animation moves it.
                      translateX: taskCaptureGlyphOffset(position.x, width, BUBBLE),
                    },
                  ],
                }}
              >
                <Image
                  source={MARK}
                  accessibilityIgnoresInvertColors
                  style={{ width: 26, height: 26 / MARK_RATIO }}
                />
              </Animated.View>
            </View>
            {count > 0 ? (
              <View
                pointerEvents="none"
                accessible={false}
                style={{
                  position: 'absolute',
                  top: 0,
                  [preferences.side === 'right' ? 'left' : 'right']: EXTEND - 4,
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
