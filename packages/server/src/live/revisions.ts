/** Per-entity revisions (ADR 0033) that keep increasing across server restarts:
 * a view compares them with revisions it received from the previous process. */
export function createRevisions(now: () => number = Date.now) {
  const last = new Map<string, number>();
  return {
    next(entityId: string): number {
      const rev = Math.max(now(), (last.get(entityId) ?? 0) + 1);
      last.set(entityId, rev);
      // Bounded: a forgotten entity restarts from the clock, which still
      // orders after anything it published before.
      if (last.size > 4_096) last.delete(last.keys().next().value!);
      return rev;
    },
  };
}
