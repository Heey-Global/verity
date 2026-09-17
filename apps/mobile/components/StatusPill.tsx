import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type StatusPillIntent = 'ready' | 'needsSetup' | 'optional' | 'transient';

export function StatusPill({
  label,
  intent,
  quiet = false,
}: {
  label: string;
  intent: StatusPillIntent;
  quiet?: boolean;
}) {
  const { theme } = useUnistyles();

  if (intent === 'optional') {
    return (
      <Text style={styles.optional} accessible accessibilityLabel={label}>
        – {label}
      </Text>
    );
  }

  const tone =
    intent === 'ready'
      ? theme.colors.tone.done
      : intent === 'needsSetup'
        ? theme.colors.tone.danger
        : theme.colors.primary;
  const glyph = intent === 'ready' ? '✓' : intent === 'needsSetup' ? '!' : undefined;

  return (
    <View
      style={[
        styles.pill,
        quiet ? styles.quiet : { borderColor: tone, backgroundColor: `${tone}1f` },
      ]}
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion={intent === 'transient' ? 'polite' : 'none'}
    >
      {intent === 'transient' ? <ActivityIndicator size="small" color={tone} /> : null}
      {glyph ? <Text style={[styles.glyph, { color: tone }]}>{glyph}</Text> : null}
      <Text style={[styles.label, quiet ? styles.quietLabel : null]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  quiet: {
    minHeight: 24,
    borderWidth: 0,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
  },
  quietLabel: {
    color: theme.colors.setup.textMuted,
    fontWeight: '400',
  },
  glyph: {
    fontSize: theme.text.xs,
    fontWeight: '800',
  },
  label: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontWeight: '700',
  },
  optional: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
}));
