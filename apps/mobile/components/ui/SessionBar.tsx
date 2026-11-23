import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from './Text';

/** Shared frame for session status and its independent trailing action. */
export function SessionBar({
  children,
  trailing,
  pressed = false,
  inset = false,
  first = false,
  progress,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  pressed?: boolean;
  inset?: boolean;
  first?: boolean;
  progress?: number;
}) {
  const bar = (
    <View
      style={[
        styles.bar,
        inset && (first ? styles.first : styles.inset),
        pressed && styles.pressed,
      ]}
    >
      {children}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {progress !== undefined ? (
        <View
          pointerEvents="none"
          style={[styles.progress, { width: `${Math.max(0, Math.min(1, progress)) * 100}%` }]}
        />
      ) : null}
    </View>
  );
  return inset ? bar : <View style={styles.wrap}>{bar}</View>;
}

export function SessionBarStack({
  children,
  collapsed,
}: {
  children: ReactNode;
  collapsed: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.stack}>{children}</View>
      {collapsed ? (
        <>
          <View style={[styles.edge, styles.firstEdge]} />
          <View style={[styles.edge, styles.lastEdge]} />
        </>
      ) : null}
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
  expanded,
}: {
  children: ReactNode;
  /** Omitted for a bar that only reports a state: it then is not a button. */
  onPress?: () => void;
  onPressIn?(): void;
  onPressOut?(): void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'link';
  expanded?: boolean;
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
      accessibilityState={expanded === undefined ? undefined : { expanded }}
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
  subtitle: ReactNode;
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
  stack: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  edge: {
    height: 5,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomLeftRadius: theme.radius.md,
    borderBottomRightRadius: theme.radius.md,
  },
  firstEdge: { marginHorizontal: theme.spacing.sm, opacity: 0.8 },
  lastEdge: { marginHorizontal: theme.spacing.lg, opacity: 0.55 },
  first: { borderWidth: 0, borderRadius: 0 },
  inset: { borderWidth: 0, borderTopWidth: 1, borderRadius: 0 },
  progress: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: 2,
    backgroundColor: theme.colors.textFaint,
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
