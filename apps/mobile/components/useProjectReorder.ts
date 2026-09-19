import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import {
  moveProjectIdToIndex,
  projectDragBounds,
  projectDragStartOffset,
  projectDragTargetIndex,
  projectRowPosition,
  projectRowTarget,
  projectRowTranslation,
  projectSortableRange,
  type ProjectDrag,
  type RowHeights,
} from '../lib/projectReorder';
import { PROJECT_SESSIONS_COLLAPSE_DURATION_MS } from './ProjectSessionsCollapse';

/** Hold before a press turns into a drag; a shorter hold reads as a scroll that stuck. */
export const PROJECT_DRAG_ACTIVATION_MS = 260;
/** The released row glides into its slot for this long before the order commits. */
export const PROJECT_DROP_DURATION_MS = 180;
/** A drop whose animation never reports back is committed after this instead. */
export const PROJECT_DROP_WATCHDOG_MS = PROJECT_DROP_DURATION_MS + 200;
/** Movement before the hold elapses is a scroll, so the drag steps aside for it. */
const PROJECT_DRAG_FAIL_DISTANCE = 12;
/** How long the row lifts when picked up and settles back on release. */
const LIFT_DURATION_MS = 150;
const LIFT_SCALE = 1.02;
/** Neighbours slide into their preview slot with a firm, non-overshooting spring. */
const SLOT_SPRING = { damping: 30, stiffness: 320, mass: 1, overshootClamping: true };

export type ProjectReorderController = {
  drag: SharedValue<ProjectDrag | null>;
  /** How far the grabbed row sits from its rendered slot: finger travel plus collapse compensation. */
  offset: SharedValue<number>;
  heights: SharedValue<RowHeights>;
  /** The row being dragged or dropped, as React state so the groups can fold. */
  draggingId: string | null;
  /** Compact row height (header plus separator) — reported by every row, in any state. */
  reportCompactHeight: (id: string, height: number) => void;
  /** Whole-group height while idle, so a drag knows how far the rows above will fold. */
  reportExpandedHeight: (id: string, height: number) => void;
  begin: (id: string) => void;
  /** Commit the drop. Runs once per drag however many times it is called. */
  finish: (order: readonly string[]) => void;
  /** Commit the drop after `PROJECT_DROP_WATCHDOG_MS` unless `finish` got there first. */
  armWatchdog: (order: readonly string[]) => void;
  /** Let a pickup go whose gesture ended before the pickup reached the JS thread. */
  cancelPickup: (id: string) => void;
  /** Finger travel since pickup — written by the row gesture on the UI thread. */
  travel: SharedValue<number>;
  /** Height the groups above lose as they fold, added back so the row stays under the finger. */
  shift: SharedValue<number>;
};

/**
 * Owns one drag at a time for the project overview. The gesture itself lives in
 * each row (`useProjectRowDrag`) and only ever touches shared values; React is
 * involved exactly twice — at pickup, to fold the groups, and at drop, to commit
 * the order — so pointer moves never wait on a render.
 */
