/**
 * Geometry for dragging a project row to a new slot in the overview.
 *
 * Everything the pan gesture needs per pointer move is a worklet, so the
 * dragged row tracks the finger and its neighbours make room on the UI thread
 * without a round trip through React. Row heights are a plain record rather
 * than a Map because that is what crosses the thread boundary as a shared
 * value.
 */
export type RowHeights = Readonly<Record<string, number>>;

export type SortableRange = { min: number; max: number };

/** Used for a row whose header has not reported a layout yet. */
export const FALLBACK_ROW_HEIGHT = 64;

function rowHeight(heights: RowHeights, id: string): number {
  'worklet';
  return heights[id] ?? FALLBACK_ROW_HEIGHT;
}

/** Top edge of `id` when the rows are stacked in `order` at their compact heights. */
export function projectRowPosition(
  order: readonly string[],
  id: string,
  heights: RowHeights,
): number {
  'worklet';
  let top = 0;
  for (const rowId of order) {
    if (rowId === id) return top;
    top += rowHeight(heights, rowId);
  }
  return top;
}

/**
 * The run of sortable rows a drag of `id` may travel through. Pinned rows — the
 * control plane, the default workspace, orphaned sessions — keep their slot, so
 * a drag never crosses one; it is boxed in by the nearest pinned row on either
 * side.
 */
export function projectSortableRange(
  order: readonly string[],
  sortable: readonly string[],
  id: string,
): SortableRange {
  'worklet';
  const start = order.indexOf(id);
  if (start < 0) return { min: 0, max: -1 };
  let min = start;
  while (min > 0 && sortable.includes(order[min - 1]!)) min -= 1;
  let max = start;
  while (max < order.length - 1 && sortable.includes(order[max + 1]!)) max += 1;
  return { min, max };
}

/** `order` with `id` moved to `index`; the same array when nothing changes. */
export function moveProjectIdToIndex(
  order: readonly string[],
  id: string,
  index: number,
): readonly string[] {
  'worklet';
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = Math.max(0, Math.min(order.length - 1, index));
  if (from === to) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** The drag in progress, shared with the UI thread. `order` is the preview the rows make room for. */
export type ProjectDrag = {
  token: number;
  /** Retained until React commits the final order, so transforms compensate its layout. */
  dropping?: boolean;
  id: string;
  /** The stacking the rows were rendered in when the drag began. */
  startOrder: readonly string[];
  /** Where the rows would be if the finger let go now. */
  order: readonly string[];
  range: SortableRange;
};
