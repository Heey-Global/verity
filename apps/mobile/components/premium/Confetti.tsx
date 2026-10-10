import { useEffect, useState } from 'react';
import { AccessibilityInfo, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

function Piece({ index, width, color }: { index: number; width: number; color: string }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: 1500 });
  }, [progress]);
  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: (index * 73) % width,
    opacity: 1 - progress.value,
    transform: [
      { translateY: progress.value * (220 + (index % 5) * 35) },
      { translateX: progress.value * ((index % 3) - 1) * 50 },
      { rotate: `${progress.value * (index % 2 === 0 ? 240 : -240)}deg` },
    ],
  }));
  return (
    <Animated.View style={style}>
      <Svg width={8} height={12}>
        <Rect width={8} height={12} rx={1} fill={color} />
      </Svg>
    </Animated.View>
  );
}

export function Confetti() {
  const { width } = useWindowDimensions();
  const { theme } = useUnistyles();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (active) setVisible(!reduced);
      })
      .catch(() => undefined);
    const timer = setTimeout(() => setVisible(false), 1600);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 400 }}
    >
      {Array.from({ length: 24 }, (_, index) => (
        <Piece
          key={index}
          index={index}
          width={width}
          color={index % 2 ? theme.colors.primary : theme.colors.accent}
        />
      ))}
    </View>
  );
}
