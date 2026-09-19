/**
 * Geometry for dragging a project row to a new slot in the overview.
 *
 * Every function here is a worklet: the pan gesture runs them on the UI thread
 * for each pointer move, so the dragged row tracks the finger and its
 * neighbours make room without a round trip through React. Row heights are a
 * plain record rather than a Map because that is what crosses the thread
 * boundary as a shared value.
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

/** How far the dragged row may travel from its slot: it stays inside its sortable run. */
export function projectDragBounds(
  order: readonly string[],
  id: string,
  heights: RowHeights,
  range: SortableRange,
): { min: number; max: number } {
  'worklet';
  const start = projectRowPosition(order, id, heights);
  const first = order[range.min];
  const last = order[range.max];
  if (first === undefined || last === undefined) return { min: 0, max: 0 };
  const runEnd = projectRowPosition(order, last, heights) + rowHeight(heights, last);
  return {
    min: projectRowPosition(order, first, heights) - start,
    max: Math.max(0, runEnd - rowHeight(heights, id) - start),
  };
}

/**
 * The slot the dragged row lands in when its top edge has moved by `deltaY`
 * from where it started. Resolved against the original stacking, not the
 * animated one: a neighbour is crossed when the dragged edge passes its
 * midpoint, and crossing back uses the same midpoint, so the target never
 * flickers between two slots.
 */
export function projectDragTargetIndex(
  order: readonly string[],
  id: string,
  deltaY: number,
  heights: RowHeights,
  range: SortableRange,
): number {
  'worklet';
  const start = order.indexOf(id);
  if (start < 0 || !Number.isFinite(deltaY)) return start;
  const direction = deltaY < 0 ? -1 : 1;
  let index = start;
  let distance = 0;
  while (index + direction >= range.min && index + direction <= range.max) {
    const next = index + direction;
    const height = rowHeight(heights, order[next]!);
    if (Math.abs(deltaY) < distance + height / 2) break;
    distance += height;
    index = next;
  }
  return index;
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

/**
 * How far the grabbed row's layout moves up while every group above it folds
 * its sessions away. The drag adds this back so the row stays under the finger
 * instead of sliding up with the collapse.
 */
export function projectDragStartOffset(
  order: readonly string[],
  id: string,
  expandedHeights: RowHeights,
  compactHeights: RowHeights,
): number {
  const index = order.indexOf(id);
  if (index < 0) return 0;
  let offset = 0;
  for (const rowId of order.slice(0, index)) {
    const expanded = expandedHeights[rowId];
    const compact = compactHeights[rowId];
    if (expanded !== undefined && compact !== undefined) offset += Math.max(0, expanded - compact);
  }
  return offset;
}

/** The drag in progress, shared with the UI thread. `order` is the preview the rows make room for. */
export type ProjectDrag = {
  id: string;
  /** The stacking the rows were rendered in when the drag began. */
  startOrder: readonly string[];
  /** Where the rows would be if the finger let go now. */
  order: readonly string[];
  range: SortableRange;
  /** Set once the finger let go: the row is gliding into its slot and the preview is final. */
  dropping?: boolean;
};

/**
 * Where a row wants to be, relative to its rendered slot at drag start: the
 * grabbed row follows the finger, every other row sits in its preview slot.
 */
export function projectRowTarget(
  drag: ProjectDrag | null,
  id: string,
  heights: RowHeights,
  fingerOffset: number,
): number {
  'worklet';
  if (!drag) return 0;
  if (drag.id === id) return fingerOffset;
  return (
    projectRowPosition(drag.order, id, heights) - projectRowPosition(drag.startOrder, id, heights)
  );
}

/**
 * The transform that shows a row at `visual` (its animated target) given the
 * order React currently renders. While the drag runs that order is the start
 * order, so this is `visual` itself. Once the drop commits the preview order,
 * the rendered slot moves by exactly the settled offset and the transform
 * collapses to zero in the same commit — no frame shows the row twice-moved
 * or snapped back, whichever thread wins the race to paint.
 */
export function projectRowTranslation(
  drag: ProjectDrag | null,
  id: string,
  heights: RowHeights,
  visual: number,
  renderedOrder: readonly string[],
): number {
  'worklet';
  if (!drag) return 0;
  return (
    visual -
    (projectRowPosition(renderedOrder, id, heights) -
      projectRowPosition(drag.startOrder, id, heights))
  );
}
