import { connectionFailureKind, type ServerConnectionState } from '@verity/mobile';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { serverConnection } from '../lib/serverConnection';

/** How long "Connected" stays in the bar after a disruption ends. */
export const RECOVERED_NOTICE_MS = 2_500;
/**
 * How long after recovery a screen's leftover connection error stays hidden:
 * the reload the recovery triggered needs a moment to replace it, and the
 * stale error must not flash up beside "Connected".
 */
const RECOVERY_GRACE_MS = 10_000;

const subscribe = (listener: () => void) => serverConnection.subscribe(listener);
const getState = () => serverConnection.getState();

export type ConnectionView = 'connected' | 'recovered' | 'maintenance' | 'unreachable';

export function connectionView(state: ServerConnectionState, now: number): ConnectionView {
  if (state.kind !== 'connected') return state.kind;
  return state.recoveredAt !== undefined && now - state.recoveredAt < RECOVERED_NOTICE_MS
    ? 'recovered'
    : 'connected';
}

/**
 * The app's connection state for the header bar. Re-renders every second while
 * the server is away (elapsed time, countdown) and once more when the
 * "Connected" notice runs out.
 */
export function useServerConnection(): {
  state: ServerConnectionState;
  view: ConnectionView;
  now: number;
  retryNow: () => void;
} {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const [now, setNow] = useState(() => Date.now());
  const disrupted = state.kind !== 'connected';
  const recoveredAt = state.kind === 'connected' ? state.recoveredAt : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (disrupted) {
      const interval = setInterval(() => setNow(Date.now()), 1_000);
      return () => clearInterval(interval);
    }
    if (recoveredAt === undefined) return undefined;
    const remaining = recoveredAt + RECOVERED_NOTICE_MS - Date.now();
    if (remaining <= 0) return undefined;
    const timeout = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timeout);
  }, [disrupted, recoveredAt]);
  return {
    state,
    view: connectionView(state, now),
    now,
    retryNow: () => serverConnection.retryNow(),
  };
}

/** Runs `callback` each time the server answers again after a disruption. */
export function useConnectionRecovered(callback: () => void): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => serverConnection.onRecovered(() => latest.current()), []);
}

/**
 * Whether a screen's own error is the connection failure the header bar already
 * shows. Such an error is hidden instead of repeated; any other error — and a
 * connection error the monitor has not seen — stays on the screen.
 */
export function hidesConnectionError(
  error: unknown,
  state: ServerConnectionState,
  now: number = Date.now(),
): boolean {
  if (error === undefined || error === null || error === '') return false;
  if (connectionFailureKind(error) === undefined) return false;
  if (state.kind !== 'connected') return true;
  return state.recoveredAt !== undefined && now - state.recoveredAt < RECOVERY_GRACE_MS;
}

export function useHidesConnectionError(error: unknown): boolean {
  const state = useSyncExternalStore(subscribe, getState, getState);
  return hidesConnectionError(error, state);
}
