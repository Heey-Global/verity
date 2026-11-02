import { useSyncExternalStore } from 'react';

/** Where a recorded gesture event came from. */
type GestureSource = 'row' | 'swipe' | 'reorder' | 'scheduling';

export type GestureEvent = {
  /** Wall clock for rough correlation with a screen recording. */
  at: string;
  /** Monotonic milliseconds since recording was switched on. */
  elapsedMs: number;
  source: GestureSource;
  event: string;
  /** `local`, `github`, … — the project kind of the touched row, when known. */
  projectKind?: string;
  /** Opaque per-recording row number; never a session ID or title. */
  row?: number;
  dx?: number;
  dy?: number;
  detail?: Record<string, string | number | boolean | null>;
};

// Off on every launch and never persisted: recording only runs between an
// explicit switch-on in Settings → Diagnostics and the next restart or switch-off.
const MAX_EVENTS = 300;
const MAX_SCHEDULING_EVENTS = 60;
type SchedulingSummary = {
  event: string;
  count: number;
  firstAt: string;
  lastAt: string;
  maxWaitMs?: number;
  maxWaitAt?: string;
  maxActualDurationMs?: number;
};
const schedulingSummaries = new Map<string, SchedulingSummary>();
let enabled = false;
let recordingGeneration = 0;
let startedAt = 0;
let dropped = 0;
let events: GestureEvent[] = [];
const rowNumbers = new Map<string, number>();
const listeners = new Set<() => void>();

const now = () => globalThis.performance?.now?.() ?? Date.now();

export function gestureDiagnosticsEnabled(): boolean {
  return enabled;
}

/** Changes on every toggle so queued probes cannot leak into another recording. */
export function gestureRecordingGeneration(): number {
  return recordingGeneration;
}

export function setGestureDiagnosticsEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  recordingGeneration++;
  // Switching off discards what was collected, so nothing lingers in memory.
  events = [];
  dropped = 0;
  rowNumbers.clear();
  schedulingSummaries.clear();
  startedAt = now();
  listeners.forEach((listener) => listener());
}

export function subscribeGestureDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGestureDiagnosticsEnabled(): boolean {
  return useSyncExternalStore(
    subscribeGestureDiagnostics,
    gestureDiagnosticsEnabled,
    gestureDiagnosticsEnabled,
  );
}

/** Maps a row key to a small number so reports can tell rows apart without naming them. */
export function gestureRowNumber(key: string): number {
  if (!enabled) return 0;
  let number = rowNumbers.get(key);
  if (number === undefined) {
    number = rowNumbers.size + 1;
    rowNumbers.set(key, number);
  }
  return number;
}

export function recordGesture(entry: Omit<GestureEvent, 'at' | 'elapsedMs'>): void {
  if (!enabled) return;
  const at = new Date().toISOString();
  if (entry.source === 'scheduling') {
    // Only fixed probe names enter the aggregate, so arbitrary event names cannot grow it.
    if (
      /^(sidebar|session)-(layout-effect|passive-effect|microtask|timer|react-profile)$/.test(
        entry.event,
      )
    ) {
      const summary = schedulingSummaries.get(entry.event) ?? {
        event: entry.event,
        count: 0,
        firstAt: at,
        lastAt: at,
      };
      summary.count++;
      summary.lastAt = at;
      const wait = entry.detail?.waitMs;
      if (
        typeof wait === 'number' &&
        Number.isFinite(wait) &&
        (summary.maxWaitMs === undefined || wait > summary.maxWaitMs)
      ) {
        summary.maxWaitMs = wait;
        summary.maxWaitAt = at;
      }
      const duration = entry.detail?.actualDuration;
      if (typeof duration === 'number' && Number.isFinite(duration))
        summary.maxActualDurationMs = Math.max(summary.maxActualDurationMs ?? 0, duration);
      schedulingSummaries.set(entry.event, summary);
    }
    const scheduling = events.filter((event) => event.source === 'scheduling');
    if (scheduling.length >= MAX_SCHEDULING_EVENTS) {
      events.splice(events.indexOf(scheduling[0]!), 1);
      dropped++;
    }
  }
  if (events.length >= MAX_EVENTS) {
    const schedulingIndex = events.findIndex((event) => event.source === 'scheduling');
    if (schedulingIndex < 0 && entry.source === 'scheduling') {
      dropped++;
      return;
    }
    events.splice(Math.max(0, schedulingIndex), 1);
    dropped++;
  }
  events.push({ at, elapsedMs: Math.round(now() - startedAt), ...entry });
}

export function exportGestureDiagnostics(): {
  enabled: boolean;
  dropped: number;
  events: GestureEvent[];
  schedulingSummaries: SchedulingSummary[];
} {
  return {
    enabled,
    dropped,
    events: events.map((event) => ({
      ...event,
      ...(event.detail ? { detail: { ...event.detail } } : {}),
    })),
    schedulingSummaries: [...schedulingSummaries.values()].map((summary) => ({ ...summary })),
  };
}
