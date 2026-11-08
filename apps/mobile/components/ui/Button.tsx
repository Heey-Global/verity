import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';
import { tint } from './tint';

export type ButtonVariant = 'primary' | 'secondary' | 'answer' | 'text' | 'destructive';
export type ButtonSize = 'large' | 'compact' | 'small';

/**
 * The one button (docs/design-system.md § 5.1). Primary is tonal — a quiet cyan
 * fill, never a glow — and a screen has at most one. Destructive is outlined in
 * `attention` and is only ever the confirming action of a confirmation. Answer
 * is outlined in `action` without the primary's tonal fill: a list row's
 * in-place answer, which has to read as tappable without competing with the
 * screen's one primary.
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
  accessibilityHint,
  role = 'button',
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
  /** What happens when the label alone does not say it ("the starter keeps preparing"). */
  accessibilityHint?: string;
  /** `link` for an action that leaves the app for an external page. */
  role?: 'button' | 'link';
}) {
  const { theme } = useUnistyles();
  const locked = disabled || loading;
  const color =
    variant === 'primary'
      ? theme.colors.actionLabel
      : variant === 'secondary'
        ? theme.colors.text
        : variant === 'text' || variant === 'answer'
          ? theme.colors.action
          : theme.colors.attention;
  return (
    <Pressable
      onPress={onPress}
      disabled={locked}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: locked, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        size === 'compact' ? styles.compact : size === 'small' ? styles.small : styles.large,
        styles[variant],
        fullWidth ? styles.fullWidth : null,
        disabled ? styles.disabled : null,
        pressed && !locked ? styles.pressed : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={color} testID="button-spinner" />
      ) : icon !== undefined ? (
        <Icon name={icon} size={size === 'large' ? 18 : 16} color={color} />
      ) : null}
      <Text
        style={[
          styles.label,
          size === 'compact' ? styles.labelCompact : size === 'small' ? styles.labelSmall : null,
          { color },
        ]}
      >
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
  // An answer under a list row: secondary to the row it belongs to, so it is
  // lighter than a card's compact button and never draws the eye first.
  small: { minHeight: 32, paddingHorizontal: theme.spacing.md },
  fullWidth: { alignSelf: 'stretch' },
  primary: {
    backgroundColor: tint(theme.colors.action, 'fill'),
    borderColor: tint(theme.colors.action, 'border'),
  },
  secondary: { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border },
  answer: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: tint(theme.colors.action, 'border'),
  },
  text: { paddingHorizontal: theme.spacing.xs, minHeight: 44 },
  destructive: { borderColor: tint(theme.colors.attention, 'border') },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  label: { ...theme.typography.button },
  labelCompact: { fontSize: theme.typography.bodySmall.fontSize },
  labelSmall: {
    fontFamily: theme.fonts.semibold,
    fontSize: theme.typography.subtitle.fontSize,
    lineHeight: theme.typography.subtitle.lineHeight,
  },
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
