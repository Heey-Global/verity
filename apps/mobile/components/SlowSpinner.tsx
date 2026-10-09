// A small, calm "waiting" ring for places where the platform ActivityIndicator spins too
// fast and busy (the PR merge button while checks run). One thin arc turns slowly on the
// native driver, so it reads as "still working" without drawing the eye.
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

export function SlowSpinner({ size = 12, color }: { size?: number; color: string }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 1800,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.5,
        borderColor: color,
        borderTopColor: 'transparent',
        opacity: 0.8,
        transform: [{ rotate }],
      }}
    />
  );
}
