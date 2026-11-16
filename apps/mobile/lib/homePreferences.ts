import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * The device-local switch for the new design: Home (an inbox of everything that
 * needs the operator), the compact project list and each project's own page. Off
 * by default, and off means the app renders exactly as before, so the preview can
 * be tried and dropped per device. The record keeps its first name, `inbox`, so a
 * device that turned the earlier Home preview on keeps it on.
 */
const key = 'verity.home.preferences';
let state = { inbox: false };
const listeners = new Set<() => void>();
let loaded = false;
let changed = false;
// Whether the stored record has been read (or found missing). Until then the
// default `false` is a guess, and a route that branches on the design must wait.
let ready = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function useHomePreferences(): typeof state {
  if (!loaded) {
    loaded = true;
    void AsyncStorage.getItem(key)
      .then((data) => {
        // A change made while the stored value loads must not be overwritten by it.
        if (!data || changed) return;
        const value = JSON.parse(data) as Partial<typeof state>;
        state = { inbox: value.inbox === true };
      })
      // An unreadable record keeps the default; the next change rewrites it.
      .catch(() => undefined)
      .finally(() => {
        ready = true;
        notify();
      });
  }
  return useSyncExternalStore(subscribe, () => state);
}

/** Whether this device shows the new design (Settings › This app). */
export function useNewDesign(): boolean {
  return useHomePreferences().inbox;
}

/**
 * The same switch for a route that renders one design or the other outright:
 * `undefined` until the stored choice is known, so a deep link does not land on
 * the old screen for a device that has the preview on.
 */
export function useNewDesignChoice(): boolean | undefined {
  const inbox = useNewDesign();
  const known = useSyncExternalStore(subscribe, () => ready || changed);
  return known ? inbox : undefined;
}

export function setNewDesignEnabled(inbox: boolean): void {
  changed = true;
  state = { ...state, inbox };
  notify();
  void AsyncStorage.setItem(key, JSON.stringify(state)).catch(() => undefined);
}