export function useProjectReorder({
  order,
  sortable,
  onDrop,
}: {
  /** Ids of the rows as rendered, top to bottom. */
  order: readonly string[];
  /** The subset of `order` a drag may move; the rest stay in their slots. */
  sortable: readonly string[];
  /** The full rendered order after the drop, including pinned rows. */
  onDrop: (order: readonly string[]) => void;
}): ProjectReorderController {
  const reducedMotion = useReducedMotion();
  const drag = useSharedValue<ProjectDrag | null>(null);
  const travel = useSharedValue(0);
  const shift = useSharedValue(0);
  const offset = useDerivedValue(() => shift.value + travel.value);
  const heights = useSharedValue<RowHeights>({});
  const expandedHeights = useRef<Record<string, number>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const latest = useRef({ order, sortable, onDrop });
  latest.current = { order, sortable, onDrop };
  // Set while a drag is live or dropping; cleared by whichever of the drop
  // animation's callback and the watchdog runs first, so a commit happens once.
  const pending = useRef<{ id: string; watchdog?: ReturnType<typeof setTimeout> } | null>(null);

  // The preview order follows the grabbed row's offset, whichever of the finger
  // and the collapse compensation moved it: with tall groups folding above, the
  // row can already be past the midpoint of a neighbour before the finger moves.
  useAnimatedReaction(
    () => offset.value,
    (current) => {
      const active = drag.value;
      if (!active || active.dropping) return;
      const targetIndex = projectDragTargetIndex(
        active.startOrder,
        active.id,
        current,
        heights.value,
        active.range,
      );
      if (targetIndex === active.order.indexOf(active.id)) return;
      drag.value = {
        ...active,
        order: moveProjectIdToIndex(active.startOrder, active.id, targetIndex),
      };
    },
    [],
  );

  const reportCompactHeight = useCallback(
    (id: string, height: number) => {
      if (heights.value[id] === height) return;
      heights.value = { ...heights.value, [id]: height };
    },
    [heights],
  );
  const reportExpandedHeight = useCallback((id: string, height: number) => {
    expandedHeights.current[id] = height;
  }, []);

  const begin = useCallback(
    (id: string) => {
      if (pending.current) return;
      const { order: startOrder, sortable: sortableIds } = latest.current;
      if (!startOrder.includes(id)) return;
      pending.current = { id };
      const range = projectSortableRange(startOrder, sortableIds, id);
      const startShift = projectDragStartOffset(
        startOrder,
        id,
        expandedHeights.current,
        heights.value,
      );
      travel.value = 0;
      shift.value = 0;
      drag.value = { id, startOrder, order: startOrder, range };
      // Runs in step with the fold of the groups above, so the row neither
      // slides up with them nor jumps down ahead of them.
      shift.value =
        reducedMotion || PROJECT_SESSIONS_COLLAPSE_DURATION_MS === 0
          ? startShift
          : withTiming(startShift, {
              duration: PROJECT_SESSIONS_COLLAPSE_DURATION_MS,
              easing: Easing.inOut(Easing.ease),
            });
      setDraggingId(id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    },
    [drag, heights, reducedMotion, shift, travel],
  );

  const finish = useCallback((order: readonly string[]) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    if (current.watchdog !== undefined) clearTimeout(current.watchdog);
    latest.current.onDrop(order);
    setDraggingId(null);
  }, []);

  // The gesture can end before `begin` has run on the JS thread — a hold that
  // is released the instant it activates. `begin` then folds the groups for a
  // finger that is already gone; this runs after it (runOnJS keeps the order)
  // and lets go again, so the overview cannot stay locked in reorder mode.
  const cancelPickup = useCallback(
    (id: string) => {
      if (pending.current?.id !== id) return;
      finish(drag.value?.order ?? latest.current.order);
    },
    [drag, finish],
  );

  const armWatchdog = useCallback(
    (order: readonly string[]) => {
      const current = pending.current;
      if (!current || current.watchdog !== undefined) return;
      current.watchdog = setTimeout(() => finish(order), PROJECT_DROP_WATCHDOG_MS);
    },
    [finish],
  );

  // The commit re-renders the rows in the dropped order, which zeroes every
  // transform by construction (see projectRowTranslation). Only then may the
  // drag be forgotten; clearing it earlier would snap the rows back for a frame.
  useEffect(() => {
    if (draggingId !== null) return;
    drag.value = null;
    travel.value = 0;
    shift.value = 0;
  }, [drag, draggingId, shift, travel]);
  useEffect(
    () => () => {
      if (pending.current?.watchdog !== undefined) clearTimeout(pending.current.watchdog);
    },
    [],
  );

  return useMemo(
    () => ({
      drag,
      offset,
      travel,
      shift,
      heights,
      draggingId,
      reportCompactHeight,
      reportExpandedHeight,
      begin,
      finish,
      armWatchdog,
      cancelPickup,
    }),
    [
      armWatchdog,
      begin,
      cancelPickup,
      drag,
      draggingId,
      finish,
      heights,
      offset,
      reportCompactHeight,
      reportExpandedHeight,
      shift,
      travel,
    ],
  );
}

