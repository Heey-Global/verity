import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from './Text';
import { tint } from './tint';

/**
 * A single choice among a few written-out answers (docs/design-system.md § 5):
 * one quiet row per option with a radio mark. Long answers wrap inside their
 * row; the recommended option carries a small tag instead of a text suffix, so
 * the answer itself reads unchanged.
 */
export function OptionList({
  options,
  selected,
  recommended,
  disabled = false,
  onSelect,
  accessibilityLabel,
}: {
  options: readonly string[];
  selected: string | undefined;
  recommended?: string;
  disabled?: boolean;
  onSelect(option: string): void;
  /** The question the options answer. */
  accessibilityLabel?: string;
}) {
  return (
    <View
      style={styles.list}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option, index) => {
        const checked = option === selected;
        const isRecommended = option === recommended;
        return (
          <Pressable
            key={`${String(index)}:${option}`}
            accessibilityRole="radio"
            accessibilityLabel={isRecommended ? `${option}, recommended` : option}
            accessibilityState={{ checked, disabled }}
            disabled={disabled}
            onPress={() => onSelect(option)}
            style={({ pressed }) => [
              styles.option,
              checked && styles.checked,
              disabled && styles.disabled,
              pressed && !disabled && styles.pressed,
            ]}
          >
            <View style={[styles.radio, checked && styles.radioChecked]}>
              {checked ? <View style={styles.radioDot} /> : null}
            </View>
            <View style={styles.body}>
              <Text variant="bodySmall">{option}</Text>
              {isRecommended ? (
                <View style={styles.tag}>
                  <Text variant="label" style={styles.tagLabel}>
                    Recommended
                  </Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checked: {
    borderColor: tint(theme.colors.action, 'border'),
    backgroundColor: tint(theme.colors.action, 'neutral'),
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  disabled: { opacity: 0.5 },
  radio: {
    width: 18,
    height: 18,
    marginTop: 1,
    borderRadius: theme.radius.pill,
    borderWidth: 1.5,
    borderColor: theme.colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioChecked: { borderColor: theme.colors.action },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.action,
  },
  body: { flex: 1, gap: theme.spacing.xs, alignItems: 'flex-start' },
  tag: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xxs,
    borderRadius: theme.radius.tag,
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
  tagLabel: { color: theme.colors.actionLabel, fontSize: theme.typography.caption.fontSize },
}));
