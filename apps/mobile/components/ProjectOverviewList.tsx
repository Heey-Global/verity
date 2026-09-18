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
    // Session rows unfold for 180ms after drop. Native anchoring must remain
    // disabled until their geometry settles, or it can create negative offsets.
    const timeout = setTimeout(
      () => setSettling(false),
      PROJECT_SESSIONS_COLLAPSE_DURATION_MS + 40,
    );
    return () => clearTimeout(timeout);
  }, [dragging, settling]);

  const refresh = useCallback(() => {
    // A queued native refresh event may retain the callback from before drag.
    if (!lockedRef.current) void onRefresh();
  }, [onRefresh]);

  return (
    <Reanimated.FlatList
      {...props}
      CellRendererComponentStyle={({ item }: { item: T }) => ({
        zIndex: item.id === draggingProjectId ? 1 : 0,
      })}
      removeClippedSubviews={!locked}
      scrollEnabled={!locked}
      bounces={!locked}
      alwaysBounceVertical={!locked}
      maintainVisibleContentPosition={locked ? undefined : { minIndexForVisible: 0 }}
      refreshControl={
        locked ? undefined : <RefreshControl refreshing={refreshing} onRefresh={refresh} />
      }
    />
  );
}
