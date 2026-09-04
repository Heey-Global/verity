import { useEffect } from 'react';
import { Animated } from 'react-native';

// A SINGLE shared opacity clock so every "live" indicator in the session list — the
// working dot left of a name AND a running-CI icon on the right — breathes in the
// exact same rhythm. One native-driver loop, started on first use and left running
// for the app's lifetime (cheap, off the JS thread); every consumer binds its
// `opacity` to the same value, so they can never drift out of phase.
const syncedPulse = new Animated.Value(1);

let started = false;

/** Returns the shared pulse value, ensuring its loop is running. */
export function useSyncedPulse(): Animated.Value {
  useEffect(() => {
    if (started) return;
    started = true;
    Animated.loop(
      Animated.sequence([
        Animated.timing(syncedPulse, { toValue: 0.35, duration: 750, useNativeDriver: true }),
        Animated.timing(syncedPulse, { toValue: 1, duration: 750, useNativeDriver: true }),
      ]),
    ).start();
  }, []);
  return syncedPulse;
}
