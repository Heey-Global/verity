import { AppState } from 'react-native';
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
  startStallSampling(trace);
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
  | 'list-item-elements'
  | 'transcript-row-body'
  | 'markdown-body';
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
const completedLists = new WeakSet<SwitchTiming>();
const noop = () => undefined;

/** Completion must survive a full phase buffer, which can drop the visible marker. */
export function markInitialListLoad(trace: SwitchTiming | undefined): void {
  if (!trace || completedLists.has(trace)) return;
  if (sessionSwitchTiming(trace.sessionId) === trace) stopSampling?.(true);
  completedLists.add(trace);
  markSessionSwitch(trace, 'flash-list-on-load');
}

function listCompleted(trace: SwitchTiming): boolean {
  return completedLists.has(trace) || trace.phases.some((p) => p.phase === 'flash-list-on-load');
}

/** Synchronous work only: excludes descendant rendering, effects, layout and paint.
 * Totals stop at the initial list load and include interrupted render attempts.
 */
export function beginRenderWork(
  stage: RenderWorkStage,
  sessionId = lastTouchedSessionId,
): () => void {
  const trace = sessionId ? sessionSwitchTiming(sessionId) : undefined;
  if (!trace || listCompleted(trace)) return noop;
  const started = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (sessionSwitchTiming(trace.sessionId) !== trace || listCompleted(trace)) return;
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

let stopSampling: ((flush?: boolean) => void) | undefined;
/** Timer lateness includes JS scheduling and GC; it does not identify the blocking function. */
export function startStallSampling(trace: SwitchTiming): void {
  stopSampling?.();
  if (AppState.currentState !== 'active') return;
  let expected = performance.now() + 100;
  let maximum = 0;
  let samples = 0;
  let entry: SwitchTiming['phases'][number] | undefined;
  let peakStart: SwitchTiming['phases'][number] | undefined;
  let peakEnd: SwitchTiming['phases'][number] | undefined;
  const sample = () => {
    const now = performance.now();
    const lag = Math.max(now - expected, 0);
    const newPeak = lag > maximum;
    maximum = Math.max(maximum, lag);
    if (!entry) {
      const before = trace.phases.length;
      markSessionSwitch(trace, 'js-timer-lag-max-ms', maximum);
      if (trace.phases.length > before) entry = trace.phases.at(-1);
    }
    if (entry) entry.value = Math.round(maximum * 10) / 10;
    // A maximum updated in place otherwise loses its position among client phases.
    // The interval starts at the timer deadline, not at a known blocking function.
    if (newPeak && !peakStart && trace.recorded <= 62) {
      const before = trace.phases.length;
      markSessionSwitch(trace, 'js-timer-peak-deadline-ms', 0);
      markSessionSwitch(trace, 'js-timer-peak-observed-ms', 0);
      if (trace.phases.length === before + 2) {
        peakStart = trace.phases[before];
        peakEnd = trace.phases[before + 1];
      }
    }
    if (newPeak && peakStart && peakEnd) {
      peakStart.value = Math.round((expected - trace.started) * 10) / 10;
      peakEnd.value = Math.round((now - trace.started) * 10) / 10;
    }
  };
  const stop = (flush = false) => {
    if (
      flush &&
      AppState.currentState === 'active' &&
      sessionSwitchTiming(trace.sessionId) === trace &&
      performance.now() - trace.started < 10_000
    )
      sample();
    clearInterval(timer);
    subscription.remove();
    if (stopSampling === stop) stopSampling = undefined;
  };
  const timer = setInterval(() => {
    const now = performance.now();
    if (
      sessionSwitchTiming(trace.sessionId) !== trace ||
      listCompleted(trace) ||
      now - trace.started >= 10_000
    ) {
      stop();
      return;
    }
    sample();
    expected = now + 100;
    samples++;
    if (samples >= 100) stop();
  }, 100);
  const subscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') stop();
  });
  stopSampling = stop;
}

export function switchMeasurementOpen(trace: SwitchTiming | undefined): boolean {
  return (
    !!trace &&
    sessionSwitchTiming(trace.sessionId) === trace &&
    !listCompleted(trace) &&
    performance.now() - trace.started < 10_000
  );
}

export type ClientActivity =
  | 'socket-message'
  | 'session-list-publish'
  | 'project-list-publish'
  | 'anchor-read'
  | 'anchor-parse';
const activityTotals = new WeakMap<
  SwitchTiming,
  Map<
    ClientActivity,
    { entries: SwitchTiming['phases']; total: number; maximum: number; count: number }
  >
>();

/** Durations include scheduling when used across a promise; peak endpoints locate overlap only. */
export function beginClientActivity(stage: ClientActivity): () => void {
  const trace = lastTouchedSessionId ? sessionSwitchTiming(lastTouchedSessionId) : undefined;
  if (!switchMeasurementOpen(trace)) return noop;
  const active = trace!;
  const started = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (!switchMeasurementOpen(active)) return;
    const ended = performance.now();
    const duration = ended - started;
    if (!Number.isFinite(duration) || duration < 0) return;
    let stages = activityTotals.get(active);
    if (!stages) {
      stages = new Map();
      activityTotals.set(active, stages);
    }
    let total = stages.get(stage);
    if (!total) {
      if (active.recorded > 60) return;
      const before = active.phases.length;
      for (const suffix of ['total-ms', 'count', 'peak-start-ms', 'peak-end-ms']) {
        markSessionSwitch(active, `activity-${stage}-${suffix}`, 0);
      }
      total = { entries: active.phases.slice(before), total: 0, maximum: -1, count: 0 };
      if (total.entries.length !== 4) return;
      stages.set(stage, total);
    }
    total.total += duration;
    total.count++;
    total.entries[0]!.value = Math.round(total.total * 10) / 10;
    total.entries[1]!.value = total.count;
    if (duration > total.maximum) {
      total.maximum = duration;
      total.entries[2]!.value = Math.round((started - active.started) * 10) / 10;
      total.entries[3]!.value = Math.round((ended - active.started) * 10) / 10;
    }
  };
}
