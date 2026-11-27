/** The coverage checks of one view (see `subscribeLiveRefresh`), run again
 * when what the view shows changes. */
export function createCoverageRechecks(): {
  register: (recheck: () => void) => () => void;
  run: () => void;
} {
  const rechecks = new Set<() => void>();
  return {
    register: (recheck) => {
      rechecks.add(recheck);
      return () => {
        rechecks.delete(recheck);
      };
    },
    run: () => {
      for (const recheck of [...rechecks]) recheck();
    },
  };
}
