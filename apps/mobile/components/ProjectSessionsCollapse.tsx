import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

/** Retain session rows while folding so dragging cannot discard their local state. */
export function ProjectSessionsCollapse({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const height = useRef(new Animated.Value(0)).current;
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const measured = useRef(false);

  useEffect(() => {
    if (contentHeight === null) return;
    const target = collapsed ? 0 : contentHeight;
    if (!measured.current || reducedMotion) {
      measured.current = true;
      height.setValue(target);
      return;
    }
    const animation = Animated.timing(height, {
      toValue: target,
      duration: 180,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [collapsed, contentHeight, height, reducedMotion]);

  return (
    <Animated.View
      style={{
        overflow: 'hidden',
        height: contentHeight === null && !collapsed ? undefined : height,
      }}
      pointerEvents={collapsed ? 'none' : 'auto'}
      accessibilityElementsHidden={collapsed}
      importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
    >
      <View
        style={{ flexShrink: 0 }}
        onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  );
}
