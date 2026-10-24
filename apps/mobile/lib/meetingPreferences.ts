import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const key = 'verity.meeting.preferences';
let state = {
  /** The live transcript is shown beside the notes; off, the left column holds notes only. */
  transcript: false,
};
const listeners = new Set<() => void>();
let loaded = false;
let changed = false;

function notify(): void {
  for (const listener of listeners) listener();
}

export function useMeetingPreferences(): typeof state {
  if (!loaded) {
    loaded = true;
    void AsyncStorage.getItem(key)
      .then((data) => {
        // A change made while the stored value loads must not be overwritten by it.
        if (!data || changed) return;
        const value = JSON.parse(data) as Partial<typeof state>;
        state = { transcript: value.transcript === true };
        notify();
      })
      // An unreadable record keeps the defaults; the next change rewrites it.
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

export function setMeetingTranscriptVisible(transcript: boolean): void {
  changed = true;
  state = { ...state, transcript };
  notify();
  void AsyncStorage.setItem(key, JSON.stringify(state)).catch(() => undefined);
}
