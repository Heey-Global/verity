import {
  FALLBACK_ROW_HEIGHT,
  moveProjectIdToIndex,
  projectDragBounds,
  projectDragStartOffset,
  projectDragTargetIndex,
  projectRowPosition,
  projectRowTarget,
  projectRowTranslation,
  projectSortableRange,
  type ProjectDrag,
} from '../lib/projectReorder';

const order = ['control', 'a', 'b', 'c', 'orphan'];
const sortable = ['a', 'b', 'c'];
const heights = { control: 50, a: 60, b: 100, c: 80, orphan: 70 };
const range = projectSortableRange(order, sortable, 'a');

describe('sortable range', () => {
  // A drag that could cross the control plane or an orphan row would reorder
  // rows the server has no slot for; the target index has to stop at them.
  it('boxes a drag in between the pinned rows around it', () => {
    expect(range).toEqual({ min: 1, max: 3 });
    expect(projectSortableRange(['a', 'x', 'b'], ['a', 'b'], 'b')).toEqual({ min: 2, max: 2 });
    expect(projectSortableRange(order, sortable, 'missing')).toEqual({ min: 0, max: -1 });
  });

  it('keeps the dragged row inside its run however far the finger goes', () => {
    expect(projectDragBounds(order, 'a', heights, range)).toEqual({ min: 0, max: 180 });
    expect(projectDragBounds(order, 'c', heights, range)).toEqual({ min: -160, max: 0 });
    expect(projectDragBounds(order, 'b', heights, range)).toEqual({ min: -60, max: 80 });
  });
});

describe('drag targets', () => {
  it('crosses each neighbouring row at its midpoint, including unequal heights', () => {
    expect(projectDragTargetIndex(order, 'a', 49, heights, range)).toBe(1);
    expect(projectDragTargetIndex(order, 'a', 50, heights, range)).toBe(2);
    expect(projectDragTargetIndex(order, 'a', 139, heights, range)).toBe(2);
    expect(projectDragTargetIndex(order, 'a', 140, heights, range)).toBe(3);
    expect(projectDragTargetIndex(order, 'c', -49, heights, range)).toBe(3);
    expect(projectDragTargetIndex(order, 'c', -50, heights, range)).toBe(2);
    expect(projectDragTargetIndex(order, 'c', -130, heights, range)).toBe(1);
  });

  it('never leaves the sortable run and tolerates a non-finite offset', () => {
    expect(projectDragTargetIndex(order, 'b', 0, heights, range)).toBe(2);
    expect(projectDragTargetIndex(order, 'b', 10000, heights, range)).toBe(3);
    expect(projectDragTargetIndex(order, 'b', -10000, heights, range)).toBe(1);
    expect(projectDragTargetIndex(order, 'b', NaN, heights, range)).toBe(2);
  });

  it('falls back to a nominal height for a row that has not laid out yet', () => {
    expect(projectRowPosition(['x', 'y'], 'y', {})).toBe(FALLBACK_ROW_HEIGHT);
  });

  it('moves an id and returns the same array when nothing changes', () => {
    expect(moveProjectIdToIndex(order, 'a', 3)).toEqual(['control', 'b', 'c', 'a', 'orphan']);
    expect(moveProjectIdToIndex(order, 'a', 1)).toBe(order);
    expect(moveProjectIdToIndex(order, 'missing', 0)).toBe(order);
  });

  it('keeps the grabbed row under the finger when expanded rows above it collapse', () => {
    const expanded = { control: 50, a: 240, b: 100, c: 180 };
    expect(projectDragStartOffset(order, 'c', expanded, heights)).toBe(180);
    expect(projectDragStartOffset(order, 'a', expanded, heights)).toBe(0);
    expect(projectDragStartOffset(order, 'missing', expanded, heights)).toBe(0);
  });
});

describe('row transforms', () => {
  const drag: ProjectDrag = {
    id: 'a',
    startOrder: order,
    order: ['control', 'b', 'c', 'a', 'orphan'],
    range,
  };

  it('pins the grabbed row to the finger and opens exactly one slot for it', () => {
    const targets = order.map((id) => projectRowTarget(drag, id, heights, 173));
    expect(targets).toEqual([0, 173, -60, -60, 0]);
  });

  // The rows are painted in the start order for the whole drag, so the
  // transform is the target itself; nothing here depends on React.
  it('translates each row by its target while the start order is rendered', () => {
    for (const id of order) {
      const target = projectRowTarget(drag, id, heights, 173);
      expect(projectRowTranslation(drag, id, heights, target, order)).toBe(target);
    }
  });

  // The guard that matters: once the drop commits and React paints the preview
  // order, every settled transform must be zero in that same commit. A non-zero
  // value here is the frame where the rows appear twice-moved or snap back
  // before the drag state is cleared.
  it('collapses every transform to zero the moment the dropped order is rendered', () => {
    const settledOffset = 180;
    for (const id of order) {
      const settled = projectRowTarget(drag, id, heights, settledOffset);
      expect(projectRowTranslation(drag, id, heights, settled, drag.order)).toBe(0);
    }
    expect(projectRowTranslation(null, 'a', heights, 0, drag.order)).toBe(0);
  });
});
