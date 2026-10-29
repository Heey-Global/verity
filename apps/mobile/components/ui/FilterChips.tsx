import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { tint } from './tint';

/**
 * A single-choice row of filter chips above a list. The selected chip is a
 * tonal `action` fill, like the primary button; the others are bordered and
 * muted. Rows scroll sideways by default; wrap keeps all options visible.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  wrap = false,
  compact = false,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  /** Keep every category visible on narrow screens and with enlarged text. */
  wrap?: boolean;
  compact?: boolean;
}) {
  const chips = (
    <>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.chip,
              compact ? styles.compact : null,
              selected ? styles.selected : null,
              pressed && !selected ? styles.pressed : null,
            ]}
          >
            <Text
              style={[
                styles.label,
                compact ? styles.compactLabel : null,
                selected ? styles.labelSelected : null,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
  return wrap ? (
    <View
      style={[styles.row, styles.wrap]}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      {chips}
    </View>
  ) : (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      {chips}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: theme.spacing.sm, paddingVertical: theme.spacing.xxs },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  compact: { paddingHorizontal: theme.spacing.sm },
  compactLabel: { ...theme.typography.bodySmall },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md + theme.spacing.xxs,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  selected: {
    borderColor: tint(theme.colors.action, 'border'),
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  label: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  labelSelected: { fontFamily: theme.fonts.bold, color: theme.colors.actionLabel },
}));
