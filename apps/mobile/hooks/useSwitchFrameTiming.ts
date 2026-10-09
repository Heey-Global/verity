import { markSessionSwitch, type SwitchTiming } from '@verity/mobile';
import { useEffect, useCallback } from 'react';
import { AppState } from 'react-native';
import { runOnJS, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { switchMeasurementOpen } from '../lib/sessionSwitchTiming';

/** UI frame callbacks are independent of JS timers, but do not prove a visible paint. */
export function useSwitchFrameTiming(trace: SwitchTiming | undefined): void {
  const elapsed = useSharedValue(0);
  const maximum = useSharedValue(0);
  const report = useCallback(
    (gap: number) => {
      if (!switchMeasurementOpen(trace)) return;
      const existing = trace!.phases.find((phase) => phase.phase === 'ui-frame-gap-max-ms');
      if (existing) existing.value = Math.max(existing.value ?? 0, gap);
      else markSessionSwitch(trace, 'ui-frame-gap-max-ms', gap);
    },
    [trace],
  );
  const frame = useFrameCallback((info) => {
    const gap = info.timeSincePreviousFrame;
    if (gap === null) return;
    elapsed.value += gap;
    maximum.value = Math.max(maximum.value, gap);
    if (elapsed.value >= 500) {
      runOnJS(report)(maximum.value);
      elapsed.value = 0;
    }
  }, false);
  useEffect(() => {
    elapsed.value = 0;
    maximum.value = 0;
    frame.setActive(switchMeasurementOpen(trace) && AppState.currentState === 'active');
    const timer = setInterval(() => {
      if (!switchMeasurementOpen(trace)) {
        frame.setActive(false);
        clearInterval(timer);
      }
    }, 250);
    const subscription = AppState.addEventListener('change', () => frame.setActive(false));
    return () => {
      clearInterval(timer);
      subscription.remove();
      frame.setActive(false);
    };
  }, [trace, frame, elapsed, maximum]);
}
