import {
  FALLBACK_ROW_HEIGHT,
  moveProjectIdToIndex,
  projectRowPosition,
  projectSortableRange,
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
});

describe('drag targets', () => {
  it('falls back to a nominal height for a row that has not laid out yet', () => {
    expect(projectRowPosition(['x', 'y'], 'y', {})).toBe(FALLBACK_ROW_HEIGHT);
  });

  it('moves an id and returns the same array when nothing changes', () => {
    expect(moveProjectIdToIndex(order, 'a', 3)).toEqual(['control', 'b', 'c', 'a', 'orphan']);
    expect(moveProjectIdToIndex(order, 'a', 1)).toBe(order);
    expect(moveProjectIdToIndex(order, 'missing', 0)).toBe(order);
  });
});
