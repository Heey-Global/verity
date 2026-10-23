import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

// Send the wide-screen viewer to the split home with this session preselected.
// Uses `dismissTo` (not `<Redirect>`/`replace`): when a home screen is already
// below in the stack — the usual case, since sessions are reached via `/new`,
// an issue, or a list tap that all sit on top of `/` — this pops
// back to that existing home instead of stacking a *second* `/`. A duplicate
// home was what surfaced the phantom "‹ Verity" back button on the home header.
// If no home exists below (e.g. a cold deep-link straight to /session/[id]),
// `dismissTo` falls back to replacing this route with `/`, exactly like the old
// redirect did. Mirrors expo-router's own <Redirect>, which fires on focus.
export function SplitScreenRedirect({
  id,
  targetMessageId,
  targetSearchQuery,
  retrySecret,
}: {
  id: string;
  targetMessageId?: string;
  targetSearchQuery?: string;
  retrySecret?: string;
}) {
  useFocusEffect(
    useCallback(() => {
      router.dismissTo({
        pathname: '/',
        params: {
          selected: id,
          ...(targetMessageId ? { targetMessageId } : {}),
          ...(targetSearchQuery ? { targetSearchQuery } : {}),
          ...(retrySecret ? { retrySecret } : {}),
        },
      });
    }, [id, retrySecret, targetMessageId, targetSearchQuery]),
  );
  return null;
}
