import { useMemo, type ReactNode, type RefCallback } from 'react';
import type { View } from 'react-native';
import Reanimated, { useAnimatedRef } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { projectHandleRef } from '../lib/projectHandleRef';

import { useProjectRowDrag, type ProjectReorderController } from './useProjectReorder';

/** The static slot stays measurable while its row moves on the UI thread. */
export function SessionDragSlot({
  id,
  scope,
  order,
  reorder,
  enabled,
  children,
}: {
  id: string;
  scope: string;
  order: readonly string[];
  reorder: ProjectReorderController;
  enabled: boolean;
  children: (
    handle: RefCallback<View>,
    issue: RefCallback<View>,
    markers: RefCallback<View>,
  ) => ReactNode;
}) {
  const issueRef = useAnimatedRef<View>();
  const markersRef = useAnimatedRef<View>();
  const excluded = useMemo(() => [issueRef, markersRef], [issueRef, markersRef]);
  const issueCallback = useMemo(() => projectHandleRef(issueRef), [issueRef]);
  const markersCallback = useMemo(() => projectHandleRef(markersRef), [markersRef]);
  const { slotRef, rowRef, handleCallbackRef, style, placeholderStyle } = useProjectRowDrag({
    id,
    scope,
    reorder,
    renderedOrder: order,
    enabled,
    excluded,
  });
  return (
    <Reanimated.View
      ref={slotRef}
      collapsable={false}
      onLayout={(event) => reorder.reportCompactHeight(id, event.nativeEvent.layout.height)}
    >
      {reorder.draggingSessionId === id ? (
        <Reanimated.View pointerEvents="none" style={[styles.placeholder, placeholderStyle]} />
      ) : null}
      <Reanimated.View ref={rowRef} collapsable={false} style={style}>
        {children(handleCallbackRef, issueCallback, markersCallback)}
      </Reanimated.View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  placeholder: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
