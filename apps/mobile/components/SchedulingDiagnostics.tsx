import { Profiler, useEffect, useLayoutEffect, type ReactNode } from 'react';
import {
  gestureDiagnosticsEnabled,
  gestureRecordingGeneration,
  recordGesture,
} from '../lib/gestureDiagnostics';

/** Profiler callbacks require a profiling-enabled React build; commit probes do not. */
export function SchedulingDiagnostics({
  stage,
  children,
}: {
  stage: 'sidebar' | 'session';
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (!gestureDiagnosticsEnabled()) return;
    recordGesture({ source: 'scheduling', event: `${stage}-layout-effect` });
  });
  useEffect(() => {
    if (!gestureDiagnosticsEnabled()) return;
    recordGesture({ source: 'scheduling', event: `${stage}-passive-effect` });
    let cancelled = false;
    const generation = gestureRecordingGeneration();
    const queuedAt = performance.now();
    const record = (event: string) => {
      if (!cancelled && generation === gestureRecordingGeneration())
        recordGesture({
          source: 'scheduling',
          event: `${stage}-${event}`,
          detail: { waitMs: Math.round((performance.now() - queuedAt) * 10) / 10 },
        });
    };
    void Promise.resolve().then(() => record('microtask'));
    const timer = setTimeout(() => record('timer'), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });
  return (
    <Profiler
      id={stage}
      onRender={(_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        if (!gestureDiagnosticsEnabled()) return;
        recordGesture({
          source: 'scheduling',
          event: `${stage}-react-profile`,
          detail: { phase, actualDuration, baseDuration, startTime, commitTime },
        });
      }}
    >
      {children}
    </Profiler>
  );
}
