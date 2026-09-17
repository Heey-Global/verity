import { projectDragOffsets, projectDragTargetIndex } from '../lib/projectReorder';

describe('project drag targets', () => {
  const ids = ['a', 'b', 'c'];
  const heights = new Map([
    ['a', 60],
    ['b', 100],
    ['c', 80],
  ]);

  it('crosses each neighbouring row at its midpoint, including unequal heights', () => {
    expect(projectDragTargetIndex(ids, 'a', 49, heights)).toBe(0);
    expect(projectDragTargetIndex(ids, 'a', 50, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'a', 139, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'a', 140, heights)).toBe(2);
    expect(projectDragTargetIndex(ids, 'c', -49, heights)).toBe(2);
    expect(projectDragTargetIndex(ids, 'c', -50, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'c', -130, heights)).toBe(0);
  });

  it('opens exactly one compact slot while keeping the original touch target mounted', () => {
    const offsets = projectDragOffsets(ids, ['b', 'c', 'a'], heights);
    expect(offsets.get('a')).toBe(180);
    expect(offsets.get('b')).toBe(-60);
    expect(offsets.get('c')).toBe(-60);
    expect([...projectDragOffsets(ids, ids, heights).values()]).toEqual([0, 0, 0]);
    const upward = projectDragOffsets(ids, ['c', 'a', 'b'], heights);
    expect(upward.get('c')).toBe(-160);
    expect(upward.get('a')).toBe(80);
    expect(upward.get('b')).toBe(80);
  });

  it('returns to the original slot and clamps movement at list boundaries', () => {
    expect(projectDragTargetIndex(ids, 'b', 0, heights)).toBe(1);
    expect(projectDragTargetIndex(ids, 'b', 10000, heights)).toBe(2);
    expect(projectDragTargetIndex(ids, 'b', -10000, heights)).toBe(0);
    expect(projectDragTargetIndex(ids, 'b', NaN, heights)).toBe(1);
  });
});
