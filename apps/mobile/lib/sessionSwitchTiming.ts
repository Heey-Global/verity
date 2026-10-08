import { beginSessionSwitch, markSessionSwitch, sessionSwitchTiming } from '@verity/mobile';

/** Earliest JS callback, not physical touch receipt. Native timestamps use a separate clock. */
export function beginRowTouch(sessionId: string, nativeTimestamp?: number): void {
  const trace = beginSessionSwitch(sessionId);
  markSessionSwitch(trace, 'js-touch-start', nativeTimestamp);
}

export function rowPress(sessionId: string): void {
  // Accessibility/keyboard activation can reach onPress without a touch callback.
  const existing = sessionSwitchTiming(sessionId);
  const trace = existing?.phases.some((p) => p.phase === 'js-press-handler')
    ? beginSessionSwitch(sessionId)
    : (existing ?? beginSessionSwitch(sessionId));
  markSessionSwitch(trace, 'js-press-handler');
}
