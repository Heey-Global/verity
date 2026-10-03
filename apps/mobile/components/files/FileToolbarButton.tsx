import { ActivityIndicator, Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';

export type FileToolbarButtonTone = 'plain' | 'tinted' | 'primary' | 'danger';

/** A labelled action in the file browser. The explorer used to offer bare
 * glyphs, and a two-arrow "move" read as "refresh" until it had moved files the
 * operator meant to keep; every action that changes something now says what it
 * does. `label` doubles as the accessibility label unless one is given. */
export function FileToolbarButton({
  label,
  icon,
  tone = 'plain',
  busy = false,
  disabled = false,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  icon?: IconName;
  tone?: FileToolbarButtonTone;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const color =
    tone === 'primary'
      ? theme.colors.onPrimary
      : tone === 'danger'
        ? theme.colors.tone.danger
        : tone === 'tinted'
          ? theme.colors.primary
          : theme.colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.button,
        tone === 'primary' ? styles.primary : null,
        tone === 'danger' ? styles.danger : null,
        tone === 'tinted' ? styles.tinted : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : icon ? (
        <Icon name={icon} size={15} color={color} />
      ) : null}
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  primary: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  danger: {
    borderColor: `${theme.colors.tone.danger}66`,
    backgroundColor: `${theme.colors.tone.danger}1a`,
  },
  tinted: {
    borderColor: `${theme.colors.primary}66`,
    backgroundColor: `${theme.colors.primary}1a`,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  label: {
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
}));
