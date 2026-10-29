import { useCallback, useRef } from 'react';

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
    onPress: () => {
      if (consumed.current) return;
      consumed.current = true;
      onCapture();
    },
    onLongPress: () => {
      if (consumed.current) return;
      consumed.current = true;
      onOpenTasks();
    },
  };
}
