import { Animated } from 'react-native';

export const PROJECT_DROP_DURATION = 160;

/** Keep the grabbed row at the same screen position while rows above it compact. */
export function projectDragStartOffset(
  ids: readonly string[],
  projectId: string,
  expandedHeights: ReadonlyMap<string, number>,
  compactHeights: ReadonlyMap<string, number>,
): number {
  const index = ids.indexOf(projectId);
  if (index < 0) return 0;
  return ids.slice(0, index).reduce((offset, id) => {
    const compact = compactHeights.get(id);
    const expanded = expandedHeights.get(id);
    return (
      offset +
      (compact === undefined || expanded === undefined ? 0 : Math.max(0, expanded - compact))
    );
  }, 0);
}

/**
 * Animate the dragged row into the slot it was dropped in, then hand the drag
 * state back to the caller — exactly once, whatever the animation reports.
 *
 * The overview locks itself into reorder mode for the whole drag: every group
 * renders collapsed and its fold toggle is inert, and `settle` is the only way
 * out of it. A drop animation is not a reliable trigger for that: a native
 * animation ends with `finished: false` when its value is detached (the row
 * re-renders with a different animated node) or stopped (`setValue` from a
 * stray touch), it can report nothing at all once the value's native node is
 * gone, and starting it can throw outright. Every one of those left the
 * overview stuck in reorder mode with all projects collapsed and no way to
 * expand them again, recoverable only by restarting the app.
 */
export function settleProjectDrop({
  translation,
  target,
  reducedMotion,
  duration = PROJECT_DROP_DURATION,
  settle,
}: {
  translation: Animated.Value;
  target: number;
  reducedMotion: boolean;
  duration?: number;
  settle: () => void;
}): void {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const settleOnce = () => {
    if (settled) return;
    settled = true;
    if (watchdog !== undefined) clearTimeout(watchdog);
    settle();
  };
  if (reducedMotion) {
    translation.setValue(target);
    settleOnce();
    return;
  }
  try {
    Animated.timing(translation, {
      toValue: target,
      duration,
      useNativeDriver: true,
    }).start(() => settleOnce());
  } catch {
    settleOnce();
    return;
  }
  // The animation is decoration; reorder mode must end even if its completion
  // callback never arrives.
  if (!settled) watchdog = setTimeout(settleOnce, duration + 200);
}

/** Resolve movement against the original compact rows, not their animated positions. */
export function projectDragTargetIndex(
  ids: readonly string[],
  projectId: string,
  deltaY: number,
  heights: ReadonlyMap<string, number>,
): number {
  const start = ids.indexOf(projectId);
  if (start < 0 || !Number.isFinite(deltaY)) return start;
  const direction = deltaY < 0 ? -1 : 1;
  let index = start;
  let distance = 0;
  while (index + direction >= 0 && index + direction < ids.length) {
    const next = index + direction;
    const height = heights.get(ids[next]!) ?? 64;
    if (Math.abs(deltaY) < distance + height / 2) break;
    distance += height;
    index = next;
  }
  return index;
}

/** Translate compact rows into their preview slots without moving the touch target in the tree. */
export function projectDragOffsets(
  original: readonly string[],
  reordered: readonly string[],
  heights: ReadonlyMap<string, number>,
): Map<string, number> {
  const tops = new Map<string, number>();
  let top = 0;
  for (const id of original) {
    tops.set(id, top);
    top += heights.get(id) ?? 64;
  }
  const offsets = new Map<string, number>();
  top = 0;
  for (const id of reordered) {
    offsets.set(id, top - (tops.get(id) ?? top));
    top += heights.get(id) ?? 64;
  }
  return offsets;
}
