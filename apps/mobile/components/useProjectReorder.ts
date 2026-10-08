import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, type View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  measure,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withSpring,
  type AnimatedRef,
} from 'react-native-reanimated';

import { projectHandleRef } from '../lib/projectHandleRef';

import {
  moveProjectIdToIndex,
  projectRowPosition,
  projectSortableRange,
  type ProjectDrag,
  type RowHeights,
} from '../lib/projectReorder';

type Header = {
  id: string;
  scope?: string;
  row: AnimatedRef<View>;
  handle: AnimatedRef<View>;
  slot: AnimatedRef<View>;
};
type Pickup = {
  hostTop: number;
  token: number;
  left: number;
  top: number;
  width: number;
  height: number;
  fingerY: number;
};
const SLOT_SPRING = { damping: 30, stiffness: 320, overshootClamping: true };

/** One recognizer on the fixed viewport owns the entire touch sequence. Neither
 * recycling a cell nor changing the content size can detach that recognizer. */
export function useProjectReorder({
  order,
  sortable,
  onDrop,
  sessionOrders = {},
  onDropSession,
}: {
  order: readonly string[];
  sortable: readonly string[];
  onDrop: (order: readonly string[]) => void;
  sessionOrders?: Readonly<Record<string, readonly string[]>>;
  onDropSession?: (scope: string, order: readonly string[]) => void;
}) {
  const hostRef = useAnimatedRef<View>();
  const listRef = useAnimatedRef<React.Component>();
  const drag = useSharedValue<ProjectDrag | null>(null);
  const pickup = useSharedValue<Pickup | null>(null);
  const sessionOverlayReady = useSharedValue<number | null>(null);
  const fingerY = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const heights = useSharedValue<RowHeights>({});
  const sequence = useSharedValue(0);
  const source = useDerivedValue(() => ({ order, sortable, sessionOrders }));
  const [headers, setHeaders] = useState<Header[]>([]);
  const registeredHeaders = useDerivedValue(() => headers);
  const [active, setActive] = useState<{ id: string | null; token: number; scope?: string } | null>(
    null,
  );
  const activeRef = useRef<{ id: string; token: number } | null>(null);
  const completedToken = useRef(0);
  const latestDrop = useRef(onDrop);
  latestDrop.current = onDrop;
  const latestSessionDrop = useRef(onDropSession);
  latestSessionDrop.current = onDropSession;
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const register = useCallback((header: Header) => {
    setHeaders((current) => [...current, header]);
    return () => setHeaders((current) => current.filter((entry) => entry !== header));
  }, []);
  const reportCompactHeight = useCallback(
    (id: string, height: number) => {
      if (heights.value[id] !== height) heights.value = { ...heights.value, [id]: height };
    },
    [heights],
  );
  const started = useCallback(
    (id: string, token: number) => {
      if (drag.value?.token !== token || token <= completedToken.current) return;
      activeRef.current = { id, token };
      setActive({
        id,
        token,
        ...(drag.value.scope !== undefined ? { scope: drag.value.scope } : {}),
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    },
    [drag],
  );
  const ended = useCallback((next: readonly string[] | null, token: number, scope?: string) => {
    if (token <= completedToken.current) return;
    completedToken.current = token;
    if (activeRef.current?.token === token) activeRef.current = null;
    setActive((current) => (current?.token === token ? { id: null, token } : current));
    if (next) {
      if (scope !== undefined) latestSessionDrop.current?.(scope, next);
      else latestDrop.current(next);
    }
  }, []);
  // Keep the final compact slot until React commits the new order. Clearing it
  // in finalize starts a return spring against the old layout before that commit.
  useLayoutEffect(() => {
    if (active?.id !== null) return;
    const current = drag.value;
    if (current?.dropping && current.token === active.token) drag.value = null;
  }, [active, drag]);
  const confirmSessionOverlay = useCallback(
    (token: number) => {
      if (drag.value?.token === token && !drag.value.dropping) sessionOverlayReady.value = token;
    },
    [drag, sessionOverlayReady],
  );
  const cancel = useCallback(() => {
    const current = drag.value ?? activeRef.current;
    if (!current) return;
    drag.value = null;
    pickup.value = null;
    sessionOverlayReady.value = null;
    ended(null, current.token);
  }, [drag, pickup, ended, sessionOverlayReady]);

  // A native interruption must not leave React's scroll lock behind, even if
  // the platform loses a recognizer callback while backgrounding the app.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') cancel();
    });
    return () => {
      subscription.remove();
      clearTimeout(fallback.current);
    };
  }, [cancel]);
  const releaseFallback = useCallback(() => {
    const token = drag.value?.token ?? activeRef.current?.token;
    clearTimeout(fallback.current);
    fallback.current = setTimeout(() => {
      if (token !== undefined && (drag.value?.token ?? activeRef.current?.token) === token)
        cancel();
    }, 250);
  }, [cancel, drag]);

  const updateTarget = useCallback(() => {
    'worklet';
    const current = drag.value;
    const origin = pickup.value;
    if (!current || current.dropping || !origin) return;
    const screenTop = origin.hostTop + origin.top + fingerY.value - origin.fingerY;
    let index = current.order.indexOf(current.id);
    let distance = Infinity;
    // Measure untransformed slots, not the animated neighbours. Prefix sums of
    // estimated offscreen row heights drift badly in a long virtualized list.
    for (const header of registeredHeaders.value) {
      if (header.scope !== current.scope) continue;
      const candidate = current.startOrder.indexOf(header.id);
      if (candidate < current.range.min || candidate > current.range.max) continue;
      const slot = measure(header.slot);
      if (!slot || slot.height <= 0) continue;
      const nextDistance = Math.abs(slot.pageY - screenTop);
      if (nextDistance < distance) {
        distance = nextDistance;
        index = candidate;
      }
    }
    if (index !== current.order.indexOf(current.id)) {
      drag.value = {
        ...current,
        order: moveProjectIdToIndex(current.startOrder, current.id, index),
      };
    }
  }, [drag, pickup, fingerY, registeredHeaders]);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
    updateTarget();
  });
  // Keep destinations beyond the viewport reachable without moving the overlay
  // away from the finger. Native scrolling still stays locked during the drag.
  useFrameCallback((frame) => {
    if (!drag.value || drag.value.dropping || !pickup.value) return;
    updateTarget();
    const pointer = fingerY.value - pickup.value.hostTop;
    const edge = 56;
    const direction = pointer < edge ? -1 : pointer > viewportHeight.value - edge ? 1 : 0;
    if (!direction) return;
    const next = Math.max(
      0,
      Math.min(
        Math.max(0, contentHeight.value - viewportHeight.value),
        scrollY.value + direction * Math.min(frame.timeSincePreviousFrame ?? 16, 32) * 0.45,
      ),
    );
    if (next !== scrollY.value) scrollTo(listRef, 0, next, false);
  });

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withTestId('project-reorder')
        .activateAfterLongPress(260)
        .failOffsetX([-12, 12])
        .failOffsetY([-12, 12])
        .maxPointers(1)
        .shouldCancelWhenOutside(false)
        .onTouchesDown((event, manager) => {
          const touch = event.allTouches[0];
          const hit =
            touch &&
            registeredHeaders.value.some((header) => {
              const allowed =
                header.scope === undefined
                  ? source.value.sortable
                  : (source.value.sessionOrders[header.scope] ?? []);
              if (!allowed.includes(header.id)) return false;
              const bounds = measure(header.handle);
              return (
                bounds !== null &&
                touch.absoluteX >= bounds.pageX &&
                touch.absoluteX <= bounds.pageX + bounds.width &&
                touch.absoluteY >= bounds.pageY &&
                touch.absoluteY <= bounds.pageY + bounds.height
              );
            });
          if (!hit) manager.fail();
        })
        // Native touch events survive the Pressable responder cancellation at
        // pickup. React onTouchCancel does not: using it would abort a healthy
        // drag as soon as this pan recognizer takes ownership of the touch.
        .onTouchesUp(() => runOnJS(releaseFallback)())
        .onTouchesCancelled(() => runOnJS(releaseFallback)())
        .onStart((event) => {
          if (drag.value && !drag.value.dropping) return;
          const host = measure(hostRef);
          if (!host) return;
          for (const header of registeredHeaders.value) {
            const allowed =
              header.scope === undefined
                ? source.value.sortable
                : (source.value.sessionOrders[header.scope] ?? []);
            if (!allowed.includes(header.id)) continue;
            const handle = measure(header.handle);
            if (
              !handle ||
              event.absoluteX < handle.pageX ||
              event.absoluteX > handle.pageX + handle.width ||
              event.absoluteY < handle.pageY ||
              event.absoluteY > handle.pageY + handle.height
            )
              continue;
            const row = measure(header.row);
            if (!row) continue;
            const token = ++sequence.value;
            fingerY.value = event.absoluteY;
            pickup.value = {
              token,
              hostTop: host.pageY,
              top: row.pageY - host.pageY,
              left: row.pageX - host.pageX,
              width: row.width,
              height: row.height,
              fingerY: event.absoluteY,
            };
            const startOrder =
              header.scope === undefined
                ? source.value.order
                : (source.value.sessionOrders[header.scope] ?? []);
            drag.value = {
              ...(header.scope !== undefined ? { scope: header.scope } : {}),
              id: header.id,
              token,
              startOrder,
              order: startOrder,
              range: projectSortableRange(startOrder, allowed, header.id),
            };
            runOnJS(started)(header.id, token);
            break;
          }
        })
        .onUpdate((event) => {
          if (!drag.value || drag.value.dropping) return;
          fingerY.value = event.absoluteY;
          updateTarget();
        })
        .onFinalize((_event, success) => {
          const current = drag.value;
          if (!current || current.dropping) return;
          drag.value = success ? { ...current, dropping: true } : null;
          pickup.value = null;
          sessionOverlayReady.value = null;
          // Compare with pickup, not a live refresh: attention may have changed
          // the server's automatic order while the visible slots stayed frozen.
          const moved = current.order.some((id, index) => id !== current.startOrder[index]);
          runOnJS(ended)(
            success && (current.scope === undefined || moved) ? current.order : null,
            current.token,
            current.scope,
          );
        }),
    [
      registeredHeaders,
      sessionOverlayReady,
      hostRef,
      source,
      sequence,
      fingerY,
      pickup,
      drag,
      started,
      ended,
      updateTarget,
      releaseFallback,
    ],
  );

  const overlayStyle = useAnimatedStyle(() => {
    const origin = pickup.value;
    return {
      position: 'absolute',
      left: origin?.left ?? 0,
      top: origin?.top ?? 0,
      transform: [{ translateY: origin ? fingerY.value - origin.fingerY : 0 }],
      width: origin?.width ?? 0,
      ...(drag.value?.scope !== undefined ? { height: origin?.height ?? 0 } : {}),
      opacity: origin ? 1 : 0,
      zIndex: 10,
      elevation: 10,
    };
  });
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeight.value = height;
    },
    [contentHeight],
  );
  const onViewportLayout = useCallback(
    (height: number) => {
      viewportHeight.value = height;
    },
    [viewportHeight],
  );
  return useMemo(
    () => ({
      drag,
      hostRef,
      listRef,
      gesture,
      overlayStyle,
      sessionOverlayReady,
      confirmSessionOverlay,
      sessionDragToken: active?.scope !== undefined ? active.token : null,
      onScroll,
      draggingId: active?.scope === undefined ? (active?.id ?? null) : null,
      draggingSessionId: active?.scope !== undefined ? active.id : null,
      draggingSessionScope: active?.scope ?? null,
      register,
      reportCompactHeight,
      heights,
      onContentSizeChange,
      onViewportLayout,
    }),
    [
      active,
      drag,
      hostRef,
      listRef,
      gesture,
      overlayStyle,
      sessionOverlayReady,
      confirmSessionOverlay,
      onScroll,
      register,
      reportCompactHeight,
      heights,
      onContentSizeChange,
      onViewportLayout,
    ],
  );
}

