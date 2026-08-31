// The wizard's "Step N of M" progress indicator (#320). A thin presentational
// component: it takes the already-computed 1-based position (from
// @verity/mobile's `stepProgress`) and renders the label plus a segmented bar.
// Kept out of the step screens so every step renders an identical indicator.
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export function OnboardingProgress({ current, total }: { current: number; total: number }) {
  // Guard against a bad range so the bar never renders a negative/NaN segment.
  const safeTotal = Math.max(total, 1);
  const safeCurrent = Math.min(Math.max(current, 1), safeTotal);
  const segments = Array.from({ length: safeTotal }, (_, i) => i < safeCurrent);
  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${String(safeCurrent)} of ${String(safeTotal)}`}
      accessibilityValue={{ min: 1, max: safeTotal, now: safeCurrent }}
    >
      <Text style={styles.label}>
        Step {safeCurrent} of {safeTotal}
      </Text>
      <View style={styles.bar}>
        {segments.map((filled, i) => (
          <View key={i} style={[styles.segment, filled ? styles.segmentFilled : null]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing.sm,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  bar: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  segment: {
    flex: 1,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
  },
  segmentFilled: {
    backgroundColor: theme.colors.accent,
  },
}));
