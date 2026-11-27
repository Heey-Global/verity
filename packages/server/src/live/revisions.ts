/** Revisions (ADR 0033) that keep increasing across server restarts: a view
 * compares them with revisions it received from the previous process.
 *
 * One sequence for every entity, seeded by the clock. A revision per entity
 * would have to be remembered to stay above that entity's last one; a burst
 * within one millisecond runs ahead of the clock, so an entity forgotten after
 * it would start over at or below a revision it already published, and views
 * would ignore it. */
export function createRevisions(now: () => number = Date.now) {
  let highest = 0;
  return {
    next(): number {
      highest = Math.max(now(), highest + 1);
      return highest;
    },
  };
}
