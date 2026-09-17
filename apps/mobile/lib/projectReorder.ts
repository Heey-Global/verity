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
