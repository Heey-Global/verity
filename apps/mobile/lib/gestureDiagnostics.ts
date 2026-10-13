import { useSyncExternalStore } from 'react';

/** Where a recorded gesture event came from. */
type GestureSource = 'row' | 'swipe' | 'reorder';

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
let enabled = false;
let startedAt = 0;
let dropped = 0;
let events: GestureEvent[] = [];
const rowNumbers = new Map<string, number>();
const listeners = new Set<() => void>();

const now = () => globalThis.performance?.now?.() ?? Date.now();

export function gestureDiagnosticsEnabled(): boolean {
  return enabled;
}

export function setGestureDiagnosticsEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  // Switching off discards what was collected, so nothing lingers in memory.
  events = [];
  dropped = 0;
  rowNumbers.clear();
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
  if (events.length >= MAX_EVENTS) {
    events.shift();
    dropped++;
  }
  events.push({
    at: new Date().toISOString(),
    elapsedMs: Math.round(now() - startedAt),
    ...entry,
  });
}

export function exportGestureDiagnostics(): {
  enabled: boolean;
  dropped: number;
  events: GestureEvent[];
} {
  return { enabled, dropped, events: [...events] };
}
