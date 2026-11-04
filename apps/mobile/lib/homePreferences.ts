import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * The device-local switch for the new Home (an inbox of everything that needs the
 * operator, beside the project list). Off by default, and off means the overview
 * renders exactly as before, so the preview can be tried and dropped per device.
 */
const key = 'verity.home.preferences';
let state = { inbox: false };
const listeners = new Set<() => void>();
let loaded = false;
let changed = false;

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
        notify();
      })
      // An unreadable record keeps the default; the next change rewrites it.
      .catch(() => undefined);
  }
  return useSyncExternalStore(subscribe, () => state);
}

export function setHomeInboxEnabled(inbox: boolean): void {
  changed = true;
  state = { ...state, inbox };
  notify();
  void AsyncStorage.setItem(key, JSON.stringify(state)).catch(() => undefined);
}
