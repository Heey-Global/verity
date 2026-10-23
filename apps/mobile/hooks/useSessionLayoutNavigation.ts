import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef } from 'react';

interface SessionTarget {
  targetMessageId?: string;
  targetSearchQuery?: string;
  retrySecret?: string;
}

/** Keep the visible split session open when the window becomes single-pane. */
export function useSessionLayoutNavigation(
  wide: boolean,
  selectedId: string | null,
  { targetMessageId, targetSearchQuery, retrySecret }: SessionTarget,
) {
  const focused = useIsFocused();
  const previousWide = useRef(wide);
  useEffect(() => {
    const collapsed = previousWide.current && !wide;
    // Observe background resizes too: returning to the list must not reopen a
    // previously selected chat or navigate over a settings screen.
    previousWide.current = wide;
    if (!collapsed || !focused || !selectedId) return;
    router.push({
      pathname: '/session/[id]',
      params: {
        id: selectedId,
        ...(targetMessageId ? { targetMessageId } : {}),
        ...(targetSearchQuery ? { targetSearchQuery } : {}),
        ...(retrySecret ? { retrySecret } : {}),
      },
    });
  }, [wide, focused, selectedId, targetMessageId, targetSearchQuery, retrySecret]);
}