/**
 * The gesture and transform for one project row.
 *
 * `renderedOrder` is the order React is currently painting. The transform is
 * defined against it — not against a shared value set after the fact — so the
 * commit that reorders the rows and the transform that goes to zero land in the
 * same frame.
 */
export function useProjectRowDrag({
  id,
  reorder,
  renderedOrder,
  enabled,
}: {
  id: string;
  reorder: ProjectReorderController;
  renderedOrder: readonly string[];
  enabled: boolean;
}) {
  const { drag, offset, travel, shift, heights, begin, finish, armWatchdog, cancelPickup } =
    reorder;
  const reducedMotion = useReducedMotion();

  const target = useDerivedValue(
    () => projectRowTarget(drag.value, id, heights.value, offset.value),
    [id],
  );
  // Neighbours spring to their slot; the grabbed row is pinned to the finger.
  const visual = useSharedValue(0);
  useAnimatedReaction(
    () => target.value,
    (next, previous) => {
      if (next === previous) return;
      const current = drag.value;
      visual.value =
        !current || current.id === id || reducedMotion ? next : withSpring(next, SLOT_SPRING);
    },
    [id, reducedMotion],
  );
  const lift = useDerivedValue(
    () =>
      withTiming(drag.value?.id === id && !reducedMotion ? LIFT_SCALE : 1, {
        duration: LIFT_DURATION_MS,
      }),
    [id, reducedMotion],
  );
  const style = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateY: projectRowTranslation(
            drag.value,
            id,
            heights.value,
            visual.value,
            renderedOrder,
          ),
        },
        { scale: lift.value },
      ],
    }),
    [id, renderedOrder],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activateAfterLongPress(PROJECT_DRAG_ACTIVATION_MS)
        .failOffsetX([-PROJECT_DRAG_FAIL_DISTANCE, PROJECT_DRAG_FAIL_DISTANCE])
        .failOffsetY([-PROJECT_DRAG_FAIL_DISTANCE, PROJECT_DRAG_FAIL_DISTANCE])
        .onStart(() => {
          runOnJS(begin)(id);
        })
        .onUpdate((event) => {
          const current = drag.value;
          if (!current || current.id !== id || current.dropping) return;
          // The row stays inside its sortable run whatever the finger does.
          const bounds = projectDragBounds(current.startOrder, id, heights.value, current.range);
          travel.value = Math.min(
            bounds.max - shift.value,
            Math.max(bounds.min - shift.value, event.translationY),
          );
        })
        .onFinalize(() => {
          const current = drag.value;
          if (!current || current.id !== id) {
            runOnJS(cancelPickup)(id);
            return;
          }
          if (current.dropping) return;
          const order = current.order;
          drag.value = { ...current, dropping: true };
          runOnJS(armWatchdog)(order);
          // Freeze a collapse compensation still in flight: the slot below is
          // measured against the compact layout the glide ends in.
          const frozenShift = shift.value;
          shift.value = frozenShift;
          const rows = heights.value;
          const slot =
            projectRowPosition(order, id, rows) - projectRowPosition(current.startOrder, id, rows);
          if (reducedMotion) {
            travel.value = slot - frozenShift;
            runOnJS(finish)(order);
            return;
          }
          travel.value = withTiming(
            slot - frozenShift,
            { duration: PROJECT_DROP_DURATION_MS, easing: Easing.out(Easing.cubic) },
            () => {
              runOnJS(finish)(order);
            },
          );
        }),
    [
      armWatchdog,
      begin,
      cancelPickup,
      drag,
      enabled,
      finish,
      heights,
      id,
      reducedMotion,
      shift,
      travel,
    ],
  );

  return { gesture, style };
}
