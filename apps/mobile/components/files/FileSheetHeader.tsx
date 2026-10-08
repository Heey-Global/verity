import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../Icon';

/** The one header every file screen uses — the list, the selection, an open
 * file and the editor — so a control sits in the same place and looks the same
 * wherever it appears: what leaves or goes back on the left, the title in the
 * middle, actions on the right. Nothing in it has a fill or a frame; a verb is
 * tinted text, everything else a bare glyph, as in an iOS navigation bar. */
export function FileSheetHeader({
  leading,
  title,
  subtitle,
  trailing,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {leading ? <View style={styles.side}>{leading}</View> : null}
      <View style={styles.titleWrap}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.side}>{trailing}</View> : null}
    </View>
  );
}

/** A verb in the header or a bar: "Select", "Edit", "Save". `strong` marks the
 * one action that completes the screen (Done, Save); `destructive` the one that
 * cannot be undone. */
export function HeaderTextButton({
  label,
  onPress,
  emphasis = 'normal',
  disabled = false,
  busy = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  emphasis?: 'normal' | 'strong' | 'destructive';
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme } = useUnistyles();
  const color = emphasis === 'destructive' ? theme.colors.tone.danger : theme.colors.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.textButton,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      <Text
        style={[styles.textLabel, emphasis === 'strong' ? styles.strong : null, { color }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A glyph-only control: back, more, close, versions, add. Never framed, so it
 * never competes with the verbs beside it. */
export function HeaderIconButton({
  icon,
  accessibilityLabel,
  onPress,
  disabled = false,
  busy = false,
  tint = false,
}: {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** The screen's one primary action (the + that adds), drawn in the tint
   * colour like a text verb would be; everything else stays muted. */
  tint?: boolean;
}) {
  const { theme } = useUnistyles();
  const color = tint ? theme.colors.primary : theme.colors.textMuted;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.iconButton,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Icon name={icon} size={22} color={color} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  side: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  subtitle: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    marginTop: 1,
  },
  textButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
  },
  textLabel: {
    fontSize: theme.text.md,
    fontWeight: '500',
  },
  strong: { fontWeight: '700' },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.5 },
  disabled: { opacity: 0.35 },
}));
