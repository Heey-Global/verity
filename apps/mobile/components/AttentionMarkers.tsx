// The session-list attention markers (#387). The PR states share the git-merge
// glyph (the "PR" anchor), colored by verdict, so a row's PR reads as one thing:
//   • CI running  → grey git-merge, no badge (checks in flight)
//   • merge checking → grey git-merge + grey ✓ badge (checks passed, GitHub still
//     computing mergeability)
//   • merge-ready → green git-merge + green ✓ badge (GitHub confirmed it can merge)
//   • merge blocked → raspberry git-merge + raspberry ✕ badge
//   • CI failed   → raspberry git-merge + raspberry ✕ badge
// Green is reserved for "the merge button is live": a still-settling PR in green read
// as mergeable while its button was off. Nothing here animates — the waiting states
// show their spinner on the PR bar's merge button instead.
// (Unread is NOT here — it's the left dot in the row, see UnreadDot.) The marker sits
// in a fixed 34px slot that matches the project header's action buttons, so a session's
// icon lines up directly under the project's ⋯ / + column.
// Shared by the overview and project-detail rows so the two can't drift.
import type { AttentionFlag } from '@verity/mobile';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from './Icon';

function PrMarker({
  size,
  color,
  badge,
}: {
  size: number;
  color: string;
  badge?: { icon: IconName; color: string };
}) {
  return (
    <View style={{ width: size, height: size }}>
      <Icon name="git-merge" size={size} color={color} />
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
  tone: 'idle' | 'done' | 'danger' | 'attention';
  badge?: 'check' | 'x';
};
const MARKERS: Partial<Record<AttentionFlag['kind'], MarkerSpec>> = {
  pr_unknown: { tone: 'attention' },
  ci_running: { tone: 'idle' },
  merge_ready: { tone: 'done', badge: 'check' },
  merge_checking: { tone: 'idle', badge: 'check' },
  ci_failed: { tone: 'danger', badge: 'x' },
  merge_blocked: { tone: 'danger', badge: 'x' },
  merge_conflict: { tone: 'danger', badge: 'x' },
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
