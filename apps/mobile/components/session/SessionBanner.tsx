import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { toneColor } from '../../theme/tokens';
import { IconButton } from '../ui/Button';

/** A one-line status strip under the session header. `action` turns it into an
 * offer rather than a statement — only for states where the operator has a lever
 * the app cannot pull for them. `onDismiss` adds an X for a message the user may
 * put away; it changes nothing but the strip's visibility. */
export function SessionBanner({
  tone,
  text,
  action,
  onDismiss,
}: {
  tone: 'attention' | 'danger';
  text: string;
  action?: { label: string; onPress: () => void };
  onDismiss?: () => void;
}) {
  const { theme } = useUnistyles();
  const color = toneColor(theme.colors, tone);
  return (
    <View style={[styles.banner, { borderLeftColor: color }]}>
      <View style={styles.bannerRow}>
        <Text style={[styles.bannerText, { color }]} numberOfLines={onDismiss ? 3 : 2}>
          {text}
        </Text>
        {action ? (
          <Pressable
            onPress={action.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Text style={[styles.bannerAction, { color }]}>{action.label}</Text>
          </Pressable>
        ) : null}
        {onDismiss ? (
          <IconButton icon="x" accessibilityLabel="Dismiss message" onPress={onDismiss} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderLeftWidth: 3,
  },
  bannerText: {
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
    // Takes the row's slack so long copy wraps to its lines instead of pushing
    // the action off the edge.
    flex: 1,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  bannerAction: {
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
    textDecorationLine: 'underline',
  },
}));
