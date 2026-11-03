import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { tint } from './tint';

/**
 * A log list (docs/design-system.md § 5.2a): dense records on the screen
 * background, edge to edge, divided by 1 px rules instead of a card.
 */
export function LogList({ children }: { children: ReactNode }) {
  return <View style={styles.list}>{children}</View>;
}

/** One record of a log list: a footnote meta line, the message and optional context. */
export function LogRow({
  time,
  source,
  severity,
  problem = false,
  tag,
  message,
  context,
  onPress,
}: {
  time: string;
  source: string;
  /** The severity word; `problem` shows it in `attention`. */
  severity?: string | undefined;
  problem?: boolean;
  /** A neutral marker for extra content, e.g. captured build output. */
  tag?: string | undefined;
  message: string;
  context?: string | undefined;
  onPress?: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={[message, context, time, source, severity, tag]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={onPress ? 'Opens details' : undefined}
      style={({ pressed }) => [styles.row, pressed && onPress ? styles.pressed : null]}
    >
      <View style={styles.body}>
        <View style={styles.meta}>
          <Text style={[styles.metaText, styles.time]}>{time}</Text>
          <Text style={styles.metaText}>{source}</Text>
          {severity ? (
            <Text style={[styles.severity, problem ? styles.problem : null]}>{severity}</Text>
          ) : null}
          {tag ? (
            <View style={styles.tag}>
              <Text style={styles.tagLabel}>{tag}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.message}>{message}</Text>
        {context ? <Text style={styles.context}>{context}</Text> : null}
      </View>
      {onPress ? <Icon name="chevron-right" size={16} color={theme.colors.textFaint} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    marginHorizontal: -theme.spacing.lg,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    paddingLeft: theme.spacing.lg,
    paddingRight: theme.spacing.md,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  pressed: { backgroundColor: tint(theme.colors.text, 'neutral') },
  body: { flex: 1, minWidth: 0 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.sm },
  metaText: { ...theme.typography.footnote, color: theme.colors.textFaint },
  time: { fontFamily: theme.fonts.mono },
  severity: { ...theme.typography.footnote, color: theme.colors.textMuted },
  problem: { fontFamily: theme.fonts.semibold, color: theme.colors.attention },
  tag: {
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: theme.spacing.xxs,
    borderRadius: theme.radius.tag,
    backgroundColor: tint(theme.colors.text, 'neutral'),
  },
  tagLabel: { ...theme.typography.label, color: theme.colors.textMuted },
  message: {
    ...theme.typography.bodySmall,
    color: theme.colors.text,
    marginTop: theme.spacing.xxs,
  },
  context: { ...theme.typography.subtitle, color: theme.colors.textMuted },
}));
