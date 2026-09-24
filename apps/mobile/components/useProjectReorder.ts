import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import {
  moveProjectIdToIndex,
  projectRowPosition,
  projectSortableRange,
  type ProjectDrag,
  type RowHeights,
} from '../lib/projectReorder';

type Header = {
  id: string;
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
  fingerY: number;
};
const SLOT_SPRING = { damping: 30, stiffness: 320, overshootClamping: true };

/** One recognizer on the fixed viewport owns the entire touch sequence. Neither
 * recycling a cell nor changing the content size can detach that recognizer. */
export function useProjectReorder({
  order,
  sortable,
  onDrop,
}: {
  order: readonly string[];
  sortable: readonly string[];
  onDrop: (order: readonly string[]) => void;
}) {
  const hostRef = useAnimatedRef<View>();
  const listRef = useAnimatedRef<React.Component>();
  const drag = useSharedValue<ProjectDrag | null>(null);
  const pickup = useSharedValue<Pickup | null>(null);
  const fingerY = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const heights = useSharedValue<RowHeights>({});
  const sequence = useSharedValue(0);
  const source = useDerivedValue(() => ({ order, sortable }));
  const [headers, setHeaders] = useState<Header[]>([]);
  const registeredHeaders = useDerivedValue(() => headers);
  const [active, setActive] = useState<{ id: string; token: number } | null>(null);
  const activeRef = useRef<{ id: string; token: number } | null>(null);
  const completedToken = useRef(0);
  const latestDrop = useRef(onDrop);
  latestDrop.current = onDrop;
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
      setActive({ id, token });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    },
    [drag],
  );
  const ended = useCallback((next: readonly string[] | null, token: number) => {
    if (token <= completedToken.current) return;
    completedToken.current = token;
    if (activeRef.current?.token === token) activeRef.current = null;
    setActive((current) => (current?.token === token ? null : current));
    if (next) latestDrop.current(next);
  }, []);
  const cancel = useCallback(() => {
    const current = drag.value ?? activeRef.current;
    if (!current) return;
    drag.value = null;
    pickup.value = null;
    ended(null, current.token);
  }, [drag, pickup, ended]);

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
    if (!current || !origin) return;
    const screenTop = origin.hostTop + origin.top + fingerY.value - origin.fingerY;
    let index = current.order.indexOf(current.id);
    let distance = Infinity;
    // Measure untransformed slots, not the animated neighbours. Prefix sums of
    // estimated offscreen row heights drift badly in a long virtualized list.
    for (const header of registeredHeaders.value) {
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
    if (!drag.value || !pickup.value) return;
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
              if (!source.value.sortable.includes(header.id)) return false;
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
          if (drag.value) return;
          const host = measure(hostRef);
          if (!host) return;
          for (const header of registeredHeaders.value) {
            if (!source.value.sortable.includes(header.id)) continue;
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
              fingerY: event.absoluteY,
            };
            const startOrder = source.value.order;
            drag.value = {
              id: header.id,
              token,
              startOrder,
              order: startOrder,
              range: projectSortableRange(startOrder, source.value.sortable, header.id),
            };
            runOnJS(started)(header.id, token);
            break;
          }
        })
        .onUpdate((event) => {
          if (!drag.value) return;
          fingerY.value = event.absoluteY;
          updateTarget();
        })
        .onFinalize((_event, success) => {
          const current = drag.value;
          if (!current) return;
          // Clear on the UI thread before notifying React: a fast second pickup
          // can never inherit state from the previous gesture.
          drag.value = null;
          pickup.value = null;
          runOnJS(ended)(success ? current.order : null, current.token);
        }),
    [
      registeredHeaders,
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
      opacity: origin ? 1 : 0,
      zIndex: 10,
      elevation: 10,
    };
  });
  return {
    drag,
    hostRef,
    listRef,
    gesture,
    overlayStyle,
    onScroll,
    draggingId: active?.id ?? null,
    register,
    reportCompactHeight,
    heights,
    onContentSizeChange: (_width: number, height: number) => {
      contentHeight.value = height;
    },
    onViewportLayout: (height: number) => {
      viewportHeight.value = height;
    },
  };
}

export type ProjectReorderController = ReturnType<typeof useProjectReorder>;

/** Rows are only hit-test targets and drop slots; no row owns a recognizer. */
export function useProjectRowDrag({
  id,
  reorder,
  renderedOrder,
  enabled,
  floating = false,
}: {
  id: string;
  reorder: ProjectReorderController;
  renderedOrder: readonly string[];
  enabled: boolean;
  floating?: boolean;
}) {
  const slotRef = useAnimatedRef<View>();
  const rowRef = useAnimatedRef<View>();
  const handleRef = useAnimatedRef<View>();
  const { register, drag, heights } = reorder;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (enabled && !floating)
      return register({ id, row: rowRef, handle: handleRef, slot: slotRef });
  }, [enabled, floating, id, register, rowRef, handleRef, slotRef]);
  const translation = useDerivedValue(() => {
    const current = drag.value;
    if (!current || current.id === id || floating) return 0;
    return (
      projectRowPosition(current.order, id, heights.value) -
      projectRowPosition(renderedOrder, id, heights.value)
    );
  });
  const style = useAnimatedStyle(() => ({
    opacity: !floating && drag.value?.id === id ? 0 : 1,
    transform: [
      {
        translateY: reducedMotion ? translation.value : withSpring(translation.value, SLOT_SPRING),
      },
    ],
  }));
  return { slotRef, rowRef, handleRef, style };
}
