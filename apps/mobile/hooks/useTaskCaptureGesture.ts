import { useCallback, useRef } from 'react';
import type { GestureResponderEvent } from 'react-native';

/** A drag or a completed hold must never turn into a recording on release. */
export function useTaskCaptureGesture(onCapture: () => void, onOpenTasks: () => void) {
  const consumed = useRef(false);
  const claimDrag = useCallback((dx: number, dy: number) => {
    if (Math.hypot(dx, dy) <= 8) return false;
    consumed.current = true;
    return true;
  }, []);

  return {
    claimDrag,
    onPressIn: () => {
      consumed.current = false;
    },
    onPress: (event?: GestureResponderEvent) => {
      // Accessibility clicks have no touch identifier or pointer type and must
      // remain available after a completed drag or hold.
      const nativeEvent = event?.nativeEvent;
      const isPointer =
        nativeEvent && ('identifier' in nativeEvent || 'pointerType' in nativeEvent);
      if (consumed.current && isPointer) return;
      onCapture();
    },
    onLongPress: () => {
      if (consumed.current) return;
      consumed.current = true;
      onOpenTasks();
    },
  };
}
