// The session-list attention markers (#387). The PR states share the git-merge
// glyph (the "PR" anchor), colored by verdict, so a row's PR reads as one thing:
//   • CI running  → green git-merge, PULSING, no badge (on track, checks in flight)
//   • merge-ready → green git-merge + green ✓ badge (checks passed, ready)
//   • merge checking → green git-merge + green ✓ badge, PULSING (checks passed,
//     GitHub still computing mergeability)
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

// One entry per kind the marker draws. Drawing and `drawsAttentionMarker` both read
// this table, so a kind can't be drawn without the row knowing, or vice versa.
type MarkerSpec = {
  tone: 'done' | 'danger' | 'attention';
  pulsing: boolean;
  badge?: 'check' | 'x';
};
const MARKERS: Partial<Record<AttentionFlag['kind'], MarkerSpec>> = {
  pr_unknown: { tone: 'attention', pulsing: false },
  ci_running: { tone: 'done', pulsing: true },
  merge_ready: { tone: 'done', pulsing: false, badge: 'check' },
  merge_checking: { tone: 'done', pulsing: true, badge: 'check' },
  ci_failed: { tone: 'danger', pulsing: false, badge: 'x' },
  merge_blocked: { tone: 'danger', pulsing: false, badge: 'x' },
  merge_conflict: { tone: 'danger', pulsing: false, badge: 'x' },
};

/** Whether {@link AttentionMarkers} draws anything for these flags, so a caller can
 *  leave out the separator it would otherwise put in front of an empty slot. */
export function drawsAttentionMarker(flags: readonly AttentionFlag[]): boolean {
  const flag = flags[0];
  return flag !== undefined && MARKERS[flag.kind] !== undefined;
}

export function AttentionMarkers({
  flags,
  size = 15,
  inline = false,
}: {
  flags: AttentionFlag[];
  size?: number;
  /** Sit in running text (the session row's second line) instead of the fixed
   *  34px column slot; only the badge's overhang is reserved. */
  inline?: boolean;
}) {
  const { theme } = useUnistyles();
  // Show only the SINGLE highest-priority marker (flags are priority-ordered:
  // merge_conflict > ci_failed > merge_blocked > merge_ready > merge_checking > ci_running > unread). One icon per row keeps the
  // trailing column clean and aligned under the project ⋯ — two side-by-side icons
  // read as clutter.
  const flag = flags[0];
  const spec = flag ? MARKERS[flag.kind] : undefined;
  if (!flag || !spec) return null;
  const color = theme.colors.tone[spec.tone];
  return (
    <View
      style={inline ? styles.inline : styles.slot}
      accessibilityRole="image"
      accessibilityLabel={flag.label}
    >
      <PrMarker
        size={size}
        color={color}
        pulsing={spec.pulsing}
        {...(spec.badge ? { badge: { icon: spec.badge, color } } : {})}
      />
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
  inline: {
    // The badge overhangs the glyph's top-right corner by 5px.
    paddingRight: 5,
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
