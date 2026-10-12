import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { tint } from './tint';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'destructive';
export type ButtonSize = 'large' | 'compact';

/**
 * The one button (docs/design-system.md § 5.1). Primary is tonal — a quiet cyan
 * fill, never a glow — and a screen has at most one. Destructive is outlined in
 * `attention` and is only ever the confirming action of a confirmation.
 *
 * Loading keeps the label, puts a spinner in front of it and locks the button,
 * so a second tap cannot run the action twice and the button does not jump.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'large',
  icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  accessibilityLabel,
}: {
  /** A verb: "Activate", "Copy", "Remove key". */
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme } = useUnistyles();
  const locked = disabled || loading;
  const color =
    variant === 'primary'
      ? theme.colors.actionLabel
      : variant === 'secondary'
        ? theme.colors.text
        : variant === 'text'
          ? theme.colors.action
          : theme.colors.attention;
  return (
    <Pressable
      onPress={onPress}
      disabled={locked}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: locked, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        size === 'compact' ? styles.compact : styles.large,
        styles[variant],
        fullWidth ? styles.fullWidth : null,
        disabled ? styles.disabled : null,
        pressed && !locked ? styles.pressed : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={color} testID="button-spinner" />
      ) : icon !== undefined ? (
        <Icon name={icon} size={size === 'compact' ? 16 : 18} color={color} />
      ) : null}
      <Text style={[styles.label, size === 'compact' ? styles.labelCompact : null, { color }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A square button with a single symbol, the same corners as every control. */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  disabled = false,
  active = false,
}: {
  icon: IconName;
  onPress: () => void;
  /** Required: an icon alone says nothing to VoiceOver. */
  accessibilityLabel: string;
  disabled?: boolean;
  active?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected: active }}
      // 40 pt drawn, 44 pt touchable.
      hitSlop={2}
      style={({ pressed }) => [
        styles.icon,
        active ? styles.iconActive : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <View pointerEvents="none">
        <Icon name={icon} size={18} color={active ? theme.colors.action : theme.colors.textMuted} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  large: { minHeight: 48, paddingHorizontal: theme.spacing.lg + theme.spacing.xs },
  // No alignSelf: in a row the parent centers it; in a column, place it in a row
  // to keep it as wide as its label.
  compact: { minHeight: 36, paddingHorizontal: theme.spacing.md + 2 },
  fullWidth: { alignSelf: 'stretch' },
  primary: {
    backgroundColor: tint(theme.colors.action, 'fill'),
    borderColor: tint(theme.colors.action, 'border'),
  },
  secondary: { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border },
  text: { paddingHorizontal: theme.spacing.xs, minHeight: 44 },
  destructive: { borderColor: tint(theme.colors.attention, 'border') },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  label: { ...theme.typography.button },
  labelCompact: { fontSize: 14 * theme.fontScale },
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  iconActive: { borderColor: theme.colors.action },
}));
