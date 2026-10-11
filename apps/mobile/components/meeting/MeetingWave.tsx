import { meetingPalette } from './meetingPalette';
import { useEffect, useId, useState } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

/** Small, slow motion signals listening without competing with the meeting. */
export function MeetingWave({
  active,
  addressed = false,
}: {
  active: boolean;
  addressed?: boolean;
}) {
  const { theme } = useUnistyles();
  const colors = meetingPalette(theme.colors);
  const gradient = useId();
  const [motion] = useState(() => new Animated.Value(0));
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    motion.setValue(0);
    if (!active || reduceMotion) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(motion, { toValue: 1, duration: 2400, useNativeDriver: true }),
        Animated.timing(motion, { toValue: 0, duration: 2400, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [active, reduceMotion, motion]);
  return (
    <Animated.View
      testID="meeting-wave"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 56,
        opacity: active ? 0.75 : 0.3,
        transform: [{ scaleY: motion.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }) }],
      }}
    >
      <Svg width="100%" height="56" viewBox="0 0 600 56" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gradient} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={colors.accent} />
            <Stop offset="0.5" stopColor={addressed ? colors.accent : '#a968f3'} />
            <Stop offset="1" stopColor={addressed ? colors.accent : colors.primary} />
          </LinearGradient>
        </Defs>
        <Path
          d="M0 28 C70 28 90 20 160 20 S240 36 300 36 S360 20 440 20 S520 28 600 28"
          fill="none"
          stroke={`url(#${gradient})`}
          strokeWidth={2}
        />
      </Svg>
    </Animated.View>
  );
}
