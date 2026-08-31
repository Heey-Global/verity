// The session-list attention markers (#387). The PR states share the git-merge
// glyph (the "PR" anchor), colored by verdict, so a row's PR reads as one thing:
//   • CI running  → green git-merge, PULSING, no badge (on track, checks in flight)
//   • merge-ready → green git-merge + green ✓ badge (checks passed, ready)
//   • merge blocked → raspberry git-merge + raspberry ✕ badge
//   • CI failed   → raspberry git-merge + raspberry ✕ badge
// (Unread is NOT here — it's the left dot in the row, see UnreadDot.) The marker sits
// in a fixed 34px slot that matches the project header's action buttons, so a session's
// icon lines up directly under the project's ⋯ / + column. Pulses come from the SHARED
// clock, so a running icon breathes in lock-step with the working dot on the left.
// Shared by the overview and project-detail rows so the two can't drift.
import type { AttentionFlag } from '@verity/mobile';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSyncedPulse } from '../lib/pulse';
import { Icon, type IconName } from './Icon';

function PrMarker({
  size,
  color,
  pulsing,
  badge,
}: {
  size: number;
  color: string;
  pulsing: boolean;
  badge?: { icon: IconName; color: string };
}) {
  const pulse = useSyncedPulse();
  // Pulse via SCALE, not opacity: a fading opacity makes a running (pulsing) icon read
  // as a DIFFERENT (dimmer) green than a static merge-ready one, even though both are
  // `tone.done`. Scaling keeps the color at full strength, so every git-merge glyph is
  // the exact same green — the running one just gently breathes in size.
  const scale = pulse.interpolate({ inputRange: [0.35, 1], outputRange: [0.82, 1] });
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={pulsing ? { transform: [{ scale }] } : undefined}>
        <Icon name="git-merge" size={size} color={color} />
      </Animated.View>
      {badge ? (
        // No background disc — the check/✕ sits directly on the row so it's the exact
        // same green as the git-merge glyph (a surface disc made it read as a different
        // tone). The top-right corner is clear of the glyph, so it stays legible.
        <View style={styles.badge}>
          <Icon name={badge.icon} size={Math.round(size * 0.6)} color={badge.color} />
        </View>
      ) : null}
    </View>
  );
}

export function AttentionMarkers({ flags, size = 15 }: { flags: AttentionFlag[]; size?: number }) {
  const { theme } = useUnistyles();
  // Show only the SINGLE highest-priority marker (flags are priority-ordered:
  // merge_conflict > ci_failed > merge_blocked > merge_ready > ci_running > unread). One icon per row keeps the
  // trailing column clean and aligned under the project ⋯ — two side-by-side icons
  // read as clutter.
  const flag = flags[0];
  if (!flag) return null;
  return (
    <View style={styles.slot} accessibilityRole="image" accessibilityLabel={flag.label}>
      {flag.kind === 'ci_running' ? (
        <PrMarker size={size} color={theme.colors.tone.done} pulsing />
      ) : flag.kind === 'merge_ready' ? (
        <PrMarker
          size={size}
          color={theme.colors.tone.done}
          pulsing={false}
          badge={{ icon: 'check', color: theme.colors.tone.done }}
        />
      ) : flag.kind === 'ci_failed' ||
        flag.kind === 'merge_blocked' ||
        flag.kind === 'merge_conflict' ? (
        <PrMarker
          size={size}
          color={theme.colors.tone.danger}
          pulsing={false}
          badge={{ icon: 'x', color: theme.colors.tone.danger }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  slot: {
    // Same box as a project action button (projectIconButton/projectOpenButton), so
    // the icon centers in the same column — a session marker sits under the project ⋯.
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    // Top-right corner: the git-merge glyph's branch/dots sit low-left, so the badge
    // sits in the freer upper-right space and doesn't overlap or look clipped.
    position: 'absolute',
    right: -5,
    top: -5,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
