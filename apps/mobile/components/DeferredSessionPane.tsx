import { markSessionSwitch, sessionSwitchTiming, type SwitchTiming } from '@verity/mobile';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Key this boundary by session identity so an obsolete mount cannot win a switch. */
export function DeferredSessionPane({
  sessionId,
  children,
  fallback,
}: {
  sessionId?: string;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const mountedTrace = useRef<SwitchTiming | undefined>(undefined);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const trace = sessionId ? sessionSwitchTiming(sessionId) : undefined;
    mountedTrace.current = trace;
    const mark = (phase: string) => markSessionSwitch(trace, phase);
    mark('deferred-pane-effect');
    let cancelled = false;
    // A single frame callback runs before drawing. Leave a frame opportunity for
    // selection feedback before mounting the chat; this is not a paint guarantee.
    let frame = requestAnimationFrame(() => {
      if (cancelled) return;
      mark('deferred-pane-first-frame');
      frame = requestAnimationFrame(() => {
        if (!cancelled) {
          mark('deferred-pane-second-frame');
          mark('deferred-pane-ready-dispatch');
          setReady(true);
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [sessionId]);
  useEffect(() => {
    if (ready && sessionId) markSessionSwitch(mountedTrace.current, 'deferred-pane-ready-commit');
  }, [ready, sessionId]);
  return ready ? children : fallback;
}
