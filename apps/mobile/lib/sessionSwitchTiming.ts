import {
  beginSessionSwitch,
  markSessionSwitch,
  sessionSwitchTiming,
  type SwitchTiming,
} from '@verity/mobile';

let lastTouchedSessionId: string | undefined;

/** Earliest JS callback, not physical touch receipt. Native timestamps use a separate clock. */
export function beginRowTouch(sessionId: string, nativeTimestamp?: number): void {
  lastTouchedSessionId = sessionId;
  const trace = beginSessionSwitch(sessionId);
  markSessionSwitch(trace, 'js-touch-start', nativeTimestamp);
}

export function rowPress(sessionId: string): void {
  lastTouchedSessionId = sessionId;
  // Accessibility/keyboard activation can reach onPress without a touch callback.
  const existing = sessionSwitchTiming(sessionId);
  const trace = existing?.phases.some((p) => p.phase === 'js-press-handler')
    ? beginSessionSwitch(sessionId)
    : (existing ?? beginSessionSwitch(sessionId));
  markSessionSwitch(trace, 'js-press-handler');
}

/** Records first render entry only; an interrupted render may never commit. */
export function markFirstSessionRender(sessionId: string, phase: string): void {
  const trace = sessionSwitchTiming(sessionId);
  if (trace && !trace.phases.some((entry) => entry.phase === phase)) {
    markSessionSwitch(trace, phase);
  }
}

export type RenderWorkStage =
  | 'home-body'
  | 'sidebar-group-body'
  | 'sidebar-row-body'
  | 'chat-body'
  | 'transcript-reconcile'
  | 'list-item-elements';
const renderTotals = new WeakMap<
  SwitchTiming,
  Map<
    RenderWorkStage,
    {
      duration: SwitchTiming['phases'][number];
      count: SwitchTiming['phases'][number];
      milliseconds: number;
    }
  >
>();
const noop = () => undefined;

/** Synchronous work only: excludes descendant rendering, effects, layout and paint.
 * Totals stop at the initial list load and include interrupted render attempts.
 */
export function beginRenderWork(
  stage: RenderWorkStage,
  sessionId = lastTouchedSessionId,
): () => void {
  const trace = sessionId ? sessionSwitchTiming(sessionId) : undefined;
  if (!trace || trace.phases.some((p) => p.phase === 'flash-list-on-load')) return noop;
  const started = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (
      sessionSwitchTiming(trace.sessionId) !== trace ||
      trace.phases.some((p) => p.phase === 'flash-list-on-load')
    )
      return;
    const duration = performance.now() - started;
    if (!Number.isFinite(duration) || duration < 0) return;
    let totals = renderTotals.get(trace);
    if (!totals) {
      totals = new Map();
      renderTotals.set(trace, totals);
    }
    let total = totals.get(stage);
    if (!total) {
      // Reserve both entries together so a full trace cannot leave a partial pair.
      if (trace.recorded > 62) return;
      markSessionSwitch(trace, `render-${stage}-total-ms`, 0);
      markSessionSwitch(trace, `render-${stage}-count`, 0);
      const [durationEntry, countEntry] = trace.phases.slice(-2);
      if (
        durationEntry?.phase !== `render-${stage}-total-ms` ||
        countEntry?.phase !== `render-${stage}-count`
      )
        return;
      total = { duration: durationEntry, count: countEntry, milliseconds: 0 };
      totals.set(stage, total);
    }
    total.milliseconds += duration;
    total.duration.value = Math.round(total.milliseconds * 10) / 10;
    total.count.value = (total.count.value ?? 0) + 1;
  };
}
