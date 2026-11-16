import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from './Text';

/** Shared frame for session status and its independent trailing action. */
export function SessionBar({
  children,
  trailing,
  pressed = false,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  pressed?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <View style={[styles.bar, pressed && styles.pressed]}>
        {children}
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
    </View>
  );
}

export function SessionBarTarget({
  children,
  onPress,
  onPressIn,
  onPressOut,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
}: {
  children: ReactNode;
  /** Omitted for a bar that only reports a state: it then is not a button. */
  onPress?: () => void;
  onPressIn?(): void;
  onPressOut?(): void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'link';
}) {
  if (onPress === undefined)
    return (
      <View style={styles.target} accessible accessibilityLabel={accessibilityLabel}>
        {children}
      </View>
    );
  return (
    <Pressable
      style={styles.target}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      {children}
    </Pressable>
  );
}

export function SessionBarContent({
  color,
  busy = false,
  title,
  subtitle,
  children,
}: {
  color: string;
  /** In motion (§ 5.4 `transient`): a muted spinner takes the dot's place. */
  busy?: boolean;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  const { theme } = useUnistyles();
  return (
    <>
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <View style={styles.main}>
        <Text variant="bodySmall" style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text variant="footnote" tone="muted" style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  bar: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: theme.colors.border },
  target: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.sm,
  },
  dot: { width: 9, height: 9, borderRadius: theme.radius.sm },
  main: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontFamily: theme.fonts.bold },
  subtitle: { fontFamily: theme.fonts.semibold },
  trailing: { marginRight: theme.spacing.sm },
}));
