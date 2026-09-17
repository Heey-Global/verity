import { useLayoutEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

export function useProjectReorderMotion({
  dragging,
  reordering,
  offset,
  dragTranslation,
}: {
  dragging?: boolean | undefined;
  reordering?: boolean | undefined;
  offset: number;
  dragTranslation: Animated.Value;
}): Animated.Value {
  const translation = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    // The list adopts its final order at drop. Reset before paint so the new
    // position is never combined with the offset from its former slot.
    if (!reordering || dragging) {
      translation.setValue(0);
      return;
    }
    if (reducedMotion) {
      translation.setValue(offset);
      return;
    }
    const animation = Animated.spring(translation, {
      toValue: offset,
      stiffness: 300,
      damping: 30,
      mass: 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [dragging, offset, reducedMotion, reordering, translation]);

  return dragging ? dragTranslation : translation;
}
