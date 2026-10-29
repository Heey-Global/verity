import { Animated } from 'react-native';

/** Keep the icon centered in the visible circle as it crosses either edge. */
export function taskCaptureGlyphOffset(x: Animated.Value, width: number, diameter: number) {
  return x.interpolate({
    inputRange: [-diameter / 2, 0, Math.max(1, width - diameter), width - diameter / 2],
    outputRange: [diameter / 4, 0, 0, -diameter / 4],
    extrapolate: 'clamp',
  });
}
