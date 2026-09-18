import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

export const PROJECT_SESSIONS_COLLAPSE_DURATION_MS = 180;

/**
 * Fold the session rows of a project group without unmounting them, so a drag
 * — which collapses every group for as long as it runs — cannot discard their
 * local state.
 *
 * An open group lays out at `auto` height, never at the measured number: a
 * height measured while the rows were clipped, or one that went stale while the
 * group was folded, would otherwise become the group's open height and keep the
 * sessions invisible with no way to get them back. The measurement only ever
 * feeds the fold animation, which is decoration: a stale or clipped number
 * costs one off transition, not a group that cannot be opened.
 */
export function ProjectSessionsCollapse({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const height = useRef(new Animated.Value(0)).current;
  // 'open' lays out at auto height and 'closed' at zero; 'folding' hands the
  // height to the animated value for the length of the transition only.
  const [phase, setPhase] = useState<'open' | 'closed' | 'folding'>(collapsed ? 'closed' : 'open');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const contentHeight = useRef<number | null>(null);
  const folded = useRef(collapsed);
  const animationGeneration = useRef(0);

  useEffect(() => {
    if (folded.current === collapsed) return;
    folded.current = collapsed;
    const content = contentHeight.current;
    // Nothing to animate between: settle straight into the target phase rather
    // than fold towards a height that was never measured.
    if (reducedMotion || content === null) {
      setPhase(collapsed ? 'closed' : 'open');
      return;
    }
    // A reversal continues from the height the interrupted fold reached; a fold
    // starting from a settled phase starts at that phase's own height.
    if (phaseRef.current !== 'folding') height.setValue(collapsed ? content : 0);
    setPhase('folding');
    const animation = Animated.timing(height, {
      toValue: collapsed ? 0 : content,
      duration: PROJECT_SESSIONS_COLLAPSE_DURATION_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });
    const generation = ++animationGeneration.current;
    // Commit on any outcome. An animation that ends without reporting success
    // would otherwise leave the group stranded at the height it stopped at —
    // for an opening group, that height is the fold it was meant to undo.
    animation.start(() => {
      if (animationGeneration.current === generation) {
        setPhase(collapsed ? 'closed' : 'open');
      }
    });
    return () => {
      // `stop()` may invoke the old callback after the opposite animation has
      // started. Invalidate it first so it cannot restore the superseded phase.
      if (animationGeneration.current === generation) animationGeneration.current += 1;
      animation.stop();
    };
  }, [collapsed, height, reducedMotion]);

  return (
    <Animated.View
      style={{
        overflow: 'hidden',
        height: phase === 'open' ? undefined : phase === 'closed' ? 0 : height,
      }}
      pointerEvents={collapsed ? 'none' : 'auto'}
      accessibilityElementsHidden={collapsed}
      importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
    >
      <View
        style={{ flexShrink: 0 }}
        onLayout={(event) => {
          contentHeight.current = event.nativeEvent.layout.height;
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
}