export type ProjectReorderController = ReturnType<typeof useProjectReorder>;

/** Rows are only hit-test targets and drop slots; no row owns a recognizer. */
export function useProjectRowDrag({
  id,
  reorder,
  renderedOrder,
  enabled,
  floating = false,
  scope,
}: {
  id: string;
  reorder: ProjectReorderController;
  renderedOrder: readonly string[];
  enabled: boolean;
  floating?: boolean;
  scope?: string;
}) {
  const slotRef = useAnimatedRef<View>();
  const rowRef = useAnimatedRef<View>();
  const handleRef = useAnimatedRef<View>();
  const handleCallbackRef = useMemo(() => projectHandleRef(handleRef), [handleRef]);
  const { register, drag, heights, sessionOverlayReady } = reorder;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (enabled && !floating)
      return register({
        id,
        row: rowRef,
        handle: handleRef,
        slot: slotRef,
        ...(scope !== undefined ? { scope } : {}),
      });
  }, [enabled, floating, id, register, rowRef, handleRef, slotRef, scope]);
  const visual = useDerivedValue(() => {
    const current = drag.value;
    if (!current || floating || current.scope !== scope) return 0;
    const target =
      projectRowPosition(current.order, id, heights.value) -
      projectRowPosition(current.startOrder, id, heights.value);
    // Settle unfinished neighbour springs at release. The subtraction below
    // then removes the same displacement in the render that commits the order.
    return reducedMotion || current.dropping || current.id === id
      ? target
      : withSpring(target, SLOT_SPRING);
  });
  const displacement = useDerivedValue(() => {
    const current = drag.value?.scope === scope ? drag.value : null;
    return !current || floating
      ? 0
      : visual.value -
          (projectRowPosition(renderedOrder, id, heights.value) -
            projectRowPosition(current.startOrder, id, heights.value));
  });
  const style = useAnimatedStyle(() => {
    const current = drag.value?.scope === scope ? drag.value : null;
    return {
      // Never hide a session before its replacement has completed native layout.
      opacity:
        !floating &&
        current?.id === id &&
        !current.dropping &&
        (scope === undefined || sessionOverlayReady.value === current.token)
          ? 0
          : 1,
      transform: [{ translateY: displacement.value }],
    };
  });
  const placeholderStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: displacement.value }],
  }));
  return { slotRef, rowRef, handleCallbackRef, style, placeholderStyle };
}

/** Keep worklet inputs stable when a poll or unread update leaves the order intact. */
export function useSessionDragOrder(sessions: readonly { sessionId: string }[]): readonly string[] {
  const order = useRef<readonly string[]>([]);
  if (
    order.current.length !== sessions.length ||
    sessions.some((session, index) => order.current[index] !== `session:${session.sessionId}`)
  ) {
    order.current = sessions.map((session) => `session:${session.sessionId}`);
  }
  return order.current;
}
