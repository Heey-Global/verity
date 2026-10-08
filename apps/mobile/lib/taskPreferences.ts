import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
const key = 'verity.tasks.preferences';
let state = {
  enabled: true,
  side: 'right' as 'right' | 'left',
  fraction: 0.65,
  /** The first tap explains the bubble before it records. */
  introSeen: false,
  /** Offer a screenshot taken in the last two minutes in the capture card. */
  screenshots: true,
  /** The operator answered "Not now" to the in-card photo-access prompt. */
  screenshotPromptDismissed: false,
  /** Stored preferences have been read; until then the intro is not offered. */
  loaded: false,
};
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
let loaded = false;
export function useTaskPreferences(): typeof state {
  if (!loaded) {
    loaded = true;
    void AsyncStorage.getItem(key)
      .then((data) => {
        if (data) {
          const value = JSON.parse(data) as typeof state;
          state = {
            enabled: value.enabled !== false,
            side: value.side === 'left' ? 'left' : 'right',
            fraction: Math.max(0.1, Math.min(0.9, value.fraction || 0.65)),
            introSeen: value.introSeen === true,
            screenshots: value.screenshots !== false,
            screenshotPromptDismissed: value.screenshotPromptDismissed === true,
            loaded: true,
          };
        } else {
          state = { ...state, loaded: true };
        }
        notify();
      })
      .catch(() => undefined);
  }
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}
export async function saveTaskPreferences(patch: Partial<typeof state>): Promise<void> {
  const next = { ...state, ...patch };
  await AsyncStorage.setItem(key, JSON.stringify(next));
  state = next;
  notify();
}
