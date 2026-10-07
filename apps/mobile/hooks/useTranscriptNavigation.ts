import { useCallback, useEffect, useRef, useState } from 'react';

function targets(indices: readonly number[], cursor: number) {
  let next = -1;
  let previous = -1;
  for (const index of indices) {
    if (index < cursor) next = index;
    else if (index > cursor) {
      previous = index;
      break;
    }
  }
  return { previous, next };
}

/** Keep the exact viewport cursor without rendering for every crossed row. */
export function useTranscriptNavigation(indices: readonly number[]) {
  const oldestVisibleIndexRef = useRef(0);
  const indicesRef = useRef(indices);
  indicesRef.current = indices;
  const [navigation, setNavigation] = useState(() => targets(indices, 0));
  const navigationRef = useRef(navigation);
  const updateVisibleIndex = useCallback((index: number) => {
    oldestVisibleIndexRef.current = index;
    const next = targets(indicesRef.current, index);
    const previous = navigationRef.current;
    // A cursor crossing prose rows must not re-render the whole transcript.
    if (next.previous === previous.previous && next.next === previous.next) return;
    navigationRef.current = next;
    setNavigation(next);
  }, []);
  useEffect(() => {
    updateVisibleIndex(oldestVisibleIndexRef.current);
  }, [indices, updateVisibleIndex]);
  return {
    oldestVisibleIndexRef,
    prevUserIndex: navigation.previous,
    nextUserIndex: navigation.next,
    updateVisibleIndex,
  };
}
