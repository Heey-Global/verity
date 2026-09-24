import type { RefCallback } from 'react';
import type { View } from 'react-native';
import type { AnimatedRef } from 'react-native-reanimated';

/** Unistyles treats a callback ref's return value as a React cleanup function.
 * Animated refs return a native shadow node instead; never forward that value. */
export function projectHandleRef(ref: AnimatedRef<View>): RefCallback<View> {
  return (node) => {
    ref(node);
  };
}
