import { markSessionSwitch, sessionSwitchTiming, type SwitchTiming } from '@verity/mobile';
import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { runOnJS, runOnUI, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import {
  gestureDiagnosticsEnabled,
  gestureRecordingGeneration,
  subscribeGestureDiagnostics,
} from '../lib/gestureDiagnostics';
import { switchMeasurementOpen } from '../lib/sessionSwitchTiming';

/** UI frame callbacks are independent of JS timers, but do not prove a visible paint. */
export function useSwitchFrameTiming(trace: SwitchTiming | undefined, completed = false): void {
  const generation = useSyncExternalStore(
    subscribeGestureDiagnostics,
    gestureRecordingGeneration,
    gestureRecordingGeneration,
  );
  const enabled = gestureDiagnosticsEnabled();
  const activeGeneration = useSharedValue(generation);
  const elapsed = useSharedValue(0);
  const maximum = useSharedValue(0);
  const report = useCallback(
    (gap: number) => {
      if (
        !gestureDiagnosticsEnabled() ||
        gestureRecordingGeneration() !== generation ||
        !trace ||
        sessionSwitchTiming(trace.sessionId) !== trace ||
        AppState.currentState !== 'active'
      )
        return;
      const existing = trace!.phases.find((phase) => phase.phase === 'ui-frame-gap-max-ms');
      if (existing) existing.value = Math.max(existing.value ?? 0, gap);
      else markSessionSwitch(trace, 'ui-frame-gap-max-ms', gap);
    },
    [trace, generation],
  );
  const onFrame = useCallback(
    (info: { timeSincePreviousFrame: number | null }) => {
      'worklet';
      if (!enabled || activeGeneration.value !== generation) return;
      const gap = info.timeSincePreviousFrame;
      if (gap === null) return;
      elapsed.value += gap;
      maximum.value = Math.max(maximum.value, gap);
      if (elapsed.value >= 500) {
        runOnJS(report)(maximum.value);
        elapsed.value = 0;
      }
    },
    [elapsed, maximum, report, enabled, generation, activeGeneration],
  );
  const frame = useFrameCallback(onFrame, false);
  useEffect(() => {
    activeGeneration.value = generation;
    if (!enabled) {
      frame.setActive(false);
      return;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    let subscription: ReturnType<typeof AppState.addEventListener> | undefined;
    const unsubscribe = subscribeGestureDiagnostics(() => {
      activeGeneration.value = gestureRecordingGeneration();
      frame.setActive(false);
      clearInterval(timer);
      subscription?.remove();
    });
    const flush = () => {
      frame.setActive(false);
      runOnUI(() => {
        'worklet';
        if (maximum.value > 0) runOnJS(report)(maximum.value);
      })();
    };
    if (completed) {
      flush();
      return unsubscribe;
    }
    if (!switchMeasurementOpen(trace) || AppState.currentState !== 'active') {
      frame.setActive(false);
      return unsubscribe;
    }
    elapsed.value = 0;
    maximum.value = 0;
    frame.setActive(switchMeasurementOpen(trace) && AppState.currentState === 'active');
    timer = setInterval(() => {
      if (!switchMeasurementOpen(trace)) {
        flush();
        clearInterval(timer);
      }
    }, 250);
    subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      frame.setActive(false);
      clearInterval(timer);
    });
    return () => {
      unsubscribe();
      clearInterval(timer);
      subscription?.remove();
      frame.setActive(false);
    };
  }, [trace, frame, elapsed, maximum, completed, report, enabled, generation, activeGeneration]);
}
