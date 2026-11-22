import type { CollaborationState } from '@verity/mobile';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '../../ui';
import { tint } from '../../ui/tint';

/** Reads the system's Reduce Motion setting and follows changes to it. */
function useReduceMotion(): boolean {
  // Still until the setting is known, so a moving ring never flashes first.
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
  return reduceMotion;
}

function useFrameColor(state: CollaborationState): string | null {
  const { theme } = useUnistyles();
  if (state === 'working') return theme.colors.action;
  if (state === 'answer') return theme.colors.signature;
  if (state === 'waitingForYou') return theme.colors.attention;
  return null;
}

/**
 * A peer project's tile as on its card: the initial on a neutral rounded square.
 * The tile stays neutral; only the frame and the dot carry the state, so a
 * colour never has to mean both the project and what it does. Decorative: the
 * row or sheet entry it sits in says the project and the state in words.
 */
export function CollaborationTile({
  projectName,
  state,
  size = 28,
  stacked = false,
}: {
  projectName: string;
  state: CollaborationState;
  size?: number;
  stacked?: boolean;
}) {
  const { theme } = useUnistyles();
  const frame = useFrameColor(state);
  const reduceMotion = useReduceMotion();
  const [pulse] = useState(() => new Animated.Value(1));
  const moving = state === 'working' && !reduceMotion;
  useEffect(() => {
    if (!moving) {
      pulse.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [moving, pulse]);
  return (
    <View
      testID="collaboration-tile"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.frame,
        { width: size + 6, height: size + 6 },
        stacked && styles.stacked,
        state === 'done' && styles.faded,
      ]}
    >
      {frame === null ? null : (
        <Animated.View
          testID={moving ? 'collaboration-ring-moving' : 'collaboration-ring'}
          style={[styles.ring, { borderColor: frame, opacity: pulse }]}
        />
      )}
      <View style={[styles.tile, { width: size, height: size }]}>
        <Text variant="subtitle" tone="muted" style={styles.initial}>
          {(Array.from(projectName.trim())[0] ?? '?').toUpperCase()}
        </Text>
      </View>
      {state === 'answer' ? (
        <View style={[styles.badge, { backgroundColor: theme.colors.signature }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
  },
  ring: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: theme.radius.control,
    borderWidth: 2,
  },
  stacked: { marginLeft: -8 },
  faded: { opacity: 0.7 },
  tile: {
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  initial: { fontFamily: theme.fonts.semibold },
  badge: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
    borderWidth: 1.5,
    borderColor: theme.colors.background,
  },
}));
