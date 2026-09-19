import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, type FlatListProps } from 'react-native';
import Reanimated from 'react-native-reanimated';

import { PROJECT_SESSIONS_COLLAPSE_DURATION_MS } from './ProjectSessionsCollapse';

type ProjectOverviewListProps<T extends { id: string }> = Omit<
  FlatListProps<T>,
  | 'scrollEnabled'
  | 'maintainVisibleContentPosition'
  | 'refreshControl'
  | 'onRefresh'
  | 'refreshing'
  | 'CellRendererComponent'
> & {
  draggingProjectId: string | null;
  onRefresh: () => void | Promise<void>;
  refreshing: boolean;
};

/**
 * The overview list, with everything a drag must not fight against switched off
 * for as long as the rows are in motion.
 *
 * Native visible-content anchoring reads each row's frame, and on iOS a frame
 * includes the row's transform: anchoring on a row that is being dragged would
 * feed its every move back into the scroll offset, which is how the list once
 * ended up scrolled to a blank area above its own header. It stays off until
 * the groups have unfolded again, because their unfolding moves rows too.
 *
 * The refresh control stays mounted throughout — unmounting it mid-gesture
 * shifts the content inset — and is merely disabled while the rows move.
 */
export function ProjectOverviewList<T extends { id: string }>({
  draggingProjectId,
  onRefresh,
  refreshing,
  ...props
}: ProjectOverviewListProps<T>) {
  const dragging = draggingProjectId !== null;
  const [settling, setSettling] = useState(dragging);
  const locked = dragging || settling;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (dragging) {
      setSettling(true);
      return;
    }
    if (!settling) return;
    const timeout = setTimeout(
      () => setSettling(false),
      PROJECT_SESSIONS_COLLAPSE_DURATION_MS + 40,
    );
    return () => clearTimeout(timeout);
  }, [dragging, settling]);

  const refresh = useCallback(() => {
    // A queued native refresh event may arrive after the lock was raised.
    if (!lockedRef.current) void onRefresh();
  }, [onRefresh]);

  return (
    <Reanimated.FlatList
      {...props}
      // The dragged row travels over its neighbours, not under them.
      CellRendererComponentStyle={({ item }: { item: T }) => ({
        zIndex: item.id === draggingProjectId ? 1 : 0,
      })}
      scrollEnabled={!locked}
      maintainVisibleContentPosition={locked ? undefined : { minIndexForVisible: 0 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} enabled={!locked} />
      }
    />
  );
}
